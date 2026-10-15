/**
 * A recording HTTP server for executed-SDK tests, the in-process stand-in for the reference app's
 * wire recorder: two listeners on 127.0.0.1 (`url`, and `alt`, another origin), every request kept
 * as the grid's `WireHop` in arrival order with its raw body beside it, each answered by the next
 * scripted reply (200 `{}` once the script runs out). A compiled SDK runs in a child process, so the
 * server answers while it waits.
 */
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/** A JSON value, as the grid's `Json` spells it. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

/** One request as the grid's `WireHop` holds it (tests/integration/conformance/matrix.ts; a test pins the two together). */
export type RecordedHop = {
	readonly body: {
		readonly contentType: string | null
		readonly json?: Json
		readonly sha256: string
		readonly size: number
	}
	readonly headers: Readonly<Record<string, string>>
	readonly method: string
	readonly origin: "alt" | "primary"
	readonly url: string
}

/**
 * One scripted answer: its status, at most one body (`json` with its content-type; `text` as given
 * and `bytes`, that many bytes `i & 0xff`, with none added), extra headers, a wait before answering
 * and a redirect target (`location`, on either listener). Every body goes out with its length.
 */
export type Reply = {
	readonly bytes?: number
	readonly delayMs?: number
	readonly headers?: Readonly<Record<string, string>>
	readonly json?: Json
	readonly redirect?: { readonly origin: RecordedHop["origin"]; readonly path: string }
	readonly status: number
	readonly text?: string
}

export type RecordingServer = {
	readonly alt: string
	/** each request's raw body, parallel to `hops` */
	readonly bodies: readonly Buffer[]
	close(): Promise<void>
	/** every request received so far, in arrival order */
	readonly hops: readonly RecordedHop[]
	readonly url: string
}

/** Both listeners' origins, by the name a hop and a redirect give them. */
type Origins = Readonly<Record<RecordedHop["origin"], string>>

/** A request's body as a hop records it: its media type, size, digest, and its JSON when it parses. */
function bodyOf(bytes: Buffer, contentType: string | undefined): RecordedHop["body"] {
	const body = {
		contentType: contentType ?? null,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		size: bytes.byteLength,
	}
	try {
		return bytes.byteLength === 0 ? body : { ...body, json: JSON.parse(bytes.toString("utf8")) as Json }
	} catch {
		return body
	}
}

/** The request as a hop: header names lower case, a repeated header joined with `, `. */
function hopOf(req: IncomingMessage, bytes: Buffer, origin: RecordedHop["origin"]): RecordedHop {
	const headers: Record<string, string> = {}
	for (const [name, value] of Object.entries(req.headers))
		if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value
	return {
		body: bodyOf(bytes, req.headers["content-type"]),
		headers,
		method: req.method ?? "",
		origin,
		url: req.url ?? "",
	}
}

/** The reply's body and the headers it implies: JSON with its content-type, text or bytes as they are. */
function payloadOf(reply: Reply): [Buffer | string, Record<string, string>] {
	if (reply.json !== undefined) return [JSON.stringify(reply.json), { "content-type": "application/json" }]
	if (reply.bytes !== undefined) return [Buffer.from(Array.from({ length: reply.bytes }, (_, i) => i & 0xff)), {}]
	return [reply.text ?? "", {}]
}

/** Answer `res` with `reply`, unless the client already went away. */
function answer(res: ServerResponse, reply: Reply, origins: Origins): void {
	if (res.destroyed) return
	const [body, implied] = payloadOf(reply)
	const length = { "content-length": String(Buffer.byteLength(body)) }
	const location = reply.redirect && { location: `${origins[reply.redirect.origin]}${reply.redirect.path}` }
	res.writeHead(reply.status, { ...length, ...implied, ...location, ...reply.headers })
	res.end(body)
}

/** `replies`, refused when one names more than one body: which would win is no test's business. */
function checked(replies: readonly Reply[]): readonly Reply[] {
	for (const [i, reply] of replies.entries()) {
		const bodies = [reply.json, reply.text, reply.bytes].filter((body) => body !== undefined)
		if (bodies.length > 1) throw new Error(`reply ${i} names ${bodies.length} bodies; give at most one`)
	}
	return replies
}

/** A listener on 127.0.0.1 at a free port; resolves with its origin. */
function listen(server: Server): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
	})
}

/** Close `server` and every connection it holds; resolves once it closed. */
function close(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.closeAllConnections()
		server.close(() => resolve())
	})
}

/** Start the two listeners, recording every request and answering the `replies` in order. */
export async function recordingServer(replies: readonly Reply[]): Promise<RecordingServer> {
	checked(replies)
	const hops: RecordedHop[] = []
	const bodies: Buffer[] = []
	const timers = new Set<NodeJS.Timeout>()
	const origins: Record<RecordedHop["origin"], string> = { alt: "", primary: "" }
	const serve = (origin: RecordedHop["origin"]) =>
		createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				bodies.push(Buffer.concat(chunks))
				hops.push(hopOf(req, bodies.at(-1) as Buffer, origin))
				const reply = replies[hops.length - 1] ?? { json: {}, status: 200 }
				if (reply.delayMs === undefined) {
					answer(res, reply, origins)
					return
				}
				const timer = setTimeout(() => {
					timers.delete(timer)
					answer(res, reply, origins)
				}, reply.delayMs)
				timers.add(timer)
			})
		})
	const primary = serve("primary")
	const other = serve("alt")
	const [url, alt] = await Promise.all([listen(primary), listen(other)])
	origins.primary = url as string
	origins.alt = alt as string
	return {
		alt: origins.alt,
		bodies,
		close: async () => {
			for (const timer of timers) clearTimeout(timer)
			await Promise.all([close(primary), close(other)])
		},
		hops,
		url: origins.primary,
	}
}

/** `use` with a recording server answering `replies`, closed after it whatever it does. */
export async function served<T>(replies: readonly Reply[], use: (server: RecordingServer) => Promise<T>): Promise<T> {
	const server = await recordingServer(replies)
	try {
		return await use(server)
	} finally {
		await server.close()
	}
}
