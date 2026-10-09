import { canonicalIp } from "./ip.ts"

/**
 * Who sent a request, and over what, as the core sees it without `app.trustProxy()`: the peer
 * the runtime reports is the client, and forwarding headers are client-controlled text. Trusting
 * reverse proxies (hop counts, CIDR lists) lives in `trust.ts`, which `trustProxy()` loads.
 */
export type ClientInfo = {
	/** Canonical client address, or `null` when it is unknown or a trusted header holds garbage. */
	ip: string | null
	/** Host the client asked for (`host[:port]`), or `null`. */
	host: string | null
	protocol: "http" | "https"
}

/**
 * The app's compiled `trustProxy()` setting. Anything but `off` carries its own resolver, so
 * the core never imports the hop and range logic.
 */
export type TrustSetting =
	| { readonly kind: "off" }
	| {
			readonly kind: "hops" | "ranges"
			readonly resolve: (req: Request, peer: string | null) => ClientInfo
	  }

export const TRUST_OFF: TrustSetting = Object.freeze({ kind: "off" })

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

/** The client as the connection shows it: the peer, the URL's host, the transport's scheme. */
export function directClientInfo(req: Request, peer: string | null): ClientInfo {
	return {
		host: hostOfUrl(req.url),
		ip: peer === null ? null : canonicalIp(peer),
		protocol: req.url.startsWith("https:") ? "https" : "http",
	}
}

export function resolveClient(trust: TrustSetting, req: Request, peer: string | null): ClientInfo {
	return trust.kind === "off" ? directClientInfo(req, peer) : trust.resolve(req, peer)
}
