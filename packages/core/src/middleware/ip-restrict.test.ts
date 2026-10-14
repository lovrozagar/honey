import { describe, expect, it } from "vitest"
import { PEER_ADDRESS } from "../context/peer.ts"
import { honey } from "../routing/app.ts"
import { ipRestrict, type IpRestrictOptions } from "./ip-restrict.ts"

function app(options: IpRestrictOptions) {
	const a = honey<{}>()
	a.use(ipRestrict(options))
		.get("/admin")
		.handler((ctx) => ctx.res.json("ok", { access: true }))
	return a
}

/** A request whose peer the runtime reports as `peer`, as the Node adapter does; none when omitted. */
function fromPeer(peer?: string, headers: Record<string, string> = {}): Request {
	const req = new Request("http://localhost/admin", { headers })
	if (peer !== undefined) Object.defineProperty(req, PEER_ADDRESS, { value: peer })
	return req
}

const statusOf = async (options: IpRestrictOptions, peer?: string, headers?: Record<string, string>) =>
	(await app(options).fetch(fromPeer(peer, headers), {})).status

describe("ipRestrict(): the allow list", () => {
	// v0: 4894ef810a
	it("a peer outside it is 403 forbidden", async () => {
		const res = await app({ allowList: ["10.0.0.0/8"] }).fetch(fromPeer("203.0.113.50"), {})
		expect([res.status, ((await res.json()) as { error_key: string }).error_key]).toEqual([403, "forbidden"])
	})

	// v0: 00cb3f463e
	// v0: 7afabfda4e
	// v0: dc291495fd
	// v0: 57f303a66a
	// v0: 4aff2d77bd
	// v0: a865b31aab
	it.each([
		["172.16.0.0/16", "172.16.255.1", 200],
		["172.16.0.0/16", "172.17.0.1", 403],
		["10.0.0.0/8", "10.255.255.255", 200],
		["10.0.0.0/8", "11.0.0.1", 403],
		["10.0.0.5/32", "10.0.0.5", 200],
		["10.0.0.5/32", "10.0.0.6", 403],
		["10.0.0.5", "10.0.0.5", 200],
		["0.0.0.0", "0.0.0.0", 200],
		["fe80::/10", "fe80::1", 200],
		["fe80::/10", "fd00::1", 403],
		["2001:db8::/32", "2001:db8:ffff::1", 200],
	])("rule %s, peer %s: %i", async (rule, peer, status) => {
		expect(await statusOf({ allowList: [rule] }, peer)).toBe(status)
	})

	// v0: 2cda074b1c
	// v0: f0cbccdbf2
	it("0.0.0.0/0 allows every IPv4 address, and no IPv6 one", async () => {
		const options = { allowList: ["0.0.0.0/0"] }
		expect([
			await statusOf(options, "255.255.255.255"),
			await statusOf(options, "1.2.3.4"),
			await statusOf(options, "::1"),
		]).toEqual([200, 200, 403])
	})
})

describe("ipRestrict(): the deny list", () => {
	// v0: c1f91aeb36
	// v0: 106ade80c6
	// v0: 621b0270da
	it("a listed peer is 403; any other passes", async () => {
		const options = { denyList: ["10.0.0.1", "255.255.255.255"] }
		expect([
			await statusOf(options, "10.0.0.1"),
			await statusOf(options, "255.255.255.255"),
			await statusOf(options, "10.0.0.2"),
		]).toEqual([403, 403, 200])
	})

	it("is checked first: a peer on both lists is refused", async () => {
		expect(await statusOf({ allowList: ["10.0.0.0/8"], denyList: ["10.6.6.6"] }, "10.6.6.6")).toBe(403)
	})
})

describe("ipRestrict(): the address is ctx.ip, the platform peer", () => {
	// v0: 5bd7eb84e9
	// v0: 2e696ae03d
	// v0: 57d318b56c
	it("no forwarding header a client sends can stand in for the peer", async () => {
		const statuses = []
		for (const header of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "forwarded"]) {
			const value = header === "forwarded" ? "for=10.0.0.1" : "10.0.0.1"
			statuses.push(await statusOf({ allowList: ["10.0.0.1"] }, "203.0.113.9", { [header]: value }))
		}
		expect(statuses).toEqual([403, 403, 403, 403, 403])
	})
})

describe("ipRestrict(): fails closed", () => {
	// v0: 62496e8795
	// v0: 61927a174a
	// v0: b469c1615b
	it("no peer reported: 403 under an allow list and under a deny-only list", async () => {
		expect([await statusOf({ allowList: ["10.0.0.1"] }), await statusOf({ denyList: ["10.0.0.1"] })]).toEqual([
			403, 403,
		])
	})

	// v0: 7ff10557cc
	// v0: 810736bc11
	it.each(["10.0.0.1abc", "garbage", "010.0.0.1", "0x0a.0.0.1", "10.0.1", "167772161"])(
		"a peer that is not one address (%s): 403, even deny-only",
		async (peer) => {
			expect([
				await statusOf({ allowList: ["10.0.0.0/8"] }, peer),
				await statusOf({ denyList: ["203.0.113.0/24"] }, peer),
			]).toEqual([403, 403])
		},
	)
})

describe("ipRestrict(): one address, however it is spelled", () => {
	// v0: f43649ec1b
	// v0: b2899e9fb5
	// v0: fc2c9b867b
	it.each([
		["203.0.113.9", "::ffff:203.0.113.9"],
		["203.0.113.9", "::FFFF:cb00:7109"],
		["203.0.113.9", "203.0.113.9:4444"],
		["203.0.113.9", "[::ffff:203.0.113.9]:4444"],
		["::1", "[::1]:443"],
		["fe80::1", "fe80::1%eth0"],
	])("a deny rule %s matches the peer %s", async (rule, peer) => {
		expect(await statusOf({ denyList: [rule] }, peer)).toBe(403)
	})

	// v0: df89a2d598
	it.each([
		["2001:DB8::1", "2001:db8:0:0:0:0:0:1"],
		["2001:0db8:0:0::1", "2001:db8::1"],
		["2001:db8::1", "2001:DB8::1"],
	])("IPv6 case and zero compression do not matter: rule %s, peer %s", async (rule, peer) => {
		expect(await statusOf({ denyList: [rule] }, peer)).toBe(403)
	})

	// v0: 3fe5b021fd
	it("an IPv4-mapped rule of /96 or longer is the IPv4 range it maps", async () => {
		expect([
			await statusOf({ allowList: ["::ffff:10.0.0.0/120"] }, "10.0.0.9"),
			await statusOf({ allowList: ["::ffff:10.0.0.0/120"] }, "10.0.1.9"),
		]).toEqual([200, 403])
	})

	it("a shorter IPv4-mapped rule stays an IPv6 range, which no IPv4 peer is in", async () => {
		expect(await statusOf({ allowList: ["::ffff:0:0/80"] }, "10.0.0.9")).toBe(403)
	})
})

describe("ipRestrict(): construction", () => {
	// v0: 47c343b4df
	// v0: a0a2516608
	// v0: 4dc9286672
	// v0: 2c956b585d
	it.each([
		"10.0.0.0/33",
		"256.0.0.0/8",
		"abc",
		"10.0.0/24",
		"not-valid-ipv6/64",
		"::1/129",
		"010.0.0.1",
		"10.0.0.1/",
		"10.0.0.1/-1",
		"[::1]",
		"fe80::1%eth0",
		"10.0.0.1:80",
	])("refuses the rule %s on either list", (rule) => {
		const message = (list: string) =>
			`ipRestrict: ${list} entry ${JSON.stringify(rule)} is not an IP address or CIDR range`
		expect(() => ipRestrict({ allowList: [rule] })).toThrow(message("allowList"))
		expect(() => ipRestrict({ denyList: [rule] })).toThrow(message("denyList"))
	})

	// v0: 4b2939ac58
	// v0: e054348f87
	it("refuses an empty allow list (it would refuse everyone) and no lists at all", () => {
		expect(() => ipRestrict({ allowList: [] })).toThrow("ipRestrict: `allowList: []` would refuse every request")
		expect(() => ipRestrict({})).toThrow("ipRestrict: pass a non-empty `allowList` or `denyList`")
		expect(() => ipRestrict({ denyList: [] })).toThrow("ipRestrict: pass a non-empty `allowList` or `denyList`")
	})

	it("declares the error it answers with", () => {
		expect(ipRestrict({ denyList: ["10.0.0.1"] }).errors).toEqual(["forbidden"])
	})
})
