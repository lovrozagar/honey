/**
 * IP addresses in canonical numeric form. Every comparison the framework makes (`ipRestrict`
 * rules, trusted proxy ranges) parses both sides here first, so `::ffff:203.0.113.7`,
 * `203.0.113.7` and `203.0.113.7:51234` are one address and `2001:DB8::1` equals `2001:db8::1`.
 */

export type IpAddress = { readonly v: 4; readonly n: number } | { readonly v: 6; readonly n: bigint }

export type IpRange =
	| { readonly v: 4; readonly base: number; readonly mask: number }
	| { readonly v: 6; readonly base: bigint; readonly mask: bigint }

const V4_MAPPED_PREFIX = 0xffffn << 32n
const V4_MAPPED_MASK = ~0xffffffffn & ((1n << 128n) - 1n)

function parseIpv4(s: string): number | null {
	const parts = s.split(".")
	if (parts.length !== 4) return null
	let n = 0
	for (const part of parts) {
		/* digits only, no leading zeros (`010` is octal to some parsers, decimal to others) */
		if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return null
		if (part.length > 1 && part.charCodeAt(0) === 48) return null
		const octet = Number(part)
		if (octet > 255) return null
		n = n * 256 + octet
	}
	return n
}

/** The `:`-separated hex groups of one side of `::`; `null` when a group is not 1–4 hex digits. */
function groupsOf(part: string): string[] | null {
	if (part === "") return []
	const groups = part.split(":")
	for (const g of groups) {
		if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null
	}
	return groups
}

function parseIpv6(s: string): bigint | null {
	let addr = s
	let tail: number[] = []
	const lastColon = addr.lastIndexOf(":")
	if (lastColon !== -1 && addr.indexOf(".", lastColon) !== -1) {
		const v4 = parseIpv4(addr.slice(lastColon + 1))
		if (v4 === null) return null
		tail = [Math.floor(v4 / 65536), v4 % 65536]
		addr = addr.slice(0, lastColon + 1)
		/* "::1.2.3.4" leaves "::", "a::1.2.3.4" leaves "a::"; "a:1.2.3.4" leaves "a:" */
		if (addr.endsWith(":") && !addr.endsWith("::")) addr = addr.slice(0, -1)
	}
	const halves = addr.split("::")
	if (halves.length > 2) return null
	const left = groupsOf(halves[0])
	if (left === null) return null
	let groups: number[]
	if (halves.length === 2) {
		const right = groupsOf(halves[1])
		if (right === null) return null
		const fill = 8 - left.length - right.length - tail.length
		if (fill < 1) return null
		groups = [...left.map(hex), ...Array.from({ length: fill }, () => 0), ...right.map(hex), ...tail]
	} else {
		groups = [...left.map(hex), ...tail]
	}
	if (groups.length !== 8) return null
	let n = 0n
	for (const g of groups) n = (n << 16n) | BigInt(g)
	return n
}

function hex(g: string): number {
	return Number.parseInt(g, 16)
}

/** An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is the IPv4 address it maps. */
function fromV6(n: bigint): IpAddress {
	if ((n & V4_MAPPED_MASK) === V4_MAPPED_PREFIX) return { n: Number(n & 0xffffffffn), v: 4 }
	return { n, v: 6 }
}

/**
 * Parses an address as a peer or a forwarding header writes it: brackets, an IPv6 zone
 * (`%eth0`) and a port (`1.2.3.4:5678`, `[::1]:5678`) are accepted and dropped. Returns
 * `null` for anything that is not exactly one address.
 */
export function parseIp(input: string): IpAddress | null {
	let s = input.trim()
	if (s.startsWith("[")) {
		const close = s.indexOf("]")
		if (close === -1) return null
		const after = s.slice(close + 1)
		if (after !== "" && !/^:\d{1,5}$/.test(after)) return null
		s = s.slice(1, close)
	} else if (s.indexOf(":") !== -1 && s.indexOf(":") === s.lastIndexOf(":") && s.includes(".")) {
		/* "1.2.3.4:5678" — one colon and a dot can only be IPv4 with a port */
		const [host, port] = s.split(":")
		if (!/^\d{1,5}$/.test(port)) return null
		s = host
	}
	const zone = s.indexOf("%")
	if (zone !== -1) {
		if (!s.includes(":")) return null
		s = s.slice(0, zone)
	}
	if (s.includes(":")) {
		const n = parseIpv6(s)
		return n === null ? null : fromV6(n)
	}
	const n = parseIpv4(s)
	return n === null ? null : { n, v: 4 }
}

/** Canonical text: dotted IPv4, or RFC 5952 IPv6 (lowercase, longest zero run compressed). */
export function formatIp(addr: IpAddress): string {
	if (addr.v === 4) {
		const n = addr.n
		return `${Math.floor(n / 16777216)}.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`
	}
	const groups: number[] = []
	for (let i = 7; i >= 0; i--) groups.push(Number((addr.n >> BigInt(i * 16)) & 0xffffn))
	let bestStart = -1
	let bestLen = 1
	for (let i = 0; i < 8;) {
		if (groups[i] !== 0) {
			i++
			continue
		}
		let j = i
		while (j < 8 && groups[j] === 0) j++
		if (j - i > bestLen) {
			bestStart = i
			bestLen = j - i
		}
		i = j
	}
	const text = groups.map((g) => g.toString(16))
	if (bestStart === -1) return text.join(":")
	const head = text.slice(0, bestStart).join(":")
	const tail = text.slice(bestStart + bestLen).join(":")
	return `${head}::${tail}`
}

/** `canonicalIp("::ffff:127.0.0.1")` is `"127.0.0.1"`; `null` when the input is not an address. */
export function canonicalIp(input: string): string | null {
	const addr = parseIp(input)
	return addr === null ? null : formatIp(addr)
}

/**
 * Parses an address or CIDR rule (`10.0.0.0/8`, `2001:db8::/32`, `203.0.113.7`). Strict: no
 * port, no zone, a prefix length that fits the family. An IPv4-mapped IPv6 range of `/96` or
 * longer is the IPv4 range it maps. Returns `null` when the rule is invalid.
 */
export function parseIpRange(rule: string): IpRange | null {
	const s = rule.trim()
	const slash = s.indexOf("/")
	const ipText = slash === -1 ? s : s.slice(0, slash)
	if (ipText.startsWith("[") || ipText.includes("%")) return null
	let bits: number | null = null
	if (slash !== -1) {
		const bitsText = s.slice(slash + 1)
		if (!/^\d{1,3}$/.test(bitsText)) return null
		bits = Number(bitsText)
	}
	if (ipText.includes(":")) {
		const n = parseIpv6(ipText)
		if (n === null) return null
		const prefix = bits ?? 128
		if (prefix > 128) return null
		if ((n & V4_MAPPED_MASK) === V4_MAPPED_PREFIX && prefix >= 96) {
			return v4Range(Number(n & 0xffffffffn), prefix - 96)
		}
		const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix)) & ((1n << 128n) - 1n)
		return { base: n & mask, mask, v: 6 }
	}
	const n = parseIpv4(ipText)
	if (n === null) return null
	const prefix = bits ?? 32
	if (prefix > 32) return null
	return v4Range(n, prefix)
}

function v4Range(n: number, prefix: number): IpRange {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
	return { base: (n & mask) >>> 0, mask, v: 4 }
}

export function ipInRange(addr: IpAddress, range: IpRange): boolean {
	if (addr.v === 4 && range.v === 4) return (addr.n & range.mask) >>> 0 === range.base
	if (addr.v === 6 && range.v === 6) return (addr.n & range.mask) === range.base
	return false
}
