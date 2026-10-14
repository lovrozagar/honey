/**
 * IP addresses in canonical numeric form. Every trust decision parses both sides here first, so
 * `::ffff:203.0.113.7`, `203.0.113.7` and `203.0.113.7:51234` are one address and `2001:DB8::1`
 * equals `2001:db8::1`.
 */

export type IpAddress = { readonly v: 4; readonly n: number } | { readonly v: 6; readonly n: bigint }

export type IpRange =
	| { readonly v: 4; readonly base: number; readonly mask: number }
	| { readonly v: 6; readonly base: bigint; readonly mask: bigint }

const ALL_128 = (1n << 128n) - 1n
const V4_MAPPED_PREFIX = 0xffffn << 32n
const V4_MAPPED_MASK = ~0xffffffffn & ALL_128
const DIGITS = /^\d+$/
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/
const PORT = /^\d{1,5}$/
const BRACKET_TAIL = /^:\d{1,5}$/
const PREFIX = /^\d{1,3}$/

function parseIpv4(s: string): number | null {
	const parts = s.split(".")
	if (parts.length !== 4) return null
	let n = 0
	for (const part of parts) {
		/* digits only and no leading zero: `010` is octal to some parsers and decimal to others */
		if (part.length === 0 || part.length > 3 || !DIGITS.test(part)) return null
		if (part.length > 1 && part.charCodeAt(0) === 48) return null
		const octet = Number(part)
		if (octet > 255) return null
		n = n * 256 + octet
	}
	return n
}

/** The `:`-separated groups of one side of `::`, as numbers; `null` when one is not 1–4 hex digits. */
function groupsOf(side: string): number[] | null {
	if (side === "") return []
	const groups: number[] = []
	for (const group of side.split(":")) {
		if (!HEX_GROUP.test(group)) return null
		groups.push(Number.parseInt(group, 16))
	}
	return groups
}

function parseIpv6(s: string): bigint | null {
	let head = s
	const tail: number[] = []
	const lastColon = s.lastIndexOf(":")
	if (lastColon !== -1 && s.includes(".", lastColon)) {
		/* an embedded IPv4 address fills the last two groups */
		const v4 = parseIpv4(s.slice(lastColon + 1))
		if (v4 === null) return null
		tail.push(Math.floor(v4 / 65536), v4 % 65536)
		head = s.slice(0, lastColon + 1)
		/* "a:1.2.3.4" leaves "a:", whose trailing colon is a separator; "a::1.2.3.4" leaves "a::" */
		if (!head.endsWith("::")) head = head.slice(0, -1)
	}
	const halves = head.split("::")
	if (halves.length > 2) return null
	const left = groupsOf(halves[0] as string)
	if (left === null) return null
	let groups = [...left, ...tail]
	if (halves.length === 2) {
		const right = groupsOf(halves[1] as string)
		if (right === null) return null
		const fill = 8 - left.length - right.length - tail.length
		/* `::` stands for at least one zero group */
		if (fill < 1) return null
		groups = [...left, ...Array.from({ length: fill }, () => 0), ...right, ...tail]
	}
	if (groups.length !== 8) return null
	let n = 0n
	for (const group of groups) n = (n << 16n) | BigInt(group)
	return n
}

/** An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is the IPv4 address it maps. */
function fromV6(n: bigint): IpAddress {
	if ((n & V4_MAPPED_MASK) === V4_MAPPED_PREFIX) return { n: Number(n & 0xffffffffn), v: 4 }
	return { n, v: 6 }
}

/** Strip what a peer or a forwarding header wraps an address in: brackets with a port, or an IPv4 port. */
function unwrap(input: string): string | null {
	const s = input.trim()
	if (s.startsWith("[")) {
		const close = s.indexOf("]")
		if (close === -1) return null
		const after = s.slice(close + 1)
		if (after !== "" && !BRACKET_TAIL.test(after)) return null
		return s.slice(1, close)
	}
	const colon = s.indexOf(":")
	/* one colon and a dot can only be IPv4 with a port */
	if (colon !== -1 && colon === s.lastIndexOf(":") && s.includes(".")) {
		return PORT.test(s.slice(colon + 1)) ? s.slice(0, colon) : null
	}
	return s
}

/**
 * Parse an address the way a peer or a forwarding header writes it: brackets, an IPv6 zone
 * (`%eth0`) and a port (`1.2.3.4:5678`, `[::1]:5678`) are accepted and dropped. `null` for
 * anything that is not exactly one address.
 */
export function parseIp(input: string): IpAddress | null {
	let s = unwrap(input)
	if (s === null) return null
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

/** The longest run of zero groups, as [start, length]; a single zero group is never compressed (RFC 5952 §4.2.2). */
function longestZeroRun(groups: readonly number[]): [number, number] {
	let best: [number, number] = [-1, 1]
	for (let i = 0; i < groups.length;) {
		if (groups[i] !== 0) {
			i++
			continue
		}
		let j = i
		while (j < groups.length && groups[j] === 0) j++
		if (j - i > best[1]) best = [i, j - i]
		i = j
	}
	return best
}

/** Canonical text: dotted IPv4, or RFC 5952 IPv6 (lowercase, the longest zero run compressed). */
export function formatIp(addr: IpAddress): string {
	if (addr.v === 4) {
		const n = addr.n
		return `${Math.floor(n / 16777216)}.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`
	}
	const groups: number[] = []
	for (let i = 7; i >= 0; i--) groups.push(Number((addr.n >> BigInt(i * 16)) & 0xffffn))
	const [start, length] = longestZeroRun(groups)
	const text = groups.map((group) => group.toString(16))
	if (start === -1) return text.join(":")
	return `${text.slice(0, start).join(":")}::${text.slice(start + length).join(":")}`
}

/** `canonicalIp("::ffff:127.0.0.1")` is `"127.0.0.1"`; `null` when the input is not an address. */
export function canonicalIp(input: string): string | null {
	const addr = parseIp(input)
	return addr === null ? null : formatIp(addr)
}

function v4Range(n: number, prefix: number): IpRange {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
	return { base: (n & mask) >>> 0, mask, v: 4 }
}

/**
 * Parse an address or CIDR rule (`10.0.0.0/8`, `2001:db8::/32`, `203.0.113.7`). Strict: no
 * brackets, port or zone, and a prefix length that fits the family. An IPv4-mapped IPv6 range
 * of `/96` or longer is the IPv4 range it maps. `null` when the rule is invalid.
 */
export function parseIpRange(rule: string): IpRange | null {
	const s = rule.trim()
	const slash = s.indexOf("/")
	const ipText = slash === -1 ? s : s.slice(0, slash)
	if (ipText.startsWith("[") || ipText.includes("%")) return null
	let bits: number | null = null
	if (slash !== -1) {
		const bitsText = s.slice(slash + 1)
		if (!PREFIX.test(bitsText)) return null
		bits = Number(bitsText)
	}
	return ipText.includes(":") ? v6Rule(ipText, bits ?? 128) : v4Rule(ipText, bits ?? 32)
}

function v6Rule(ipText: string, prefix: number): IpRange | null {
	const n = parseIpv6(ipText)
	if (n === null || prefix > 128) return null
	if ((n & V4_MAPPED_MASK) === V4_MAPPED_PREFIX && prefix >= 96) return v4Range(Number(n & 0xffffffffn), prefix - 96)
	const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix)
	return { base: n & mask, mask, v: 6 }
}

function v4Rule(ipText: string, prefix: number): IpRange | null {
	const n = parseIpv4(ipText)
	if (n === null || prefix > 32) return null
	return v4Range(n, prefix)
}

/** Whether `addr` falls in `range`; an IPv4 address is never in an IPv6 range, nor the reverse. */
export function ipInRange(addr: IpAddress, range: IpRange): boolean {
	if (addr.v === 4 && range.v === 4) return (addr.n & range.mask) >>> 0 === range.base
	if (addr.v === 6 && range.v === 6) return (addr.n & range.mask) === range.base
	return false
}
