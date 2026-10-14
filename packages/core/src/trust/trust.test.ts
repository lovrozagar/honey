import { describe, expect, it } from "vitest"
import { PEER_ADDRESS, resolveClient } from "./client-info.ts"
import { compileTrust, type TrustProxy } from "./trust.ts"

/** The client `trust` resolves for a request from `peer` carrying `headers`. */
function clientOf(trust: TrustProxy, peer: string | null, headers: Record<string, string> = {}) {
	const req = new Request("http://app.internal:3000/who", { headers })
	Object.defineProperty(req, PEER_ADDRESS, { value: peer })
	return resolveClient(compileTrust(trust), req, peer)
}

describe("compileTrust: the setting, checked when it is made", () => {
	it("false and 0 are off", () => {
		expect(compileTrust(false)).toEqual({ kind: "off" })
		expect(compileTrust(0)).toEqual({ kind: "off" })
	})

	it.each<[TrustProxy, string]>([
		[-1, "trustProxy: a hop count must be a non-negative integer, got -1"],
		[1.5, "trustProxy: a hop count must be a non-negative integer, got 1.5"],
		[Number.NaN, "trustProxy: a hop count must be a non-negative integer, got NaN"],
		[[], "trustProxy: pass false, a hop count, or a non-empty list of proxy addresses and CIDR ranges"],
		[["10.0.0.0/33"], 'trustProxy: "10.0.0.0/33" is not an IP address or CIDR range'],
		[["10.0.0.0/8", "nope"], 'trustProxy: "nope" is not an IP address or CIDR range'],
		[[42 as never], "trustProxy: 42 is not an IP address or CIDR range"],
		[true as never, "trustProxy: pass false, a hop count, or a non-empty list of proxy addresses and CIDR ranges"],
	])("%j is refused: %s", (value, message) => {
		expect(() => compileTrust(value)).toThrow(message)
	})
})

describe("a hop count", () => {
	const xff = { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.9" }

	it.each([
		[1, "10.0.0.9"],
		[2, "198.51.100.7"],
		[3, "6.6.6.6"],
		[5, "6.6.6.6"],
	])("%i reads the entry that many from the right, the leftmost when the list is shorter", (hops, ip) => {
		expect(clientOf(hops, "10.0.0.1", xff)).toMatchObject({ ip, trustsForwarded: true })
	})

	it("with no X-Forwarded-For is the peer, and nothing was forwarded", () => {
		expect(clientOf(1, "203.0.113.1")).toEqual({
			host: "app.internal:3000",
			ip: "203.0.113.1",
			protocol: "http",
			trustsForwarded: false,
		})
	})

	it("reads entries across header lines, and never one the client wrote left of the trusted ones", () => {
		expect(clientOf(1, "10.0.0.1", { "x-forwarded-for": "1.1.1.1, 2.2.2.2,, 203.0.113.9" })).toMatchObject({
			ip: "203.0.113.9",
		})
		const req = new Request("http://h/who")
		req.headers.append("x-forwarded-for", "6.6.6.6")
		req.headers.append("x-forwarded-for", "198.51.100.7")
		expect(resolveClient(compileTrust(1), req, "10.0.0.1").ip).toBe("198.51.100.7")
	})
})

describe("a list of trusted proxies", () => {
	const trust = ["10.0.0.0/8", "fd00::/8"]

	it.each([
		["10.0.0.1", "6.6.6.6, 198.51.100.7, fd00::5, 10.1.1.1", "198.51.100.7", true],
		["10.0.0.1", "10.9.9.9, 10.1.1.1", "10.9.9.9", true],
		["203.0.113.1", "6.6.6.6, 10.1.1.1", "203.0.113.1", false],
		["10.0.0.1", "", "10.0.0.1", false],
	])("from %s with X-Forwarded-For %j, the client is %s (forwarded: %s)", (peer, header, ip, trustsForwarded) => {
		const headers: Record<string, string> = header === "" ? {} : { "x-forwarded-for": header }
		expect(clientOf(trust, peer, headers)).toMatchObject({ ip, trustsForwarded })
	})

	it("trusts nothing without a peer", () => {
		expect(clientOf(trust, null, { "x-forwarded-for": "1.1.1.1" })).toMatchObject({ ip: null, trustsForwarded: false })
	})
})

describe("garbage at the position the setting reads", () => {
	it.each<[TrustProxy, string]>([
		[1, "1.1.1.1, not-an-ip"],
		[["10.0.0.0/8"], "1.1.1.1, bogus, 10.1.1.1"],
	])("%j over %j is null, not a guess", (trust, header) => {
		expect(clientOf(trust, "10.0.0.1", { "x-forwarded-for": header })).toMatchObject({
			ip: null,
			trustsForwarded: false,
		})
	})
})

describe("scheme and host", () => {
	const forwarded = { "x-forwarded-host": "api.example.com", "x-forwarded-proto": "https" }

	it("come from forwarding headers through a trusted hop", () => {
		expect(clientOf(1, "10.0.0.1", forwarded)).toMatchObject({ host: "api.example.com", protocol: "https" })
		expect(clientOf(1, "10.0.0.1", { "x-forwarded-proto": "HTTPS" })).toMatchObject({ protocol: "https" })
	})

	it("come from the transport through an untrusted peer, or when the forwarded value is invalid", () => {
		const direct = { host: "app.internal:3000", protocol: "http" }
		expect(clientOf(["10.0.0.0/8"], "203.0.113.1", forwarded)).toMatchObject(direct)
		expect(clientOf(1, "10.0.0.1", { "x-forwarded-host": "a/b", "x-forwarded-proto": "gopher" })).toMatchObject(direct)
		expect(clientOf(1, "10.0.0.1", { "x-forwarded-host": "evil.example:99999" })).toMatchObject(direct)
	})
})
