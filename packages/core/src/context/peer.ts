/**
 * `ctx.ip`: the peer the platform reports, in one canonical spelling (H23). There is no proxy
 * trust: the address is the connection's other end as the runtime sees it.
 *
 * - Cloudflare Workers: `CF-Connecting-IP`, which the edge sets and a client cannot override. It
 *   is read only when running on Workers; anywhere else it is client-sent text.
 * - Bun: `server.requestIP(req)`, from the server Bun passes as fetch's env (or `env.server`).
 * - Node: the socket's `remoteAddress`, which the Node adapter's request reports under
 *   `PEER_ADDRESS`.
 *
 * Behind a self-hosted reverse proxy that is the proxy's address.
 */

/** A request that knows its peer reports it under this key, allocation-free (the Node adapter's request). */
export const PEER_ADDRESS: unique symbol = /* @__PURE__ */ Symbol.for("honey.peerAddress")

type BunServerLike = { requestIP?: (req: Request) => { address?: string } | null }

/** Workers is the one runtime whose edge reports the peer in a header a client cannot send. */
function onWorkers(): boolean {
	return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers"
}

/** The peer address as the runtime reports it, unparsed, or `null` when nothing reports one. */
export function peerAddressOf(req: Request, env: unknown): string | null {
	const own = (req as unknown as Record<symbol, unknown>)[PEER_ADDRESS]
	if (typeof own === "string") return own === "" ? null : own
	if (env !== null && typeof env === "object") {
		const e = env as BunServerLike & { server?: BunServerLike }
		const server = typeof e.requestIP === "function" ? e : e.server
		if (typeof server?.requestIP === "function") {
			try {
				return server.requestIP(req)?.address ?? null
			} catch {
				return null
			}
		}
	}
	return onWorkers() ? req.headers.get("cf-connecting-ip") : null
}

/** What a request carries for `ctx.ip`: the request, the env (which may be a Bun server), and the address once read. */
export type PeerSource = { readonly env: unknown; readonly req: Request; ip?: string | null }

/** The request's canonical peer, read on first ask and kept on its state. */
export function ipOf(source: PeerSource): string | null {
	if (source.ip === undefined) {
		const peer = peerAddressOf(source.req, source.env)
		source.ip = peer === null ? null : canonicalIp(peer)
	}
	return source.ip
}

const V4_MAPPED_PREFIX = 0xffffn << 32n
const V4_MAPPED_MASK = ~0xffffffffn & ((1n << 128n) - 1n)
const DIGITS = /^\d+$/
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/
const PORT = /^\d{1,5}$/
const BRACKET_TAIL = /^:\d{1,5}$/

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
	if (s.includes(".", lastColon)) {
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

/** Strip what a runtime or header wraps an address in: brackets with a port, an IPv4 port, an IPv6 zone. */
function unwrap(input: string): string | null {
	let s = input.trim()
	if (s.startsWith("[")) {
		const close = s.indexOf("]")
		if (close === -1) return null
		const after = s.slice(close + 1)
		if (after !== "" && !BRACKET_TAIL.test(after)) return null
		s = s.slice(1, close)
	} else {
		const colon = s.indexOf(":")
		/* one colon and a dot can only be IPv4 with a port */
		if (colon !== -1 && colon === s.lastIndexOf(":") && s.includes(".")) {
			if (!PORT.test(s.slice(colon + 1))) return null
			s = s.slice(0, colon)
		}
	}
	const zone = s.indexOf("%")
	if (zone === -1) return s
	return s.includes(":") ? s.slice(0, zone) : null
}

function formatV4(n: number): string {
	return `${Math.floor(n / 16777216)}.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`
}

/** RFC 5952: lowercase hex, the longest run of two or more zero groups compressed to `::`. */
function formatV6(n: bigint): string {
	const groups: number[] = []
	for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn))
	let start = -1
	let length = 1
	for (let i = 0; i < 8;) {
		let j = i
		while (j < 8 && groups[j] === 0) j++
		if (j - i > length) [start, length] = [i, j - i]
		i = j === i ? i + 1 : j
	}
	const text = groups.map((group) => group.toString(16))
	if (start === -1) return text.join(":")
	return `${text.slice(0, start).join(":")}::${text.slice(start + length).join(":")}`
}

/**
 * One spelling per address, so the same client reads the same on every runtime: dotted IPv4 (an
 * IPv4-mapped IPv6 address and an IPv4 address with a port included) or RFC 5952 IPv6. `null`
 * for anything that is not exactly one address.
 */
export function canonicalIp(input: string): string | null {
	const s = unwrap(input)
	if (s === null) return null
	if (!s.includes(":")) {
		const v4 = parseIpv4(s)
		return v4 === null ? null : formatV4(v4)
	}
	const n = parseIpv6(s)
	if (n === null) return null
	return (n & V4_MAPPED_MASK) === V4_MAPPED_PREFIX ? formatV4(Number(n & 0xffffffffn)) : formatV6(n)
}
