/**
 * Who sent a request, and over what, as the core sees it without `app.trustProxy()`: the peer the
 * runtime reports is the client, and forwarding headers are client-controlled text. Trusting
 * reverse proxies (hop counts, address lists) lives in `trust.ts`, the optional `./trust` entry.
 */
import { canonicalIp, parseIp } from "./ip.ts"

export type ClientInfo = {
	/** the host the client asked for (`host[:port]`), or `null` */
	host: string | null
	/** the canonical client address, or `null` when it is unknown or a trusted header holds garbage */
	ip: string | null
	protocol: "http" | "https"
	/**
	 * whether `ip` came from an `X-Forwarded-For` entry a trusted proxy wrote, not from the peer
	 * (H18.4): what `requestId` reuse and `traceparent` continuation gate on
	 */
	trustsForwarded: boolean
}

/** The app's compiled `trustProxy()` setting. Anything but `off` carries its own resolver, so the core never imports it. */
export type TrustSetting =
	| { readonly kind: "off" }
	| { readonly kind: "hops" | "ranges"; readonly resolve: (req: Request, peer: string | null) => ClientInfo }

export const TRUST_OFF: TrustSetting = /* @__PURE__ */ Object.freeze({ kind: "off" })

/**
 * An adapter whose request knows its peer reports it under this key, allocation-free: the Node
 * adapter's request reads its socket's `remoteAddress`.
 */
export const PEER_ADDRESS: unique symbol = /* @__PURE__ */ Symbol.for("honey.peerAddress")

/* dot-separated labels, none starting or ending with a hyphen, and an optional root dot */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/
const PORT = /^\d{1,5}$/

/** `host[:port]` as RFC 9110 allows it in `Host`: nothing that could change a URL's meaning. */
export function isValidHost(host: string): boolean {
	let name = host
	let port: string | null = null
	if (host.startsWith("[")) {
		const close = host.indexOf("]")
		if (close === -1 || parseIp(host.slice(1, close))?.v !== 6) return false
		const after = host.slice(close + 1)
		if (after === "") return true
		if (!after.startsWith(":")) return false
		port = after.slice(1)
		name = ""
	} else {
		const colon = host.indexOf(":")
		if (colon !== -1) {
			name = host.slice(0, colon)
			port = host.slice(colon + 1)
		}
		if (!NAME.test(name)) return false
	}
	return port === null || (PORT.test(port) && Number(port) <= 65535)
}

type BunServerLike = { requestIP?: (req: Request) => { address?: string } | null }

/** Workers is the one runtime whose edge sets the peer in a header a client cannot send. */
function onWorkers(): boolean {
	return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers"
}

/**
 * The peer the runtime reports for `req`: the address an adapter set under `PEER_ADDRESS`, a Bun
 * server's `requestIP` when the server is the env (`Bun.serve({ fetch: app.fetch })`) or
 * `env.server`, or `CF-Connecting-IP` on Workers. `null` when nothing reports one.
 */
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

/** The authority of a request URL, or `null` when it has none (`file:///x`); a parsed URL always has a path. */
function hostOfUrl(url: string): string | null {
	const start = url.indexOf("//") + 2
	const host = url.slice(start, url.indexOf("/", start))
	return host === "" ? null : host
}

/** The client as the connection shows it: the canonical peer, the URL's host, the transport's scheme. */
export function directClientInfo(req: Request, peer: string | null): ClientInfo {
	return {
		host: hostOfUrl(req.url),
		ip: peer === null ? null : canonicalIp(peer),
		protocol: req.url.startsWith("https:") ? "https" : "http",
		trustsForwarded: false,
	}
}

/** The client of `req` under `trust`: the same answer `ctx.ip` and `clientInfo()` give. */
export function resolveClient(trust: TrustSetting, req: Request, peer: string | null): ClientInfo {
	return trust.kind === "off" ? directClientInfo(req, peer) : trust.resolve(req, peer)
}

/**
 * What one request carries for client resolution: the request, the env (which may be a Bun
 * server), the serving app's trust setting, and the resolved client once something asked.
 */
export type ClientSource = {
	readonly env: unknown
	readonly req: Request
	readonly trust?: TrustSetting
	client?: ClientInfo
}

/**
 * The client of a request, resolved on first read and kept on its state: however many readers
 * ask (`ctx.ip`, `clientInfo()`, loggers, `proxy()`), headers are read once and never cloned.
 */
export function clientOf(source: ClientSource): ClientInfo {
	source.client ??= resolveClient(source.trust ?? TRUST_OFF, source.req, peerAddressOf(source.req, source.env))
	return source.client
}

/** Where a context exposes its client; `clientInfo(ctx)` reads it without importing the context. */
export const CLIENT: unique symbol = /* @__PURE__ */ Symbol("honey.client")

/** The client address, scheme and host of the request `ctx` serves, under the app's `trustProxy()`. */
export function clientInfo(ctx: { readonly [CLIENT]: ClientInfo }): ClientInfo {
	return ctx[CLIENT]
}
