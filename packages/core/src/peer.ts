/**
 * The address of the TCP peer of a request, as the runtime reports it. Adapters register it;
 * `ctx.ip` reads it through the app's trust setting (`trust.ts`).
 *
 * - Node (`serve()` from `/node`): the socket's `remoteAddress`
 * - Bun: `server.requestIP(req)`, whether `serve()` or `Bun.serve({ fetch: app.fetch })` passed the server
 * - Deno: `info.remoteAddr`, whether `serve()` or `Deno.serve(app.fetch)` passed the info
 * - Cloudflare Workers: `CF-Connecting-IP`, which the edge sets and a client cannot
 */

type PeerSource = string | (() => string | null)

const peers = new WeakMap<object, PeerSource>()

/** A request object can report its own peer under this key (the Node shim does, allocation-free). */
export const PEER_ADDRESS = Symbol.for("honey.peerAddress")

/** Called by adapters before `app.fetch`. A function is called at most once, on first read. */
export function setPeerAddress(req: Request, address: PeerSource): void {
	peers.set(req, address)
}

function isWorkers(): boolean {
	return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers"
}

type BunServerLike = { requestIP?: (req: Request) => { address?: string } | null }

export function peerAddressOf(req: Request, env: unknown): string | null {
	const own = (req as unknown as Record<symbol, unknown>)[PEER_ADDRESS]
	if (typeof own === "string") return own
	const registered = peers.get(req)
	if (registered !== undefined) {
		if (typeof registered === "string") return registered === "" ? null : registered
		const resolved = registered()
		peers.set(req, resolved ?? "")
		return resolved
	}
	if (env !== null && typeof env === "object") {
		const e = env as BunServerLike & { server?: BunServerLike; remoteAddr?: { hostname?: unknown } }
		const server = typeof e.requestIP === "function" ? e : e.server
		if (server !== undefined && typeof server.requestIP === "function") {
			try {
				return server.requestIP(req)?.address ?? null
			} catch {
				return null
			}
		}
		if (typeof e.remoteAddr?.hostname === "string") return e.remoteAddr.hostname
	}
	if (isWorkers()) return req.headers.get("cf-connecting-ip")
	return null
}
