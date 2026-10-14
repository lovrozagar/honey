/**
 * `serve(app, options)`: run the app on the runtime this process is, through that runtime's
 * adapter. A plain function the app module imports (`@lovrozagar/honey/serve`); nothing registers
 * itself (H23). On Cloudflare Workers the exported app is the Worker, so there is nothing to start.
 */
import { detectRuntime } from "../runtime/detect-runtime.ts"

/** The largest request body a read accepts by default, in bytes: Bun's own default, applied on Node too. */
export const DEFAULT_MAX_REQUEST_BODY = 128 * 1024 * 1024

const DEFAULT_CLOSE_TIMEOUT = 1_000

type FetchApp<TEnv> = { fetch(request: Request, env: TEnv): Response | Promise<Response> }

export type ServeOptions<TEnv> = {
	/** Handed to the app as `ctx.env`. Default `{}`. */
	env?: TEnv
	/** Default `0.0.0.0`: every interface. */
	hostname?: string
	/** Default 3000; `0` picks a free port. */
	port?: number
	/** The largest request body a read accepts, in bytes; over it the answer is 413. Default 128 MiB. */
	maxRequestBodySize?: number
	/** Errors the adapter could not hand to the app (it then answers 500). */
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

export type ServeHandle = {
	/** Stop accepting connections and let in-flight requests finish for up to `timeout` ms (default 1000); then cut every connection. */
	close(timeout?: number): Promise<void>
	readonly hostname: string
	readonly port: number
	readonly runtime: "bun" | "node"
	/** Where a client on this machine reaches the server. */
	readonly url: string
}

/** The address a local client dials: the loopback for a wildcard bind, brackets around IPv6. */
function urlOf(hostname: string, port: number): string {
	const host = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname
	return `http://${host.includes(":") ? `[${host}]` : host}:${port}`
}

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
