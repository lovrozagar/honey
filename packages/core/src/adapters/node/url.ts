/**
 * The Request URL from what the client sent, spelled as Bun and Workers spell it. Anything that is
 * not one URL (a second Host, a Host that is not `host[:port]`, a target form Fetch has no URL for)
 * is `null`, and the request gets 400.
 */
import type { IncomingMessage } from "node:http"

/** `host[:port]` as RFC 9110 allows it in `Host`: no userinfo, path or anything else that changes the URL. */
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?)(?::\d{1,5})?$/

/** Already what URL parsing serializes: lowercase labels ending in a letter-led one, or a dotted quad. */
const CANONICAL_HOST =
	/^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z](?:[a-z0-9-]*[a-z0-9])?\.?|(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))(?::[1-9]\d{0,4})?$/

/** Characters URL parsing leaves alone in a path and query, on every runtime. */
const PLAIN_TARGET = /^\/[\w\-.~!$&()*+,;=:@/?%]*$/
const ESCAPED_DOT = /%2e/i

/** A target URL parsing would leave exactly as it is: no dot segment, escaped or not. */
function isPlainTarget(target: string): boolean {
	return PLAIN_TARGET.test(target) && !target.includes("/.") && !ESCAPED_DOT.test(target)
}

/** `URL.parse` without it: Node 20 lacks it. */
function parseUrl(text: string): URL | null {
	try {
		return new URL(text)
	} catch {
		/* not a URL: the answer, not a failure; the caller refuses it with a 400 */
		return null
	}
}

/**
 * The host as the Request URL carries it (Bun and Workers serialize it through URL parsing), or
 * `null` when it is not one. The common spelling skips the parse; IPv4 shorthands, IPv6 literals,
 * punycode, uppercase and a default port go through it.
 */
function canonicalHost(scheme: string, host: string): string | null {
	if (!HOST.test(host)) return null
	if (CANONICAL_HOST.test(host) && !host.includes("xn--")) {
		const colon = host.lastIndexOf(":")
		if (colon === -1) return host
		const port = host.slice(colon + 1)
		if (Number(port) <= 65535 && port !== (scheme === "https" ? "443" : "80")) return host
	}
	return parseUrl(`${scheme}://${host}/`)?.host ?? null
}

function absoluteFormUrl(scheme: string, target: string): string | null {
	const lower = target.slice(0, 8).toLowerCase()
	if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null
	const url = parseUrl(target)
	if (url === null || url.username !== "" || url.password !== "" || !HOST.test(url.host)) return null
	return `${scheme}://${url.host}${url.pathname}${url.search}`
}

/** The one Host header's value, `undefined` without one, `null` with several: the request is ambiguous. */
function soleHost(raw: readonly string[]): string | null | undefined {
	let host: string | undefined
	for (let i = 0; i < raw.length; i += 2) {
		const name = raw[i] as string
		if (name.length !== 4 || name.toLowerCase() !== "host") continue
		if (host !== undefined) return null
		host = raw[i + 1] as string
	}
	return host
}

/**
 * The request URL: the scheme from the socket's TLS state, the authority from `Host` (or from an
 * absolute-form target, which wins per RFC 9112), the path and query from the target, parsed as
 * Bun and Workers parse the same bytes. Any other target form, a second `Host`, and a
 * `Host` that is not `host[:port]` are `null`: the request gets 400.
 */
export function nodeRequestUrl(incoming: IncomingMessage): string | null {
	const scheme = (incoming.socket as { encrypted?: boolean }).encrypted === true ? "https" : "http"
	/* a request node:http parsed always has its target and method */
	const target = incoming.url as string
	const header = soleHost(incoming.rawHeaders)
	if (header === null) return null
	if (target.charCodeAt(0) !== 47) return absoluteFormUrl(scheme, target)
	const given = header === undefined || header === "" ? (incoming.httpVersion === "1.0" ? "localhost" : null) : header
	const host = given === null ? null : canonicalHost(scheme, given)
	if (host === null) return null
	if (isPlainTarget(target)) return `${scheme}://${host}${target}`
	/* never `new URL(target, base)`: a `//x/y` target would become the host. A canonical host and a
	 * target starting with `/` always parse. */
	const url = new URL(`${scheme}://${host}${target}`)
	return `${scheme}://${host}${url.pathname}${url.search}`
}
