/**
 * `serve(app, options)` from `@lovrozagar/honey/node`: run the app on Node's `node:http` server. A
 * plain function the server module imports; nothing registers itself (H23). Bun has its own entry,
 * `@lovrozagar/honey/bun`, with the same handle.
 */
import type { Server } from "node:http"
import { DEFAULT_CLOSE_TIMEOUT, DEFAULT_HOSTNAME, type FetchApp, type ServeHandle, urlOf } from "../serve-handle.ts"
import { createNodeServer, type NodeServeOptions } from "./server.ts"

export type { ServeHandle } from "../serve-handle.ts"
export type { NodeServeOptions } from "./server.ts"

/**
 * Starts the app on a `node:http` server and resolves once it listens. Rejects when the server
 * cannot bind, such as a port already in use, and when the app's WebSocket adapter is not
 * `nodeWebSocket()`. `close()` drains: responses already streaming have their signal aborted, and
 * whatever is still running at the timeout is cut.
 */
export async function serve<TEnv>(
	app: FetchApp<TEnv>,
	options: NodeServeOptions<TEnv> = {},
): Promise<ServeHandle<Server>> {
	const server = createNodeServer(app, options)
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve)
		server.once("error", reject)
	})
	const { port } = server.address() as { port: number }
	return {
		close: (timeout = DEFAULT_CLOSE_TIMEOUT) => server.shutdown(timeout),
		port,
		server,
		url: urlOf(options.hostname ?? DEFAULT_HOSTNAME, port),
	}
}
