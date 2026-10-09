import type { Honey } from "./index.ts"
import { cors, type CORSOptions } from "./cors.ts"
import { detectRuntime, type ServeRuntime } from "./detect-runtime.ts"
import { DEFAULT_MAX_REQUEST_BODY } from "./request-limits.ts"
import { setPeerAddress } from "./peer.ts"
import { hasValidHost } from "./trust.ts"
import type { WSAdapter } from "./ws/cloudflare.ts"

export type { ServeRuntime }
export { detectRuntime }

export type ServeHandle = {
	/**
	 * Stop accepting connections, close WebSockets with 1001, and let in-flight requests finish
	 * for up to `timeout` ms (default 1000); then every connection is cut. Same on Node, Bun and Deno.
	 */
	close(timeout?: number): Promise<void>
	hostname: string
	port: number
	runtime: Exclude<ServeRuntime, "cloudflare">
	url: string
}

export type HoneyServeOptions = {
	cors?: boolean | CORSOptions
	env?: Record<string, unknown>
	hostname?: string
	port?: number
	runtime?: ServeRuntime
	/**
	 * Largest request body, in bytes; a bigger one is answered 413. Default 128 MiB on Node and
	 * Bun. Deno has no cap of its own.
	 */
	maxRequestBodySize?: number
	/** Node only: `server.headersTimeout`, ms. */
	headersTimeout?: number
	/** Node only: `server.requestTimeout`, ms. */
	requestTimeout?: number
	/** Node only: `server.keepAliveTimeout`, ms. */
	keepAliveTimeout?: number
	/** Node only: how long an upgrade request may take to become a WebSocket, ms (default 30 000). */
	upgradeTimeout?: number
}

const DEFAULT_CLOSE_TIMEOUT = 1_000

type AppInternals = { _graph: { settings: { wsAdapter: WSAdapter | null } } }

/** The adapter the app already has (`app.wsAdapter(...)`), if any: serve() keeps it. */
function ownAdapter(app: Honey<Record<string, unknown>>): WSAdapter | null {
	return (app as unknown as AppInternals)._graph.settings.wsAdapter
}

/** Settle with `work`, or with `"timeout"` after `ms`; the timer never outlives the race. */
async function within(work: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<"timeout">((r) => {
		timer = setTimeout(() => r("timeout"), ms)
	})
	try {
		return await Promise.race([work.then(() => "done" as const), timeout])
	} finally {
		clearTimeout(timer)
	}
}

const CF_SERVE_ERROR =
	"Honey.serve() cannot run on Cloudflare Workers. Export fetch:\n\n" +
	"export default {\n" +
	"  fetch: (req, env, ctx) => app.fetch(req, env, ctx),\n" +
	"}\n"

function publicHost(hostname: string): string {
	return hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname
}

export async function startHoneyServer(
	app: Honey<Record<string, unknown>>,
	options: HoneyServeOptions = {},
): Promise<ServeHandle> {
	const runtime = options.runtime ?? detectRuntime()
	if (runtime === "cloudflare") {
		throw new Error(CF_SERVE_ERROR)
	}

	const listening: Honey<Record<string, unknown>> = app
	/* app-wide: every route, 404, 405 and preflight run it first — replaced, not stacked, on a re-serve */
	const corsMw = options.cors ? cors(options.cors === true ? undefined : options.cors) : null
	;(app as unknown as { _setGlobal(key: string, mw: unknown): void })._setGlobal("serve:cors", corsMw)

	const hostname = options.hostname ?? (runtime === "deno" ? "127.0.0.1" : "0.0.0.0")
	const port = options.port ?? 3000
	const env = (options.env ?? {}) as Record<string, unknown>

	if (runtime === "bun") {
		const existing = ownAdapter(listening)
		let bunWs: BunWSAdapter
		if (existing === null) {
			const { bunWebSocket } = await import("./ws/bun.ts")
			bunWs = bunWebSocket()
			listening.wsAdapter(bunWs)
		} else if ("websocket" in existing) {
			bunWs = existing as BunWSAdapter
		} else {
			throw new Error("serve() on Bun needs a bunWebSocket() adapter, but app.wsAdapter() was given another one")
		}
		const BunNs = (globalThis as unknown as { Bun: { serve: (opts: Record<string, unknown>) => BunServer } }).Bun
		/* `server` is the same object for every request: build the env once */
		let envWithServer: Record<string, unknown> | null = null
		const server = BunNs.serve({
			fetch: (req: Request, srv: unknown) => {
				if (envWithServer === null) envWithServer = { ...env, server: srv }
				return listening.fetch(req, envWithServer)
			},
			hostname,
			maxRequestBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY,
			port,
			websocket: bunWs.websocket,
		})
		const bound = server.port
		return {
			async close(timeout = DEFAULT_CLOSE_TIMEOUT) {
				bunWs.closeAll?.(1001, "server shutting down")
				/* graceful first: in-flight requests finish; then cut what is left */
				const graceful = Promise.resolve(server.stop(false))
				if ((await within(graceful, timeout)) === "timeout") await Promise.resolve(server.stop(true))
			},
			hostname,
			port: bound,
			runtime,
			url: `http://${publicHost(hostname)}:${bound}`,
		}
	}

	if (runtime === "deno") {
		if (ownAdapter(listening) === null) {
			const { denoWebSocket } = await import("./ws/deno.ts")
			listening.wsAdapter(denoWebSocket())
		}
		const DenoNs = (
			globalThis as unknown as {
				Deno: {
					serve: (
						opts: { hostname: string; port: number; signal?: AbortSignal },
						handler: (req: Request, info: { remoteAddr?: { hostname?: string } }) => Response | Promise<Response>,
					) => { addr?: { port?: number }; finished?: Promise<void>; shutdown?: () => Promise<void> }
				}
			}
		).Deno
		const ac = new AbortController()
		const server = DenoNs.serve({ hostname, port, signal: ac.signal }, (req, info) => {
			/* Deno builds req.url from Host and the target: a `Host: x/admin?` would pick the path */
			if (!hasValidHost(req)) return (listening as unknown as { _badRequestTarget(): Response })._badRequestTarget()
			const peer = info?.remoteAddr?.hostname
			if (typeof peer === "string") setPeerAddress(req, peer)
			return listening.fetch(req, env)
		})
		const bound = server.addr?.port ?? port
		return {
			async close(timeout = DEFAULT_CLOSE_TIMEOUT) {
				ownAdapter(listening)?.closeAll?.(1001, "server shutting down")
				if (server.shutdown) {
					/* graceful: in-flight requests finish. Deno has no forced close, so a request still
					 * running after `timeout` ends on its own (aborting the signal now would throw) */
					await within(server.shutdown(), timeout)
					return
				}
				ac.abort()
				await within(server.finished ?? Promise.resolve(), timeout)
			},
			hostname,
			port: bound,
			runtime,
			url: `http://${publicHost(hostname)}:${bound}`,
		}
	}

	const { serve } = await import("./node.ts")
	if (ownAdapter(listening) === null) {
		const { nodeWebSocket } = await import("./ws/node.ts")
		listening.wsAdapter(nodeWebSocket())
	}
	const server = serve(listening as never, {
		env,
		headersTimeout: options.headersTimeout,
		hostname,
		keepAliveTimeout: options.keepAliveTimeout,
		maxRequestBodySize: options.maxRequestBodySize,
		port,
		requestTimeout: options.requestTimeout,
		upgradeTimeout: options.upgradeTimeout,
	})
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve())
		server.once("error", reject)
	})
	const addr = server.address()
	const bound = typeof addr === "object" && addr !== null ? addr.port : port
	return {
		async close(timeout = DEFAULT_CLOSE_TIMEOUT) {
			await server.shutdown(timeout)
		},
		hostname,
		port: bound,
		runtime: "node",
		url: `http://${publicHost(hostname)}:${bound}`,
	}
}

type BunWSAdapter = WSAdapter & { websocket: Record<string, unknown> }

type BunServer = {
	port: number
	stop(closeActiveConnections?: boolean): void | Promise<void>
}
