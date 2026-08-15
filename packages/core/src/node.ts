import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer } from "node:http"
import type { Duplex } from "node:stream"
import type { Honey } from "./index.ts"

type ServeOptions<TEnv> = {
	env: TEnv
	hostname?: string
	port?: number
}

function incomingToRequest(req: IncomingMessage): Request {
	const protocol = "http"
	const host = req.headers.host ?? "localhost"
	const url = `${protocol}://${host}${req.url ?? "/"}`

	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v)
		} else {
			headers.set(key, value)
		}
	}

	const method = (req.method ?? "GET").toUpperCase()
	const hasBody = method !== "GET" && method !== "HEAD"

	return new Request(url, {
		body: hasBody
			? new ReadableStream({
					pull() {
						req.resume()
					},
					start(controller) {
						req.pause()
						req.on("data", (chunk: Buffer) => {
							controller.enqueue(new Uint8Array(chunk))
							if (controller.desiredSize !== null && controller.desiredSize <= 0) {
								req.pause()
							}
						})
						req.on("end", () => controller.close())
						req.on("error", (err) => controller.error(err))
					},
				})
			: null,
		duplex: hasBody ? "half" : undefined,
		headers,
		method,
	} as RequestInit)
}

async function responseToNode(response: Response, res: ServerResponse): Promise<void> {
	/* Object.fromEntries loses multiple Set-Cookie headers — handle separately */
	const headerObj: Record<string, string | string[]> = {}
	response.headers.forEach((value, key) => {
		if (key === "set-cookie") return
		headerObj[key] = value
	})
	const setCookies = response.headers.getSetCookie()
	if (setCookies.length > 0) {
		headerObj["set-cookie"] = setCookies
	}
	res.writeHead(response.status, headerObj)

	if (response.body === null) {
		res.end()
		return
	}

	const reader = response.body.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (res.destroyed) break
			const ok = res.write(value)
			if (!ok) {
				await new Promise<void>((resolve) => {
					res.once("drain", resolve)
					res.once("close", resolve)
					res.once("error", resolve)
				})
				if (res.destroyed) break
			}
		}
	} finally {
		res.end()
	}
}

export type HoneyServer = Server & {
	shutdown(timeout?: number): Promise<void>
}

export function serve<TEnv>(
	app: Honey<TEnv, unknown, unknown, unknown, unknown, string, string>,
	options: ServeOptions<TEnv>,
): HoneyServer {
	const env = options.env
	let inflight = 0
	let draining = false
	let drainResolve: (() => void) | null = null

	const server = createServer(async (req, res) => {
		if (draining) {
			res.writeHead(503)
			res.end("Service Unavailable")
			return
		}
		inflight++
		try {
			const request = incomingToRequest(req)
			const response = await app.fetch(request, env)
			await responseToNode(response, res)
		} catch {
			res.writeHead(500)
			res.end("Internal Server Error")
		} finally {
			inflight--
			if (draining && inflight === 0) {
				drainResolve?.()
			}
		}
	})

	/* WebSocket upgrade handling */
	server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		try {
			const request = incomingToRequest(req)
			const envWithUpgrade = { ...env, __nodeUpgrade: { head, req, socket } } as TEnv
			const response = await app.fetch(request, envWithUpgrade)

			if (response.status !== 101) {
				const body = await response.text()
				socket.write(
					`HTTP/1.1 ${response.status} ${response.statusText ?? "Error"}\r\n` +
						"content-type: application/json\r\n" +
						`\r\n${body}`,
				)
				socket.destroy()
			}
		} catch {
			socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n")
			socket.destroy()
		}
	})

	server.listen(options?.port ?? 0, options?.hostname)

	const honeyServer = server as HoneyServer
	honeyServer.shutdown = (timeout?: number): Promise<void> => {
		draining = true

		return new Promise<void>((resolve) => {
			server.close(() => {
				if (inflight === 0) {
					resolve()
					return
				}
				drainResolve = resolve
			})

			if (timeout !== undefined) {
				setTimeout(() => {
					drainResolve = null
					server.closeAllConnections()
					resolve()
				}, timeout)
			}
		})
	}

	return honeyServer
}
