import { afterEach, describe, expect, it, vi } from "vitest"
import { directClientInfo, isValidHost, PEER_ADDRESS, peerAddressOf, resolveClient, TRUST_OFF } from "./client-info.ts"
import { compileTrust, type TrustProxy } from "./trust.ts"

/** A request reporting `peer` the way the Node adapter's request does. */
function fromPeer(peer: string | null, url = "http://app.internal:3000/who", headers: Record<string, string> = {}) {
	const req = new Request(url, { headers })
	Object.defineProperty(req, PEER_ADDRESS, { value: peer })
	return req
}

describe("directClientInfo: the client as the connection shows it", () => {
	it("is the canonical peer, the URL's host and the transport's scheme, and trusts nothing forwarded", () => {
		const headers = { "x-forwarded-for": "1.1.1.1", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }
		expect(directClientInfo(fromPeer(null, undefined, headers), "::ffff:203.0.113.7")).toEqual({
			host: "app.internal:3000",
			ip: "203.0.113.7",
			protocol: "http",
			trustsForwarded: false,
		})
		expect(directClientInfo(new Request("https://secure.example/x"), null)).toEqual({
			host: "secure.example",
			ip: null,
			protocol: "https",
			trustsForwarded: false,
		})
	})

	it("has no host when the URL has no authority", () => {
		expect(directClientInfo(new Request("file:///srv/app"), null).host).toBeNull()
	})

	it("is what resolveClient answers when trust is off", () => {
		const req = fromPeer("10.0.0.1", undefined, { "x-forwarded-for": "1.1.1.1" })
		expect(resolveClient(TRUST_OFF, req, "10.0.0.1")).toEqual(directClientInfo(req, "10.0.0.1"))
	})
})

describe("isValidHost: host[:port] as Host allows it", () => {
	it.each([
		"example.com",
		"example.com.",
		"api.example.com:8443",
		"localhost",
		"203.0.113.7:80",
		"[2001:db8::1]",
		"[::1]:3000",
		"a-b.c",
	])("%j is a host", (host) => {
		expect(isValidHost(host)).toBe(true)
	})

	it.each([
		"a/b",
		"a?b",
		"user@example.com",
		"example.com:99999",
		"-lead.example",
		"trail-.example",
		"exa mple.com",
		"",
		"[::1",
		"[::1]x",
		"[203.0.113.7]",
		"[::1]:http",
		"a:b:c",
	])("%j is not: nothing that could change a URL's meaning", (host) => {
		expect(isValidHost(host)).toBe(false)
	})
})

describe("peerAddressOf: where the runtime reports the peer", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("reads the address an adapter set on the request, an empty one being none", () => {
		expect(peerAddressOf(fromPeer("203.0.113.7"), {})).toBe("203.0.113.7")
		expect(peerAddressOf(fromPeer(""), {})).toBeNull()
		expect(peerAddressOf(fromPeer(null), {})).toBeNull()
	})

	it("asks a Bun server passed as the env, or as env.server, and treats a failing ask as none", () => {
		const server = { requestIP: () => ({ address: "::ffff:192.0.2.1", family: "IPv6", port: 1 }) }
		const req = new Request("http://h/who")
		expect(peerAddressOf(req, server)).toBe("::ffff:192.0.2.1")
		expect(peerAddressOf(req, { server })).toBe("::ffff:192.0.2.1")
		expect(peerAddressOf(req, { requestIP: () => null })).toBeNull()
		expect(
			peerAddressOf(req, {
				requestIP: () => {
					throw new Error("closed")
				},
			}),
		).toBeNull()
	})

	it("reads CF-Connecting-IP only on Workers, where the edge sets it and a client cannot", () => {
		const req = new Request("http://h/who", { headers: { "cf-connecting-ip": "198.51.100.4" } })
		expect(peerAddressOf(req, {})).toBeNull()
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
		expect(peerAddressOf(req, {})).toBe("198.51.100.4")
		expect(peerAddressOf(new Request("http://h/who"), {})).toBeNull()
	})

	it("is null with no peer source at all, whatever the env is", () => {
		const req = new Request("http://h/who")
		for (const env of [undefined, null, {}, "text", { server: {} }]) expect(peerAddressOf(req, env)).toBeNull()
	})
})

type ForwardedRow = {
	headers: Record<string, string>
	label: string
	peer: string | null
	trust: TrustProxy
	trusts: boolean
}

const XFF = { "x-forwarded-for": "1.1.1.1" }

describe("trustsForwarded: whether a trusted proxy's X-Forwarded-For entry is the client (H18.4)", () => {
	it.each<ForwardedRow>([
		{ headers: XFF, label: "off, whatever is sent", peer: "10.0.0.1", trust: false, trusts: false },
		{
			headers: XFF,
			label: "a range whose peer is outside it",
			peer: "203.0.113.1",
			trust: ["10.0.0.0/8"],
			trusts: false,
		},
		{
			headers: {},
			label: "a range whose trusted peer sent no X-Forwarded-For",
			peer: "10.0.0.1",
			trust: ["10.0.0.0/8"],
			trusts: false,
		},
		{
			headers: XFF,
			label: "a range whose trusted peer forwarded one",
			peer: "10.0.0.1",
			trust: ["10.0.0.0/8"],
			trusts: true,
		},
		{
			headers: {},
			label: "one hop with no X-Forwarded-For: the peer stands in",
			peer: "10.0.0.1",
			trust: 1,
			trusts: false,
		},
		{ headers: XFF, label: "one hop with one entry", peer: "10.0.0.1", trust: 1, trusts: true },
		{
			headers: XFF,
			label: "five hops with one entry: the leftmost, still forwarded",
			peer: "10.0.0.1",
			trust: 5,
			trusts: true,
		},
		{
			headers: { "x-forwarded-for": "garbage" },
			label: "one hop reading garbage",
			peer: "10.0.0.1",
			trust: 1,
			trusts: false,
		},
	])("$label: $trusts", ({ headers, peer, trust, trusts }) => {
		expect(resolveClient(compileTrust(trust), fromPeer(peer, undefined, headers), peer).trustsForwarded).toBe(trusts)
	})
})
