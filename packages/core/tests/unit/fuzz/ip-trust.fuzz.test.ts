import { isIPv4 } from "node:net"
import { describe, expect, it } from "vitest"
import { canonicalIp, formatIp, ipInRange, parseIp, parseIpRange, type IpAddress } from "../../../src/ip.ts"
import { compileTrust, resolveClientInfo } from "../../../src/trust.ts"
import { caseLabel, rng, runs, stringOf, type Rng } from "./rng.ts"

/*
 * Every trust and ipRestrict decision compares addresses in the canonical form ip.ts produces.
 * Properties: parsing never throws; IPv4 acceptance matches Node's strict parser; IPv6
 * acceptance and value match a WHATWG URL parser; formatting round-trips; range membership
 * matches a bit-by-bit reference; and the trusted-hop walk picks the client a naive reference
 * picks.
 */

function randomV4(r: Rng): number {
	return r.int(256) * 16777216 + r.int(256) * 65536 + r.int(256) * 256 + r.int(256)
}

function randomV6(r: Rng): bigint {
	let n = 0n
	for (let g = 0; g < 8; g++) {
		/* zero groups often, so `::` compression is exercised */
		const group = r.bool(0.4) ? 0 : r.int(0x10000)
		n = (n << 16n) | BigInt(group)
	}
	return n
}

function v6Groups(n: bigint): string[] {
	const out: string[] = []
	for (let i = 7; i >= 0; i--) out.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16))
	return out
}

/** Several spellings of one IPv6 address: full, zero-padded, uppercase, compressed anywhere legal. */
function spell(r: Rng, n: bigint): string {
	let groups = v6Groups(n)
	if (r.bool(0.3)) groups = groups.map((g) => g.padStart(4, "0"))
	if (r.bool(0.3)) groups = groups.map((g) => g.toUpperCase())
	const zeroRuns: Array<[number, number]> = []
	for (let i = 0; i < 8; i++) {
		if (Number.parseInt(groups[i], 16) !== 0) continue
		let j = i
		while (j < 8 && Number.parseInt(groups[j], 16) === 0) j++
		zeroRuns.push([i, j])
		i = j
	}
	if (zeroRuns.length > 0 && r.bool(0.7)) {
		const [a, b] = r.pick(zeroRuns)
		const start = a + r.int(b - a)
		const end = start + 1 + r.int(b - start)
		return `${groups.slice(0, start).join(":")}::${groups.slice(end).join(":")}`
	}
	return groups.join(":")
}

function whatwgV6(text: string): bigint | null {
	let host: string
	try {
		host = new URL(`http://[${text}]/`).hostname
	} catch {
		return null
	}
	const addr = parseIp(host)
	if (addr === null) throw new Error(`URL canonical form ${host} did not parse`)
	return addr.v === 6 ? addr.n : (0xffffn << 32n) | BigInt(addr.n)
}

function asV6(addr: IpAddress): bigint {
	return addr.v === 6 ? addr.n : (0xffffn << 32n) | BigInt(addr.n)
}

const IP_ALPHABET = ["0", "1", "9", "a", "F", ":", ":", "::", ".", "255", "256", "01", "%", "[", "]", " ", "ffff", "x"]

describe("fuzz: ip parsing", () => {
	it("never throws; IPv4 acceptance matches node:net", () => {
		const r = rng(41)
		for (let i = 0; i < runs(5000); i++) {
			const text = stringOf(r, IP_ALPHABET, 9)
			const label = caseLabel(41, i, text)
			const addr = parseIp(text)
			if (!/[:%[\]\s]/.test(text)) expect(addr !== null, label).toBe(isIPv4(text))
			if (addr !== null) {
				const canon = formatIp(addr)
				expect(canonicalIp(canon), label).toBe(canon)
				expect(parseIp(canon), label).toEqual(addr)
			}
		}
	})

	it("IPv6 acceptance and value match a WHATWG URL parser", () => {
		const r = rng(42)
		for (let i = 0; i < runs(5000); i++) {
			const text = stringOf(r, ["0", "1", "a", "F", "ffff", ":", "::", ".", "1.2.3.4", "255", "01"], 9)
			if (!text.includes(":")) continue
			/* one colon and a dot is IPv4 with a port (covered above), not an IPv6 spelling */
			if (text.indexOf(":") === text.lastIndexOf(":") && text.includes(".")) continue
			const label = caseLabel(42, i, text)
			const addr = parseIp(text)
			const expected = whatwgV6(text)
			expect(addr === null ? null : asV6(addr), label).toBe(expected)
		}
	})

	it("every spelling of an address canonicalizes to one RFC 5952 text, as URL serializes it", () => {
		const r = rng(43)
		for (let i = 0; i < runs(3000); i++) {
			const n = randomV6(r)
			const text = spell(r, n)
			const label = caseLabel(43, i, text)
			const addr = parseIp(text)
			expect(addr, label).not.toBeNull()
			expect(asV6(addr as IpAddress), label).toBe(n)
			expect(parseIp(`[${text}]:443`), label).toEqual(addr)
			expect(parseIp(`${text}%eth0`), label).toEqual(addr)
			if ((addr as IpAddress).v === 6) {
				expect(`[${formatIp(addr as IpAddress)}]`, label).toBe(new URL(`http://[${text}]/`).hostname)
			}
		}
	})

	it("an IPv4-mapped address and an IPv4 address with a port are the IPv4 address", () => {
		const r = rng(44)
		for (let i = 0; i < runs(2000); i++) {
			const n = randomV4(r)
			const dotted = formatIp({ n, v: 4 })
			const label = caseLabel(44, i, dotted)
			expect(parseIp(dotted), label).toEqual({ n, v: 4 })
			expect(parseIp(`::ffff:${dotted}`), label).toEqual({ n, v: 4 })
			expect(parseIp(`::FFFF:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`), label).toEqual({ n, v: 4 })
			expect(parseIp(`${dotted}:${r.int(65536)}`), label).toEqual({ n, v: 4 })
		}
	})
})

describe("fuzz: CIDR membership", () => {
	it("IPv4 ranges match a bit-by-bit reference", () => {
		const r = rng(45)
		for (let i = 0; i < runs(5000); i++) {
			const base = randomV4(r)
			const prefix = r.int(33)
			/* half the probes share a prefix with the base, so both outcomes are common */
			const probe = r.bool() ? (base ^ (r.int(2 ** Math.min(31, 32 - prefix + 1)) >>> 0)) >>> 0 : randomV4(r)
			const range = parseIpRange(`${formatIp({ n: base, v: 4 })}/${prefix}`)
			const label = caseLabel(45, i, [base, prefix, probe])
			expect(range, label).not.toBeNull()
			const shift = BigInt(32 - prefix)
			const expected = prefix === 0 || BigInt(base) >> shift === BigInt(probe) >> shift
			expect(ipInRange({ n: probe, v: 4 }, range as NonNullable<typeof range>), label).toBe(expected)
		}
	})

	it("IPv6 ranges match a bit-by-bit reference", () => {
		const r = rng(46)
		for (let i = 0; i < runs(3000); i++) {
			const base = randomV6(r)
			const prefix = r.int(129)
			const flip = BigInt(r.int(128))
			const probe = r.bool() ? base ^ (1n << flip) : randomV6(r)
			const label = caseLabel(46, i, [base.toString(16), prefix, probe.toString(16)])
			const range = parseIpRange(`${spell(r, base)}/${prefix}`)
			expect(range, label).not.toBeNull()
			const addr = parseIp(spell(r, probe)) as IpAddress
			const shift = BigInt(128 - prefix)
			const expected = base >> shift === probe >> shift
			const v4Mapped = (n: bigint) => n >> 32n === 0xffffn
			/* mapped space folds into IPv4: compare only when neither side was folded */
			if (addr.v === 6 && (range as { v: number }).v === 6) {
				expect(ipInRange(addr, range as NonNullable<typeof range>), label).toBe(expected)
			} else if (v4Mapped(base) && prefix >= 96 && v4Mapped(probe)) {
				expect(ipInRange(addr, range as NonNullable<typeof range>), label).toBe(expected)
			}
		}
	})
})

/* ------------------------------------------------------------------- trusted hop walk */

const PROXIES = ["10.0.0.1", "10.0.0.2", "::ffff:10.0.0.3", "[10.0.0.4]:80"]
const CLIENTS = ["203.0.113.7", "2001:db8::1", "198.51.100.9:5000", "203.0.113.8"]
const GARBAGE = ["unknown", "", "1.2.3", "_hidden"]

/** Naive reference: walk [...forwarded, peer] from the right, skipping trusted proxies. */
function walk(chain: string[], trusted: (s: string) => boolean | null): string | null {
	let idx = chain.length - 1
	while (idx > 0) {
		const t = trusted(chain[idx])
		if (t === null) return null
		if (!t) break
		idx--
	}
	return canonicalIp(chain[idx])
}

describe("fuzz: trusted hop walk", () => {
	it("a CIDR trust list picks the client a naive right-to-left walk picks", () => {
		const r = rng(47)
		const trust = compileTrust(["10.0.0.0/8"])
		const trusted = (s: string) => {
			const a = parseIp(s)
			return a === null ? null : a.v === 4 && a.n >>> 24 === 10
		}
		for (let i = 0; i < runs(3000); i++) {
			const forwarded = Array.from({ length: r.int(5) }, () =>
				r.pick([...PROXIES, ...CLIENTS, ...(r.bool(0.1) ? GARBAGE : [])]),
			).filter((s) => s !== "")
			const peer = r.pick([...PROXIES, ...CLIENTS])
			const headers = new Headers()
			if (forwarded.length > 0) headers.set("x-forwarded-for", forwarded.join(", "))
			const req = new Request("http://app.test/", { headers })
			const got = resolveClientInfo(trust, req, peer).ip
			/* the peer is the first hop; an untrusted peer is the client */
			const expected = trusted(peer) === true ? walk([...forwarded, peer], trusted) : canonicalIp(peer)
			expect(got, caseLabel(47, i, { forwarded, peer })).toBe(expected)
		}
	})

	it("a hop count picks the entry that many from the right, never one the client wrote further left", () => {
		const r = rng(48)
		for (let i = 0; i < runs(2000); i++) {
			const hops = 1 + r.int(3)
			const spoofed = Array.from({ length: r.int(3) }, () => r.pick(CLIENTS))
			const client = r.pick(CLIENTS)
			/* the outermost proxy appends the client; each inner proxy appends its own peer */
			const appended = [client, ...Array.from({ length: hops - 1 }, () => r.pick(PROXIES))]
			const forwarded = [...spoofed, ...appended]
			const req = new Request("http://app.test/", { headers: { "x-forwarded-for": forwarded.join(", ") } })
			const got = resolveClientInfo(compileTrust(hops), req, r.pick(PROXIES)).ip
			expect(got, caseLabel(48, i, { forwarded, hops })).toBe(canonicalIp(client))
		}
	})
})
