/**
 * `serve(app, options)` from `@lovrozagar/honey/bun`: `Bun.serve` with the app's fetch, the server
 * passed in the env so `ctx.ip` and
 * the WebSocket upgrade read it. Bun takes the `websocket` handlers at creation, so a honey app's
 * ws adapter is fixed here: its own `bunWebSocket()`, or one set before `serve()`.
 *
 * A known residual: when a response body stream errors (a proxied upstream cut by its idle
 * timeout, a producer that fails), Bun itself prints the error to stderr, outside both the
 * `error` handler and the app's logger. The stream erroring is correct, since closing it would
 * pass a cut body off as complete; redirecting Bun's own diagnostic would mean wrapping every
 * response body, a per-response cost for a sink change, so it is left as Bun reports it.
 */
import { HoneyError } from "../../errors/error.ts"
import { GRAPH } from "../../routing/app.ts"
import type { HoneyGraph } from "../../routing/register.ts"
import type { AppSettings } from "../../routing/settings.ts"
import { createLogger, type Logger } from "../../telemetry/logger.ts"
import { bunWebSocket, type BunWebSocketHandlers, type BunWSAdapter } from "../../ws/bun.ts"
import {
	DEFAULT_CLOSE_TIMEOUT,
	DEFAULT_HOSTNAME,
	DEFAULT_MAX_REQUEST_BODY,
	DEFAULT_PORT,
	type FetchApp,
	type ServeHandle,
	urlOf,
} from "../serve-handle.ts"

export type { ServeHandle } from "../serve-handle.ts"

/**
 * The server `Bun.serve()` returned, as far as honey vouches for it: these members of Bun's own `Server`, which a
 * `bun-types` program sees in full. Honey cannot name that type itself: its declarations must type-check for an app
 * without `bun-types`. Upgrades go through `ws(app, path)`, so `upgrade` is not offered here.
 */
export type BunServer = {
	/** Requests being handled right now. */
	readonly pendingRequests: number
	/** WebSockets open right now. */
	readonly pendingWebSockets: number
	/** The peer of `request`, as Bun reports it; `null` when it reports none. */
	requestIP(request: Request): {
		/** The peer's IP address. */
		address: string
		/** Which IP version `address` is. */
		family: "IPv4" | "IPv6"
		/** The peer's port. */
		port: number
	} | null
	/** Stop at once, without the drain `close()` gives; `true` also cuts the open connections. */
	stop(closeActiveConnections?: boolean): Promise<void>
	/** The URL Bun reports the server at. */
	readonly url: URL
}

/** What honey itself calls on that server: Bun has `closeIdleConnections`, and a TCP bind always has a port. */
type Listening = BunServer & {
	closeIdleConnections(): void
	readonly port: number
}

type BunGlobal = {
	serve(options: {
		error?: (error: unknown) => Response
		fetch(request: Request, server: BunServer): Response | Promise<Response | undefined> | undefined
		hostname: string
		maxRequestBodySize: number
		port: number
		websocket?: BunWebSocketHandlers
	}): Listening
}

/** Options for `serve` from `@lovrozagar/honey/bun`: where to listen, and what Bun's server is given. */
export type BunServeOptions<TEnv> = {
	/** Handed to the app as `ctx.env`, in a copy that also carries the server. Default `{}`. */
	env?: TEnv
	/** Default `0.0.0.0`: every IPv4 interface. */
	hostname?: string
	/** The largest request body Bun accepts, in bytes; over it the answer is 413. Default 128 MiB. */
	maxRequestBodySize?: number
	/** Errors the app could not answer; Bun then answers 500. Unset, they go to the app's logger, or a default one for a plain fetch handler. */
	onError?: (error: unknown) => void
	/** Default 3000; `0` picks a free port. */
	port?: number
}

/** Settle when `work` does or after `ms`, whichever is first; the timer never outlives it. */
async function within(work: Promise<void>, ms: number): Promise<"done" | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms)
	})
	try {
		return await Promise.race([work.then(() => "done" as const), timeout])
	} finally {
		clearTimeout(timer)
	}
}

const SWAPPED =
	"honey: app.wsAdapter() changed after serve(app) on Bun, where Bun.serve took the first adapter's handlers: set app.wsAdapter() before serve()"

/** The honey app's settings, where its ws adapter lives; `null` for a plain fetch handler. */
function settingsOf(app: unknown): AppSettings | null {
	return (app as { [GRAPH]?: HoneyGraph })[GRAPH]?.settings ?? null
}

/** The app's ws adapter for Bun: the one it was given, else `bunWebSocket()`, set on the app. */
function bunAdapterOf(settings: AppSettings): BunWSAdapter {
	settings.wsAdapter ??= bunWebSocket()
	if (settings.wsAdapter.runtime !== "bun") {
		throw new Error("serve() on Bun needs a bunWebSocket() adapter, but app.wsAdapter() was given another")
	}
	return settings.wsAdapter as BunWSAdapter
}

function isWebSocketUpgrade(request: Request): boolean {
	return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

/** The default failure reporter: the app's logger, or a default one for a plain fetch handler. */
function reportTo(logger: Logger): (error: unknown) => void {
	return (error) => logger.error({ err: HoneyError.serialize(error) }, "serve failed")
}

/** Bun expects nothing back from a fetch that upgraded the request. */
function unlessUpgraded(response: Response): Response | undefined {
	return response.status === 101 ? undefined : response
}

/**
 * Starts the app with `Bun.serve` and resolves once it listens. Rejects when the server cannot bind,
 * such as a port already in use, and when the app's WebSocket adapter is not `bunWebSocket()`.
 * `close()` lets in-flight requests finish, then cuts what is left at the timeout.
 */
export async function serve<TEnv>(
	app: FetchApp<TEnv>,
	options: BunServeOptions<TEnv> = {},
): Promise<ServeHandle<BunServer>> {
	const settings = settingsOf(app)
	const hostname = options.hostname ?? DEFAULT_HOSTNAME
	/* no onError: the app's logger, never Bun's own error page (a stack in development, outside the sink) */
	const onError = options.onError ?? reportTo(settings?.logger ?? createLogger())
	const adapter = settings === null ? null : bunAdapterOf(settings)
	/* the server is the same object on every request: the env carrying it is built once */
	let env: TEnv | undefined
	const server = (globalThis as unknown as { Bun: BunGlobal }).Bun.serve({
		error: (error: unknown) => {
			onError(error)
			return new Response("Internal Server Error", { status: 500 })
		},
		fetch: (request, bun) => {
			/* an adapter set after Bun.serve took the first one's handlers can never upgrade: say so */
			if (settings !== null && settings.wsAdapter !== adapter && isWebSocketUpgrade(request)) throw new Error(SWAPPED)
			const answer = app.fetch(request, (env ??= { ...(options.env ?? ({} as TEnv)), server: bun }))
			return answer instanceof Promise ? answer.then(unlessUpgraded) : unlessUpgraded(answer)
		},
		hostname,
		maxRequestBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY,
		port: options.port ?? DEFAULT_PORT,
		...(adapter === null ? {} : { websocket: adapter.websocket }),
	})
	return {
		async close(timeout = DEFAULT_CLOSE_TIMEOUT) {
			/* graceful first; idle keep-alive connections would otherwise keep serving, so close them
			 * now and again once the in-flight requests have finished and left theirs idle */
			const graceful = server.stop(false)
			server.closeIdleConnections()
			if ((await within(graceful, timeout)) === "timeout") await server.stop(true)
			server.closeIdleConnections()
		},
		port: server.port,
		server,
		url: urlOf(hostname, server.port),
	}
}
