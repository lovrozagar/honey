/**
 * The headers a proxy sends upstream and answers with. Hop-by-hop headers (RFC 9110 §7.6.1)
 * describe one connection and never cross a proxy, in either direction, and neither does any
 * header `Connection` names. Upstream, the client's `Host` and `Expect` stay behind, and the
 * forwarding headers describe the client as the platform reported it (H23): `X-Forwarded-For` is
 * `ctx.ip`, `-Proto` and `-Host` the request URL's; whatever forwarding headers the client wrote
 * are dropped, never passed on. `CF-Connecting-IP` passes untouched: on Workers the edge set it,
 * so a service-bound Worker downstream sees the same client.
 */

/** `proxy-connection` is the pre-standard spelling clients still send. */
const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
] as const

/** What a client may write about itself, and a proxy must never pass on as fact. */
const FORWARDING = [
	"forwarded",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-port",
	"x-forwarded-proto",
	"x-real-ip",
] as const

/** The headers an edit needs: native `Headers` and the plain map's `HoneyOutHeaders` both are. */
type Editable = { delete(name: string): void; get(name: string): string | null }

/** Drop every hop-by-hop header and every header `Connection` names; an upgrade may keep `Upgrade`. */
export function dropHopByHop(headers: Editable, keepUpgrade: boolean): void {
	const named = headers.get("connection")
	if (named !== null) {
		for (const token of named.split(",")) {
			const name = token.trim().toLowerCase()
			if (name !== "" && !(keepUpgrade && name === "upgrade")) headers.delete(name)
		}
	}
	for (const name of HOP_BY_HOP) if (!(keepUpgrade && name === "upgrade")) headers.delete(name)
}

/** The scheme and host of a request URL, read without parsing it: a Request's URL always has a path. */
function originParts(url: string): { host: string; proto: string } {
	const scheme = url.indexOf("://")
	return { host: url.slice(scheme + 3, url.indexOf("/", scheme + 3)), proto: url.slice(0, scheme) }
}

export type Upstream = {
	/** `ctx.ip`; `undefined` when no forwarding headers are added. */
	readonly client: string | null | undefined
	readonly websocket: boolean
}

/** The request headers destination is handed: a copy, cleaned, with the forwarding headers set. */
export function upstreamHeaders(request: Request, upstream: Upstream): Headers {
	const headers = new Headers(request.headers)
	dropHopByHop(headers, upstream.websocket)
	if (upstream.websocket) {
		headers.set("upgrade", "websocket")
		headers.set("connection", "upgrade")
	}
	headers.delete("host")
	/* the proxy reads the body itself */
	headers.delete("expect")
	for (const name of FORWARDING) headers.delete(name)
	if (upstream.client !== undefined) {
		const { host, proto } = originParts(request.url)
		if (upstream.client !== null) headers.set("x-forwarded-for", upstream.client)
		headers.set("x-forwarded-proto", proto)
		headers.set("x-forwarded-host", host)
	}
	return headers
}

/**
 * The response headers the client gets, edited in place. `fetch()` hands back a decoded body with
 * the `Content-Encoding` that described the encoded one; when `decoded`, that header and the
 * encoded length go, so the headers describe the bytes the client receives.
 */
export function clientHeaders(headers: Editable, decoded: boolean): void {
	dropHopByHop(headers, false)
	if (!decoded) return
	const encoding = headers.get("content-encoding")
	if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
		headers.delete("content-encoding")
		headers.delete("content-length")
	}
}
