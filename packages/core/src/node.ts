import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { Readable, type Duplex } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Honey } from "./index.ts"
import { isHoneyResponse } from "./honey-response.ts"
import { incomingToNodeRequest } from "./node-request.ts"

type ServeOptions<TEnv> = {
	env: TEnv
	hostname?: string
	port?: number
}

/** Buffer known-size bodies up to this many bytes, then `res.end(buf)`. */
const BUFFER_BODY_MAX = 256 * 1024
const RAW_BODY = Symbol.for("honey.rawBody")

// Node's `Readable.fromWeb` wants `node:stream/web` streams; DOM/Bun brands do not overlap.
function asNodeWebStream(stream: ReadableStream<Uint8Array>): import("node:stream/web").ReadableStream {
	return stream as unknown as import("node:stream/web").ReadableStream
}

function incomingToRequest(req: IncomingMessage): Request {
	return incomingToNodeRequest(req)
}

function collectNodeHeaders(response: Response, extra?: Record<string, string>): Record<string, string | string[]> {
	const headerObj: Record<string, string | string[]> = {}
	let hasSetCookie = false
	response.headers.forEach((value, key) => {
		if (key === "set-cookie") {
			hasSetCookie = true
			return
		}
		headerObj[key] = value
	})
	if (hasSetCookie) {
		const setCookies = response.headers.getSetCookie()
		if (setCookies.length > 0) headerObj["set-cookie"] = setCookies
	}
	if (extra) Object.assign(headerObj, extra)
	return headerObj
}

function shouldBufferBody(response: Response): boolean {
	const rawLen = response.headers.get("content-length")
	if (rawLen !== null) {
		const len = Number(rawLen)
		return Number.isFinite(len) && len <= BUFFER_BODY_MAX
	}
	const ct = response.headers.get("content-type") ?? ""
	if (ct.startsWith("text/event-stream")) return false
	return (
		ct.startsWith("application/json") ||
		ct.startsWith("text/plain") ||
		ct.startsWith("text/html") ||
		ct.startsWith("text/csv") ||
		ct.startsWith("application/xml")
	)
}

function rawBodyOf(response: Response): string | Uint8Array | undefined {
	return (response as Response & { [RAW_BODY]?: string | Uint8Array })[RAW_BODY]
}

async function responseToNode(response: Response, res: ServerResponse): Promise<void> {
	if (isHoneyResponse(response)) {
		const raw = response.rawBody
		if (typeof raw === "string" || raw instanceof Uint8Array) {
			const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
			res.writeHead(response.status, { ...response.plainHeaders, "content-length": String(byteLength) })
			res.end(raw)
			return
		}
		const stream = response.body
		if (stream === null) {
			res.writeHead(response.status, response.plainHeaders)
			res.end()
			return
		}
		res.writeHead(response.status, response.plainHeaders)
		try {
			await pipeline(Readable.fromWeb(asNodeWebStream(stream)), res)
		} catch {
			if (!res.destroyed) res.destroy()
		}
		return
	}

	const raw = rawBodyOf(response)
	if (typeof raw === "string" || raw instanceof Uint8Array) {
		const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
		res.writeHead(response.status, collectNodeHeaders(response, { "content-length": String(byteLength) }))
		res.end(raw)
		return
	}

	const body = response.body
	if (body === null) {
		res.writeHead(response.status, collectNodeHeaders(response))
		res.end()
		return
	}

	if (shouldBufferBody(response)) {
		const buf = Buffer.from(await response.arrayBuffer())
		if (res.destroyed) return
		res.writeHead(response.status, collectNodeHeaders(response, { "content-length": String(buf.byteLength) }))
		res.end(buf)
		return
	}

	res.writeHead(response.status, collectNodeHeaders(response))
	try {
		await pipeline(Readable.fromWeb(asNodeWebStream(body)), res)
	} catch {
		if (!res.destroyed) res.destroy()
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
			const maybe = app.fetch(request, env)
			const response = maybe instanceof Promise ? await maybe : maybe
			await responseToNode(response, res)
		} catch {
			if (!res.headersSent) {
				res.writeHead(500)
				res.end("Internal Server Error")
			} else if (!res.destroyed) {
				res.destroy()
			}
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
			const maybe = app.fetch(request, envWithUpgrade)
			const response = maybe instanceof Promise ? await maybe : maybe

			if (response.status !== 101) {
				const text = await response.text()
				socket.write(
					`HTTP/1.1 ${response.status} ${response.statusText ?? "Error"}\r\n` +
						"content-type: application/json\r\n" +
						`\r\n${text}`,
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
