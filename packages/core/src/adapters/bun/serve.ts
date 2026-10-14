/** The Bun adapter: `Bun.serve` with the app's fetch, the server passed in the env so `ctx.ip` reads it. */

type FetchApp<TEnv> = { fetch(request: Request, env: TEnv): Response | Promise<Response> }

type BunServer = {
	closeIdleConnections(): void
	readonly port: number
	stop(closeActiveConnections: boolean): Promise<void>
}

type BunGlobal = {
	serve(options: {
		error?: (error: unknown) => Response
		fetch(request: Request, server: BunServer): Response | Promise<Response>
		hostname: string
		maxRequestBodySize: number
		port: number
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

export function serve<TEnv>(app: FetchApp<TEnv>, options: BunServeOptions<TEnv>): BunListener {
	const { onError } = options
	/* the server is the same object on every request: the env carrying it is built once */
	let env: TEnv | undefined
	const server = (globalThis as unknown as { Bun: BunGlobal }).Bun.serve({
		...(onError === undefined
			? {}
			: {
					error: (error: unknown) => {
						onError(error)
						return new Response("Internal Server Error", { status: 500 })
					},
				}),
		fetch: (request, bun) => app.fetch(request, (env ??= { ...options.env, server: bun })),
		hostname: options.hostname,
		maxRequestBodySize: options.maxRequestBodySize,
		port: options.port,
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
