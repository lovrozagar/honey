/**
 * The Bun adapter: `Bun.serve` with the app's fetch, the server passed in the env so `ctx.ip` and
 * the WebSocket upgrade read it. Bun takes the `websocket` handlers at creation, so a honey app's
 * ws adapter is fixed here: its own `bunWebSocket()`, or one set before `serve()`.
 */
import { HoneyError } from "../../errors/error.ts"
import { GRAPH } from "../../routing/app.ts"
import type { HoneyGraph } from "../../routing/register.ts"
import type { AppSettings } from "../../routing/settings.ts"
import { createLogger, type Logger } from "../../telemetry/logger.ts"
import { bunWebSocket, type BunWebSocketHandlers, type BunWSAdapter } from "../../ws/bun.ts"

type FetchApp<TEnv> = { fetch(request: Request, env: TEnv): Response | Promise<Response> }

type BunServer = {
	closeIdleConnections(): void
	readonly port: number
	stop(closeActiveConnections: boolean): Promise<void>
}

type BunGlobal = {
	serve(options: {
		error?: (error: unknown) => Response
		fetch(request: Request, server: BunServer): Response | Promise<Response | undefined> | undefined
		hostname: string
		maxRequestBodySize: number
		port: number
		websocket?: BunWebSocketHandlers
	}): BunServer
}

export type BunServeOptions<TEnv> = {
	env: TEnv
	hostname: string
	maxRequestBodySize: number
	/** Errors the app could not answer; Bun then answers 500. Unset, Bun's own error handling applies. */
	onError?: (error: unknown) => void
	port: number
}

export type BunListener = {
	/** Let in-flight requests finish for up to `timeout` ms, then cut every connection. */
	close(timeout: number): Promise<void>
	readonly port: number
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

/** Bun expects nothing back from a fetch that upgraded the request. */
/** The default failure reporter: the app's logger, or a default one for a plain fetch handler. */
function reportTo(logger: Logger): (error: unknown) => void {
	return (error) => logger.error({ err: HoneyError.serialize(error) }, "serve failed")
}

function unlessUpgraded(response: Response): Response | undefined {
	return response.status === 101 ? undefined : response
}

export function serve<TEnv>(app: FetchApp<TEnv>, options: BunServeOptions<TEnv>): BunListener {
	const settings = settingsOf(app)
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
			const answer = app.fetch(request, (env ??= { ...options.env, server: bun }))
			return answer instanceof Promise ? answer.then(unlessUpgraded) : unlessUpgraded(answer)
		},
		hostname: options.hostname,
		maxRequestBodySize: options.maxRequestBodySize,
		port: options.port,
		...(adapter === null ? {} : { websocket: adapter.websocket }),
	})
	return {
		async close(timeout) {
			/* graceful first; idle keep-alive connections would otherwise keep serving, so close them
			 * now and again once the in-flight requests have finished and left theirs idle */
			const graceful = server.stop(false)
			server.closeIdleConnections()
			if ((await within(graceful, timeout)) === "timeout") await server.stop(true)
			server.closeIdleConnections()
		},
		port: server.port,
	}
}
