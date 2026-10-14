import { describe, expect, it } from "vitest"
import { canonicalIp, formatIp, ipInRange, parseIp, parseIpRange } from "./ip.ts"

describe("parseIp: IPv4", () => {
	it.each([
		["203.0.113.7", 0xcb007107],
		["0.0.0.0", 0],
		["255.255.255.255", 0xffffffff],
		[" 10.0.0.1 ", 0x0a000001],
	])("%j is the address %i", (text, n) => {
		expect(parseIp(text)).toEqual({ n, v: 4 })
	})

	it.each(["010.0.0.1", "256.0.0.1", "1.2.3", "1.2.3.4.5", "1..2.3", "1.2.3.-4", "0x7f.0.0.1", "1.2.3.4 5", ""])(
		"%j is not an address: no leading zeros, octets in range, exactly four",
		(text) => {
			expect(parseIp(text)).toBeNull()
		},
	)
})

describe("parseIp: IPv6", () => {
	it.each([
		["2001:db8::1", 0x20010db8000000000000000000000001n],
		["2001:DB8:0:0:0:0:0:1", 0x20010db8000000000000000000000001n],
		["::", 0n],
		["::1", 1n],
		["1::", 0x00010000000000000000000000000000n],
		["64:ff9b::192.0.2.33", 0x0064ff9b0000000000000000c0000221n],
	])("%j is the address %s", (text, n) => {
		expect(parseIp(text)).toEqual({ n, v: 6 })
	})

	it.each([
		"1:2:3:4:5:6:7:8:9",
		"1::2::3",
		"12345::1",
		"1:2:3:4:5:6:7",
		"g::1",
		"::1.2.3",
		"1:2:3:4:5:6:7::8:9",
		":::1",
	])("%j is not an address", (text) => {
		expect(parseIp(text)).toBeNull()
	})
})

describe("parseIp: the forms a peer or a forwarding header writes", () => {
	it.each([
		["[2001:db8::1]", "2001:db8::1"],
		["[2001:db8::1]:8443", "2001:db8::1"],
		["203.0.113.7:51234", "203.0.113.7"],
		["fe80::1%eth0", "fe80::1"],
		["::ffff:203.0.113.7", "203.0.113.7"],
		["[::ffff:203.0.113.7]:80", "203.0.113.7"],
	])("%j is %j: brackets, a port and a zone dropped, an IPv4-mapped address is the IPv4 one", (text, canonical) => {
		expect(canonicalIp(text)).toBe(canonical)
	})

	it.each(["[2001:db8::1", "[::1]x", "[::1]:123456", "1.2.3.4:http", "1.2.3.4%eth0", "1.2.3.4:5:6"])(
		"%j is not an address",
		(text) => {
			expect(parseIp(text)).toBeNull()
		},
	)
})

describe("formatIp and canonicalIp", () => {
	it.each([
		["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
		["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
		["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
		["0:0:0:0:0:0:0:0", "::"],
		["1:0:0:0:0:0:0:0", "1::"],
		["127.0.0.1", "127.0.0.1"],
	])("%j is written %j: lowercase, the longest zero run compressed, a single zero group kept", (text, canonical) => {
		expect(canonicalIp(text)).toBe(canonical)
		const parsed = parseIp(text)
		expect(parsed !== null && formatIp(parsed)).toBe(canonical)
	})

	it("is null for text that is not an address", () => {
		expect(canonicalIp("not-an-ip")).toBeNull()
	})
})

/** Whether `address` is in the range `rule`, both parsed; a fixture that does not parse throws. */
const inRange = (address: string, rule: string) => {
	const addr = parseIp(address)
	const range = parseIpRange(rule)
	if (addr === null || range === null) throw new Error(`bad fixture ${address} ${rule}`)
	return ipInRange(addr, range)
}

describe("parseIpRange and ipInRange", () => {
	it.each([
		["10.1.2.3", "10.0.0.0/8", true],
		["11.0.0.1", "10.0.0.0/8", false],
		["203.0.113.7", "203.0.113.7", true],
		["203.0.113.8", "203.0.113.7/32", false],
		["8.8.8.8", "0.0.0.0/0", true],
		["2001:db8::abcd", "2001:db8::/32", true],
		["2001:db9::1", "2001:db8::/32", false],
		["::1", "::1/128", true],
		["2001:db8::1", "::/0", true],
		["::ffff:10.0.0.5", "10.0.0.0/8", true],
		["10.0.0.5", "::ffff:10.0.0.0/104", true],
		["10.0.0.5", "2001:db8::/32", false],
		["2001:db8::1", "0.0.0.0/0", false],
	])("%s in %s is %s; families never cross", (address, rule, expected) => {
		expect(inRange(address, rule)).toBe(expected)
	})

	it.each([
		"10.0.0.0/33",
		"g::/64",
		"2001:db8::/129",
		"[::1]",
		"fe80::1%eth0/64",
		"10.0.0.0/x",
		"10.0.0.0/",
		"1.2.3.4:80",
		"nope",
	])("%j is not a rule: no brackets, port or zone, a prefix that fits the family", (rule) => {
		expect(parseIpRange(rule)).toBeNull()
	})
})
