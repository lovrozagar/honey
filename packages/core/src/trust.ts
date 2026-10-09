import { canonicalIp, ipInRange, parseIp, parseIpRange, type IpRange } from "./ip.ts"

/**
 * Who sent a request, and over what. One setting, `app.trustProxy()`, decides it for every
 * feature that asks: `ctx.ip`, `ipRestrict`, loggers, `proxy()` forwarding headers.
 *
 * - off (the default): the peer the runtime reports is the client; forwarding headers are
 *   client-controlled text and ignored.
 * - a hop count: that many reverse proxies stand in front of the app, each appending the
 *   address of its own peer to `X-Forwarded-For`. The client is the entry the outermost one
 *   wrote; entries further left were sent by the client and are ignored.
 * - a list of addresses and CIDR ranges: proxies are recognized by address. Starting at the
 *   peer, every trusted hop is skipped; the first untrusted address is the client.
 */
export type TrustProxy = false | number | readonly string[]

export type TrustSetting =
	| { readonly kind: "off" }
	| { readonly kind: "hops"; readonly hops: number }
	| { readonly kind: "ranges"; readonly ranges: readonly IpRange[] }

export const TRUST_OFF: TrustSetting = Object.freeze({ kind: "off" })

export function compileTrust(value: TrustProxy): TrustSetting {
	if (value === false || value === 0) return TRUST_OFF
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`trustProxy: a hop count must be a non-negative integer, got ${value}`)
		}
		return { hops: value, kind: "hops" }
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("trustProxy: pass false, a hop count, or a non-empty list of proxy addresses and CIDR ranges")
	}
	const ranges = value.map((rule) => {
		const range = typeof rule === "string" ? parseIpRange(rule) : null
		if (range === null) throw new Error(`trustProxy: ${JSON.stringify(rule)} is not an IP address or CIDR range`)
		return range
	})
	return { kind: "ranges", ranges }
}

export type ClientInfo = {
	/** Canonical client address, or `null` when it is unknown or a trusted header holds garbage. */
	ip: string | null
	/** Host the client asked for (`host[:port]`), or `null`. */
	host: string | null
	protocol: "http" | "https"
}

function listHeader(headers: Headers, name: string): string[] {
	const raw = headers.get(name)
	if (raw === null) return []
	const out: string[] = []
	for (const part of raw.split(",")) {
		const v = part.trim()
		if (v !== "") out.push(v)
	}
	return out
}

/**
 * How many proxies in front of the app this request passed through that the setting trusts.
 * Each one appended one `X-Forwarded-For` entry, so the client is the entry `count` from the
 * right. `null` when a hop the walk must read is not an address.
 */
function trustedHops(trust: TrustSetting, peer: string | null, forwarded: readonly string[]): number | null {
	if (trust.kind === "off") return 0
	if (trust.kind === "hops") return trust.hops
	const isTrusted = (text: string): boolean | null => {
		const addr = parseIp(text)
		if (addr === null) return null
		return trust.ranges.some((r) => ipInRange(addr, r))
	}
	if (peer === null) return 0
	const peerTrusted = isTrusted(peer)
	if (peerTrusted !== true) return 0
	let count = 1
	for (let i = forwarded.length - 1; i > 0; i--) {
		const trusted = isTrusted(forwarded[i])
		if (trusted === null) return null
		if (!trusted) break
		count++
	}
	return count
}

/** The value the outermost trusted hop wrote: `count` from the right, or the leftmost when the list is shorter. */
function pick(values: readonly string[], count: number): string | undefined {
	if (values.length === 0) return undefined
	const idx = values.length - count
	return values[idx < 0 ? 0 : idx]
}

const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?)(?::\d{1,5})?$/

/** `host[:port]` as RFC 9110 allows it in `Host`; nothing that could change a URL's meaning. */
export function isValidHost(host: string): boolean {
	if (!HOST.test(host)) return false
	const colon = host.lastIndexOf(":")
	if (colon !== -1 && host.lastIndexOf("]") < colon) {
		const port = Number(host.slice(colon + 1))
		if (port > 65535) return false
	}
	return true
}

/** `false` when the request carries a `Host` header that is not `host[:port]`. */
export function hasValidHost(req: Request): boolean {
	const host = req.headers.get("host")
	return host === null || isValidHost(host)
}

function hostOfUrl(url: string): string | null {
	const start = url.indexOf("//")
	if (start === -1) return null
	let end = url.indexOf("/", start + 2)
	if (end === -1) end = url.length
	const host = url.slice(start + 2, end)
	return host === "" ? null : host
}

export function resolveClientInfo(trust: TrustSetting, req: Request, peer: string | null): ClientInfo {
	const transport = req.url.startsWith("https:") ? "https" : "http"
	const forwarded = trust.kind === "off" ? [] : listHeader(req.headers, "x-forwarded-for")
	const count = trustedHops(trust, peer, forwarded)
	const direct: ClientInfo = {
		host: hostOfUrl(req.url),
		ip: peer === null ? null : canonicalIp(peer),
		protocol: transport,
	}
	if (count === null) return { ...direct, ip: null }
	if (count === 0) return direct

	const client = pick(forwarded, count)
	const ip = client === undefined ? direct.ip : canonicalIp(client)

	const proto = pick(listHeader(req.headers, "x-forwarded-proto"), count)?.toLowerCase()
	const protocol = proto === "https" || proto === "http" ? proto : transport
	const fwdHost = pick(listHeader(req.headers, "x-forwarded-host"), count)
	const host = fwdHost !== undefined && isValidHost(fwdHost) ? fwdHost : direct.host
	return { host, ip, protocol }
}
