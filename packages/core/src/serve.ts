import type { Honey } from "./index.ts"
import { cors, type CORSOptions } from "./cors.ts"
import { detectRuntime, type ServeRuntime } from "./detect-runtime.ts"

export type { ServeRuntime }
export { detectRuntime }

export type ServeHandle = {
	close(): Promise<void>
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

	let listening: Honey<Record<string, unknown>> = app
	if (options.cors) {
		const corsOpts = options.cors === true ? undefined : options.cors
		listening = app.use(cors(corsOpts)) as Honey<Record<string, unknown>>
	}

	const hostname = options.hostname ?? (runtime === "deno" ? "127.0.0.1" : "0.0.0.0")
	const port = options.port ?? 3000
	const env = (options.env ?? {}) as Record<string, unknown>

	if (runtime === "bun") {
		const { bunWebSocket } = await import("./ws/bun.ts")
		const bunWs = bunWebSocket()
		listening.wsAdapter(bunWs)
		const BunNs = (globalThis as unknown as { Bun: { serve: (opts: Record<string, unknown>) => BunServer } }).Bun
		const server = BunNs.serve({
			fetch: (req: Request, server: unknown) => listening.fetch(req, { ...env, server }),
			hostname,
			port,
			websocket: bunWs.websocket,
		})
		const bound = server.port
		return {
			async close() {
				await Promise.resolve(server.stop(true))
			},
			hostname,
			port: bound,
			runtime,
			url: `http://${publicHost(hostname)}:${bound}`,
		}
	}

	if (runtime === "deno") {
		const { denoWebSocket } = await import("./ws/deno.ts")
		listening.wsAdapter(denoWebSocket())
		const DenoNs = (
			globalThis as unknown as {
				Deno: {
					serve: (
						opts: { hostname: string; port: number; signal?: AbortSignal },
						handler: (req: Request) => Response | Promise<Response>,
					) => { addr?: { port?: number }; finished?: Promise<void>; shutdown?: () => Promise<void> }
				}
			}
		).Deno
		const ac = new AbortController()
		const server = DenoNs.serve(
			{ hostname, port, signal: ac.signal },
			(req) => listening.fetch(req, env),
		)
		const bound = server.addr?.port ?? port
		return {
			async close() {
				ac.abort()
				if (server.shutdown) {
					await Promise.race([
						server.shutdown(),
						new Promise<void>((r) => setTimeout(r, 1_000)),
					])
					return
				}
				await Promise.race([
					server.finished ?? Promise.resolve(),
					new Promise<void>((r) => setTimeout(r, 1_000)),
				])
			},
			hostname,
			port: bound,
			runtime,
			url: `http://${publicHost(hostname)}:${bound}`,
		}
	}

	const { nodeWebSocket } = await import("./ws/node.ts")
	const { serve } = await import("./node.ts")
	listening.wsAdapter(nodeWebSocket())
	const server = serve(listening as never, { env, hostname, port })
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve())
		server.once("error", reject)
	})
	const addr = server.address()
	const bound = typeof addr === "object" && addr !== null ? addr.port : port
	return {
		async close() {
			await server.shutdown(1_000)
		},
		hostname,
		port: bound,
		runtime: "node",
		url: `http://${publicHost(hostname)}:${bound}`,
	}
}

type BunServer = {
	port: number
	stop(closeActiveConnections?: boolean): void | Promise<void>
}
