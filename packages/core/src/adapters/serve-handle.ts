/**
 * What the two `serve` entries share: `@lovrozagar/honey/node` and `@lovrozagar/honey/bun` each start
 * the app on their own runtime and answer the same `ServeHandle`, the runtime's own server on it.
 * There is no detection: a server process knows its runtime, so it imports that runtime's entry. On
 * Cloudflare Workers the exported app is the Worker, so there is nothing to start.
 */

/** The largest request body a read accepts by default, in bytes: Bun's own default, applied on Node too. */
export const DEFAULT_MAX_REQUEST_BODY = 128 * 1024 * 1024

/** Every IPv4 interface. */
export const DEFAULT_HOSTNAME = "0.0.0.0"

export const DEFAULT_PORT = 3000

export const DEFAULT_CLOSE_TIMEOUT = 1_000

/** Anything `serve` can run: an object with a Fetch-style `fetch` handler, such as a honey app. */
export type FetchApp<TEnv> = {
	/** Answers one request. `env` is the `env` option; on Bun, a copy that also carries the server. */
	fetch(request: Request, env: TEnv): Response | Promise<Response>
}

/** A running server, as `serve` answers it once the server listens. */
export type ServeHandle<TServer> = {
	/** Stop accepting connections and let in-flight requests finish for up to `timeout` ms (default 1000); then cut every connection. */
	close(timeout?: number): Promise<void>
	/** The port the server listens on; the one the OS picked when `port` was `0`. */
	readonly port: number
	/** The runtime's own server: Node's `http.Server`, or what `Bun.serve()` returned. */
	readonly server: TServer
	/** Where a client on this machine reaches the server. */
	readonly url: string
}

/** The address a local client dials: the loopback for a wildcard bind, brackets around IPv6. */
export function urlOf(hostname: string, port: number): string {
	const host = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname
	return `http://${host.includes(":") ? `[${host}]` : host}:${port}`
}
