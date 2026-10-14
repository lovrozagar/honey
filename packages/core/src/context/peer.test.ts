import { afterEach, describe, expect, it, vi } from "vitest"
import { canonicalIp, ipOf, PEER_ADDRESS, peerAddressOf } from "./peer.ts"

/** A request reporting `peer` the way the Node adapter's request does. */
function fromPeer(peer: string | null, headers: Record<string, string> = {}): Request {
	const req = new Request("http://app.internal/who", { headers })
	Object.defineProperty(req, PEER_ADDRESS, { value: peer })
	return req
}

describe("canonicalIp: one spelling per address, whichever runtime reported it", () => {
	// v0: 233e78e660
	// v0: 472258ccb7
	it.each([
		["203.0.113.7", "203.0.113.7"],
		["::ffff:203.0.113.7", "203.0.113.7"],
		["[::ffff:203.0.113.7]:80", "203.0.113.7"],
		["203.0.113.7:51234", "203.0.113.7"],
		["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
		["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
		["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
		["[2001:db8::1]:8443", "2001:db8::1"],
		["fe80::1%eth0", "fe80::1"],
		["64:ff9b::192.0.2.33", "64:ff9b::c000:221"],
		["::", "::"],
		["::1", "::1"],
		["1::", "1::"],
		[" 10.0.0.1 ", "10.0.0.1"],
	])("%j is %j", (text, canonical) => {
		expect(canonicalIp(text)).toBe(canonical)
	})

	it.each([
		"010.0.0.1",
		"256.0.0.1",
		"1.2.3",
		"0x7f.0.0.1",
		"1:2:3:4:5:6:7:8:9",
		"1::2::3",
		"1::g",
		"1:2:3:4::5:6:7:8",
		"12345::1",
		"1:2:3:4:5:6:7",
		"g::1",
		"::1.2.3",
		"[2001:db8::1",
		"[::1]x",
		"1.2.3.4:http",
		"1.2.3.4%eth0",
		"not-an-ip",
		"",
	])("%j is not one address: null, never a guess", (text) => {
		expect(canonicalIp(text)).toBeNull()
	})
})

describe("peerAddressOf: where the runtime reports the peer", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("reads the address a Node adapter set on the request, an empty one being none", () => {
		expect(peerAddressOf(fromPeer("203.0.113.7"), {})).toBe("203.0.113.7")
		expect(peerAddressOf(fromPeer(""), {})).toBeNull()
		expect(peerAddressOf(fromPeer(null), {})).toBeNull()
	})

	it("asks a Bun server passed as the env, or as env.server, and treats a failing ask as none", () => {
		const server = { requestIP: () => ({ address: "::ffff:192.0.2.1" }) }
		const req = new Request("http://h/who")
		expect(peerAddressOf(req, server)).toBe("::ffff:192.0.2.1")
		expect(peerAddressOf(req, { server })).toBe("::ffff:192.0.2.1")
		expect(peerAddressOf(req, { requestIP: () => null })).toBeNull()
		const closed = {
			requestIP: () => {
				throw new Error("closed")
			},
		}
		expect(peerAddressOf(req, closed)).toBeNull()
	})

	it("reads CF-Connecting-IP only on Workers, where the edge sets it and a client cannot", () => {
		const req = new Request("http://h/who", { headers: { "cf-connecting-ip": "198.51.100.4" } })
		expect(peerAddressOf(req, {})).toBeNull()
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
		expect(peerAddressOf(req, {})).toBe("198.51.100.4")
		expect(peerAddressOf(new Request("http://h/who"), {})).toBeNull()
	})

	it("is null with no peer source, whatever the env is", () => {
		const req = new Request("http://h/who")
		for (const env of [undefined, null, {}, "text", { server: {} }]) expect(peerAddressOf(req, env)).toBeNull()
	})
})

describe("ipOf: the request's ctx.ip, resolved once", () => {
	it("is the canonical peer, read from the runtime once and kept on the request state", () => {
		const req = new Request("http://app.internal/who")
		let reads = 0
		Object.defineProperty(req, PEER_ADDRESS, {
			get: () => {
				reads++
				return "::ffff:203.0.113.7"
			},
		})
		const state: { env: unknown; ip?: string | null; req: Request } = { env: {}, req }
		for (let i = 0; i < 3; i++) expect(ipOf(state)).toBe("203.0.113.7")
		expect([state.ip, reads]).toEqual(["203.0.113.7", 1])
	})

	it("is null when no runtime reports a peer, or reports one that is not an address", () => {
		expect(ipOf({ env: {}, req: new Request("http://h/") })).toBeNull()
		expect(ipOf({ env: {}, req: fromPeer("garbage") })).toBeNull()
	})
})
