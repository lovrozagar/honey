/**
 * Who sent a request, and over what, when reverse proxies stand in front of the app: the optional
 * `@lovrozagar/honey/trust` entry. One setting, `app.trustProxy()`, decides it for every feature
 * that asks (`ctx.ip`, `clientInfo()`, loggers, `requestId` reuse, `proxy()` forwarding headers).
 *
 * - off (the default, in the core): the peer the runtime reports is the client; forwarding
 *   headers are client-controlled text and ignored.
 * - a hop count: that many proxies stand in front of the app, each appending the address of its
 *   own peer to `X-Forwarded-For`. The client is the entry the outermost one wrote; entries
 *   further left were sent by the client and are ignored.
 * - a list of addresses and CIDR ranges: proxies are recognized by address. Starting at the peer,
 *   every trusted hop is skipped; the first untrusted address is the client.
 */
import { registerFeature } from "../runtime/feature-slots.ts"
import { type ClientInfo, directClientInfo, isValidHost, TRUST_OFF, type TrustSetting } from "./client-info.ts"
import { canonicalIp, type IpRange, ipInRange, parseIp, parseIpRange } from "./ip.ts"

export type TrustProxy = false | number | readonly string[]

/** How a compiled setting finds the client: a fixed hop count, or proxies known by address. */
type TrustRule =
	| { readonly hops: number; readonly kind: "hops" }
	| { readonly kind: "ranges"; readonly ranges: readonly IpRange[] }

const NOT_A_SETTING = "trustProxy: pass false, a hop count, or a non-empty list of proxy addresses and CIDR ranges"

/** Compile `app.trustProxy(value)`, refusing an invalid setting when it is made, not per request. */
export function compileTrust(value: TrustProxy): TrustSetting {
	if (value === false || value === 0) return TRUST_OFF
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`trustProxy: a hop count must be a non-negative integer, got ${value}`)
		}
		return withResolver({ hops: value, kind: "hops" })
	}
	if (!Array.isArray(value) || value.length === 0) throw new Error(NOT_A_SETTING)
	const ranges = value.map((rule) => {
		const range = typeof rule === "string" ? parseIpRange(rule) : null
		if (range === null) throw new Error(`trustProxy: ${JSON.stringify(rule)} is not an IP address or CIDR range`)
		return range
	})
	return withResolver({ kind: "ranges", ranges })
}

function withResolver(rule: TrustRule): TrustSetting {
	return Object.freeze({
		kind: rule.kind,
		resolve: (req: Request, peer: string | null) => resolveRule(rule, req, peer),
	})
}

/** The comma-separated entries of a header, across the lines it arrived on, blanks dropped. */
function listHeader(headers: Headers, name: string): string[] {
	const raw = headers.get(name)
	if (raw === null) return []
	const out: string[] = []
	for (const part of raw.split(",")) {
		const value = part.trim()
		if (value !== "") out.push(value)
	}
	return out
}

function isTrusted(ranges: readonly IpRange[], text: string): boolean | null {
	const addr = parseIp(text)
	if (addr === null) return null
	return ranges.some((range) => ipInRange(addr, range))
}

/**
 * How many proxies in front of the app this request passed through that the setting trusts.
 * Each appended one `X-Forwarded-For` entry, so the client is the entry that many from the
 * right. `null` when a hop the walk must read is not an address.
 */
function trustedHops(rule: TrustRule, peer: string | null, forwarded: readonly string[]): number | null {
	if (rule.kind === "hops") return rule.hops
	if (peer === null || isTrusted(rule.ranges, peer) !== true) return 0
	let count = 1
	for (let i = forwarded.length - 1; i > 0; i--) {
		const trusted = isTrusted(rule.ranges, forwarded[i] as string)
		if (trusted === null) return null
		if (!trusted) break
		count++
	}
	return count
}

/** The value the outermost trusted hop wrote: `count` from the right, or the leftmost when the list is shorter. */
function pick(values: readonly string[], count: number): string | undefined {
	if (values.length === 0) return undefined
	return values[Math.max(0, values.length - count)]
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
	const host = pick(listHeader(req.headers, "x-forwarded-host"), count)
	return {
		host: host !== undefined && isValidHost(host) ? host : direct.host,
		ip,
		protocol: proto === "https" || proto === "http" ? proto : direct.protocol,
		/* H18.4: forwarded only when the client is an X-Forwarded-For entry, not the peer or garbage */
		trustsForwarded: client !== undefined && ip !== null,
	}
}

// feature-entry: trust
registerFeature("trust", { compileTrust })
