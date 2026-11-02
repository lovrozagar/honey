/**
 * `serve(app, options)`: run the app on the runtime this process is, through that runtime's
 * adapter. A plain function the app module imports (`@lovrozagar/honey/serve`); nothing registers
 * itself (H23). On Cloudflare Workers the exported app is the Worker, so there is nothing to start.
 */
import { detectRuntime } from "../runtime/detect-runtime.ts"

/** The largest request body a read accepts by default, in bytes: Bun's own default, applied on Node too. */
export const DEFAULT_MAX_REQUEST_BODY = 128 * 1024 * 1024

const DEFAULT_CLOSE_TIMEOUT = 1_000

/** Anything `serve` can run: an object with a Fetch-style `fetch` handler, such as a honey app. */
type FetchApp<TEnv> = {
	/** Answers one request. `env` is `ServeOptions.env`; on Bun, a copy that also carries the server. */
	fetch(request: Request, env: TEnv): Response | Promise<Response>
}

/** Options for `serve`. The fields marked Node only have no effect on Bun. */
export type ServeOptions<TEnv> = {
	/** Handed to the app as `ctx.env`; on Bun, a copy that also carries the server. Default `{}`. */
	env?: TEnv
	/** Default `0.0.0.0`: every IPv4 interface. */
	hostname?: string
	/** Default 3000; `0` picks a free port. */
	port?: number
	/** The largest request body a read accepts, in bytes; over it the answer is 413. Default 128 MiB. */
	maxRequestBodySize?: number
	/** Errors the adapter could not hand to the app (it then answers 500). Default: the app's logger, or a default logger for a plain fetch handler. */
	onError?: (error: unknown) => void
	/** Node only: `server.headersTimeout`, in ms. */
	headersTimeout?: number
	/** Node only: `server.requestTimeout`, in ms. */
	requestTimeout?: number
	/** Node only: `server.keepAliveTimeout`, in ms. */
	keepAliveTimeout?: number
	/** Node only: how long an upgrade request may take to become a WebSocket or be answered, in ms. Default 30 000. */
	upgradeTimeout?: number
}

/** A running server returned by `serve`. */
export type ServeHandle = {
	/** Stop accepting connections and let in-flight requests finish for up to `timeout` ms (default 1000); then cut every connection. */
	close(timeout?: number): Promise<void>
	/** The hostname as configured, `0.0.0.0` by default. A name or wildcard is not resolved to an address. */
	readonly hostname: string
	/** The port the server listens on; the one the OS picked when `port` was `0`. */
	readonly port: number
	/** The runtime `serve` detected and started the app on. */
	readonly runtime: "bun" | "node"
	/** Where a client on this machine reaches the server. */
	readonly url: string
}

/** The address a local client dials: the loopback for a wildcard bind, brackets around IPv6. */
function urlOf(hostname: string, port: number): string {
	const host = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname
	return `http://${host.includes(":") ? `[${host}]` : host}:${port}`
}

/**
 * Starts the app on the runtime this process runs on (Bun or Node) and resolves once it is
 * listening. Rejects on Cloudflare Workers, where you export the app instead of starting it; when
 * no supported runtime is detected; when the app's WebSocket adapter is for another runtime; and
 * when the server cannot bind, such as a port already in use.
 */
export async function serve<TEnv>(app: FetchApp<TEnv>, options: ServeOptions<TEnv> = {}): Promise<ServeHandle> {
	const runtime = detectRuntime()
	if (runtime === "cloudflare") {
		throw new Error("serve() does not run on Cloudflare Workers: export the app instead (`export default app`)")
	}
	const settings = {
		...options,
		env: options.env ?? ({} as TEnv),
		hostname: options.hostname ?? "0.0.0.0",
		maxRequestBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY,
		port: options.port ?? 3000,
	}
	const listener = runtime === "bun" ? await serveBun(app, settings) : await serveNode(app, settings)
	return {
		close: (timeout = DEFAULT_CLOSE_TIMEOUT) => listener.close(timeout),
		hostname: settings.hostname,
		port: listener.port,
		runtime,
		url: urlOf(settings.hostname, listener.port),
	}
}

type Settings<TEnv> = ServeOptions<TEnv> & { env: TEnv; hostname: string; maxRequestBodySize: number; port: number }
type Listener = { close(timeout: number): Promise<void>; readonly port: number }

/* each adapter loads only on its own runtime, so the other's builtins are never imported */
async function serveBun<TEnv>(app: FetchApp<TEnv>, settings: Settings<TEnv>): Promise<Listener> {
	const { serve: bunServe } = await import("./bun/serve.ts")
	return bunServe(app, settings)
}

async function serveNode<TEnv>(app: FetchApp<TEnv>, settings: Settings<TEnv>): Promise<Listener> {
	const { serve: nodeServe } = await import("./node/serve.ts")
	const server = nodeServe(app, settings)
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve)
		server.once("error", reject)
	})
	return {
		close: (timeout) => server.shutdown(timeout),
		port: (server.address() as { port: number }).port,
	}
}
