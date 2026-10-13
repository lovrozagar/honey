import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { ipRestrict } from "../../../src/ip-restrict.ts"
import { setPeerAddress } from "../../../src/peer.ts"
import "../../../src/trust.ts"
import type { TrustProxy } from "../../../src/trust.ts"

function makeApp(opts: Parameters<typeof ipRestrict>[0], trust: TrustProxy = false) {
	const app = honey<{}>().trustProxy(trust).use(ipRestrict(opts))
	app.get("/admin").handler((ctx) => ctx.res.json("ok", { access: true }))
	return app
}

/** A request whose TCP peer is `peer`, as an adapter would register it. */
function fromPeer(peer: string, headers: Record<string, string> = {}) {
	const req = new Request("http://localhost/admin", { headers })
	setPeerAddress(req, peer)
	return req
}

describe("ipRestrict — client address", () => {
	it("uses the peer address when no proxy is trusted", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"] })
		expect((await app.fetch(fromPeer("10.0.0.1"), {})).status).toBe(200)
		expect((await app.fetch(fromPeer("192.168.1.1"), {})).status).toBe(403)
	})

	it("ignores every forwarding header when no proxy is trusted", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"] })
		for (const header of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded"]) {
			const res = await app.fetch(fromPeer("203.0.113.9", { [header]: "10.0.0.1" }), {})
			expect(res.status).toBe(403)
		}
	})

	it("trustProxy(1): the X-Forwarded-For entry the proxy appended, never one the client sent", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"] }, 1)
		const spoofed = await app.fetch(fromPeer("172.16.0.2", { "x-forwarded-for": "10.0.0.1, 203.0.113.9" }), {})
		expect(spoofed.status).toBe(403)
		const real = await app.fetch(fromPeer("172.16.0.2", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), {})
		expect(real.status).toBe(200)
	})

	it("trustProxy(ranges): skips trusted hops, takes the first untrusted address", async () => {
		const app = makeApp({ allowList: ["198.51.100.7"] }, ["10.0.0.0/8"])
		/* client → 10.1.1.1 (trusted) → 10.2.2.2 (peer, trusted) → app */
		const ok = await app.fetch(fromPeer("10.2.2.2", { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.1.1.1" }), {})
		expect(ok.status).toBe(200)
		/* a peer outside the ranges is the client itself; its headers are ignored */
		const direct = await app.fetch(fromPeer("203.0.113.1", { "x-forwarded-for": "198.51.100.7" }), {})
		expect(direct.status).toBe(403)
	})

	it("custom getIp replaces ctx.ip", async () => {
		const app = makeApp({ allowList: ["1.2.3.4"], getIp: (req) => req.headers.get("x-test-ip") })
		const res = await app.fetch(fromPeer("9.9.9.9", { "x-test-ip": "1.2.3.4" }), {})
		expect(res.status).toBe(200)
	})
})

describe("ipRestrict — fails closed", () => {
	it("unknown address with an allow list → 403", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"] })
		expect((await app.fetch(new Request("http://localhost/admin"), {})).status).toBe(403)
	})

	it("unknown address with a deny-only list → 403", async () => {
		const app = makeApp({ denyList: ["10.0.0.1"] })
		expect((await app.fetch(new Request("http://localhost/admin"), {})).status).toBe(403)
	})

	it("garbage at the trusted X-Forwarded-For position → 403, even deny-only", async () => {
		const app = makeApp({ denyList: ["10.0.0.0/8"] }, 1)
		const res = await app.fetch(fromPeer("172.16.0.2", { "x-forwarded-for": "10.0.0.1abc" }), {})
		expect(res.status).toBe(403)
	})
})

describe("ipRestrict — canonical comparison", () => {
	it("an IPv4-mapped IPv6 peer matches IPv4 rules, and the reverse", async () => {
		expect((await makeApp({ denyList: ["203.0.113.7"] }).fetch(fromPeer("::ffff:203.0.113.7"), {})).status).toBe(403)
		expect((await makeApp({ allowList: ["::ffff:10.0.0.0/120"] }).fetch(fromPeer("10.0.0.9"), {})).status).toBe(200)
	})

	it("IPv6 case and zero compression do not matter", async () => {
		const app = makeApp({ denyList: ["2001:DB8::1"] })
		expect((await app.fetch(fromPeer("2001:db8:0:0:0:0:0:1"), {})).status).toBe(403)
	})

	it("a port or zone on the address is dropped", async () => {
		expect(
			(
				await makeApp({ denyList: ["203.0.113.7"] }, 1).fetch(
					fromPeer("10.0.0.1", { "x-forwarded-for": "203.0.113.7:51234" }),
					{},
				)
			).status,
		).toBe(403)
		expect(
			(await makeApp({ denyList: ["::1"] }, 1).fetch(fromPeer("10.0.0.1", { "x-forwarded-for": "[::1]:443" }), {}))
				.status,
		).toBe(403)
		expect((await makeApp({ denyList: ["fe80::1"] }).fetch(fromPeer("fe80::1%eth0"), {})).status).toBe(403)
	})

	it("CIDR ranges, IPv4 and IPv6", async () => {
		const v4 = makeApp({ allowList: ["172.16.0.0/16"] })
		expect((await v4.fetch(fromPeer("172.16.255.1"), {})).status).toBe(200)
		expect((await v4.fetch(fromPeer("172.17.0.1"), {})).status).toBe(403)
		const v6 = makeApp({ allowList: ["fe80::/10"] })
		expect((await v6.fetch(fromPeer("fe80::1"), {})).status).toBe(200)
		expect((await v6.fetch(fromPeer("fd00::1"), {})).status).toBe(403)
		const one = makeApp({ allowList: ["10.0.0.5/32"] })
		expect((await one.fetch(fromPeer("10.0.0.5"), {})).status).toBe(200)
		expect((await one.fetch(fromPeer("10.0.0.6"), {})).status).toBe(403)
	})

	it("0.0.0.0/0 allows every IPv4 address", async () => {
		const app = makeApp({ allowList: ["0.0.0.0/0"] })
		expect((await app.fetch(fromPeer("255.255.255.255"), {})).status).toBe(200)
	})

	it("a trailing garbage suffix is not an address", async () => {
		const app = makeApp({ allowList: ["10.0.0.0/8"] })
		expect((await app.fetch(fromPeer("10.0.0.1abc"), {})).status).toBe(403)
	})
})

describe("ipRestrict — construction", () => {
	it("rejects invalid rules", () => {
		for (const rule of [
			"10.0.0.0/33",
			"256.0.0.0/8",
			"abc",
			"10.0.0/24",
			"not-valid-ipv6/64",
			"::1/129",
			"010.0.0.1",
		]) {
			expect(() => ipRestrict({ allowList: [rule] }), rule).toThrow(/not an IP address or CIDR range/)
			expect(() => ipRestrict({ denyList: [rule] }), rule).toThrow(/not an IP address or CIDR range/)
		}
	})

	it("rejects an empty allow list and a config with no lists", () => {
		expect(() => ipRestrict({ allowList: [] })).toThrow(/would reject every request/)
		expect(() => ipRestrict({})).toThrow(/non-empty/)
	})

	it("points the old per-middleware trust options at the app setting", () => {
		expect(() => ipRestrict({ allowList: ["10.0.0.1"], trustProxy: true } as never)).toThrow(/app.trustProxy/)
		expect(() => ipRestrict({ allowList: ["10.0.0.1"], trustCloudflare: true } as never)).toThrow(/app.trustProxy/)
	})
})

describe("ipRestrict — consumer", () => {
	it("admin route blocked from public IP with error_key forbidden", async () => {
		const app = makeApp({ allowList: ["10.0.0.0/8"] })
		const res = await app.fetch(fromPeer("203.0.113.50"), {})
		expect(res.status).toBe(403)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("forbidden")
	})

	it("webhook endpoint accepts a known range behind one proxy", async () => {
		const app = makeApp({ allowList: ["54.187.174.0/24", "54.187.205.0/24"] }, 1)
		const res = await app.fetch(fromPeer("10.0.0.2", { "x-forwarded-for": "54.187.174.100" }), {})
		expect(res.status).toBe(200)
	})
})
