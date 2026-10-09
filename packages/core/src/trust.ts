import { directClientInfo, isValidHost, TRUST_OFF, type ClientInfo, type TrustSetting } from "./client-info.ts"
import { registerFeature } from "./feature-slots.ts"
import { canonicalIp, ipInRange, parseIp, parseIpRange, type IpRange } from "./ip.ts"

export type { ClientInfo, TrustSetting } from "./client-info.ts"
export { hasValidHost, isValidHost, TRUST_OFF } from "./client-info.ts"

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

/** How a compiled setting finds the client: a fixed hop count, or proxies known by address. */
type TrustRule =
	| { readonly kind: "hops"; readonly hops: number }
	| { readonly kind: "ranges"; readonly ranges: readonly IpRange[] }

function withResolver(rule: TrustRule): TrustSetting {
	return Object.freeze({
		kind: rule.kind,
		resolve: (req: Request, peer: string | null) => resolveRule(rule, req, peer),
	})
}

export function compileTrust(value: TrustProxy): TrustSetting {
	if (value === false || value === 0) return TRUST_OFF
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`trustProxy: a hop count must be a non-negative integer, got ${value}`)
		}
		return withResolver({ hops: value, kind: "hops" })
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("trustProxy: pass false, a hop count, or a non-empty list of proxy addresses and CIDR ranges")
	}
	const ranges = value.map((rule) => {
		const range = typeof rule === "string" ? parseIpRange(rule) : null
		if (range === null) throw new Error(`trustProxy: ${JSON.stringify(rule)} is not an IP address or CIDR range`)
		return range
	})
	return withResolver({ kind: "ranges", ranges })
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
function trustedHops(trust: TrustRule, peer: string | null, forwarded: readonly string[]): number | null {
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

function resolveRule(rule: TrustRule, req: Request, peer: string | null): ClientInfo {
	const direct = directClientInfo(req, peer)
	const forwarded = listHeader(req.headers, "x-forwarded-for")
	const count = trustedHops(rule, peer, forwarded)
	if (count === null) return { ...direct, ip: null }
	if (count === 0) return direct

	const client = pick(forwarded, count)
	const ip = client === undefined ? direct.ip : canonicalIp(client)

	const proto = pick(listHeader(req.headers, "x-forwarded-proto"), count)?.toLowerCase()
	const protocol = proto === "https" || proto === "http" ? proto : direct.protocol
	const fwdHost = pick(listHeader(req.headers, "x-forwarded-host"), count)
	const host = fwdHost !== undefined && isValidHost(fwdHost) ? fwdHost : direct.host
	return { host, ip, protocol }
}

/** The client of `req` under `trust`; the same answer `ctx.ip` and `clientInfo()` give. */
export function resolveClientInfo(trust: TrustSetting, req: Request, peer: string | null): ClientInfo {
	return trust.kind === "off" ? directClientInfo(req, peer) : trust.resolve(req, peer)
}

registerFeature("trust", { compileTrust })
