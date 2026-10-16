/**
 * A recording HTTP server for executed-SDK tests, the in-process stand-in for the reference app's
 * wire recorder: two listeners on 127.0.0.1 (`url`, and `alt`, another origin), every request kept
 * as the grid's `WireHop` in arrival order with its raw body beside it, each answered by the next
 * scripted reply (200 `{}` once the script runs out). A compiled SDK runs in a child process, so the
 * server answers while it waits. A reply may stream (stream-server.ts): an event stream, or a
 * WebSocket an upgrade request is accepted into; an upgrade request is a hop like any other, and
 * any reply without `ws` refuses its handshake as plain HTTP.
 */
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import {
	acceptUpgrade,
	refuseUpgrade,
	type SseScript,
	type Stage,
	type StreamRecord,
	serveSse,
	streamStage,
	type WsScript,
} from "./stream-server.ts"

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
 * and a redirect target (`location`, on either listener). Every body goes out with its length. In
 * place of a body: `sse`, an event stream under the status and headers, or `ws` (status 101), the
 * upgrade accepted and the socket scripted.
 */
export type Reply = {
	readonly bytes?: number
	readonly delayMs?: number
	readonly headers?: Readonly<Record<string, string>>
	readonly json?: Json
	readonly redirect?: { readonly origin: RecordedHop["origin"]; readonly path: string }
	readonly sse?: SseScript
	readonly status: number
	readonly text?: string
	readonly ws?: WsScript
}

export type RecordingServer = {
	readonly alt: string
	/** each request's raw body, parallel to `hops` */
	readonly bodies: readonly Buffer[]
	/** stop every stream and close both listeners; rejects with the protocol violations a stream saw */
	close(): Promise<void>
	/** every request received so far, in arrival order */
	readonly hops: readonly RecordedHop[]
	/**
	 * each request's header lines as sent, parallel to `hops`: `[name lower case, value]` once per line, so a
	 * repeated header Node's `req.headers` keeps one of (`authorization`) shows each time it came
	 */
	readonly rawHeaders: readonly (readonly (readonly [string, string])[])[]
	/** each hop's stream as it runs, parallel to `hops`; undefined for a hop answered without one */
	readonly streams: readonly (StreamRecord | undefined)[]
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

/** The request's header lines as sent (`req.rawHeaders`), names lower case. */
function linesOf(req: IncomingMessage): [string, string][] {
	const lines: [string, string][] = []
	for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
		lines.push([(req.rawHeaders[i] as string).toLowerCase(), req.rawHeaders[i + 1] as string])
	return lines
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

/** The reply's body and every header it goes out with: its length, the implied ones, a redirect's location. */
function messageOf(reply: Reply, origins: Origins): [Buffer | string, Record<string, string>] {
	const [body, implied] = payloadOf(reply)
	const length = { "content-length": String(Buffer.byteLength(body)) }
	const location = reply.redirect && { location: `${origins[reply.redirect.origin]}${reply.redirect.path}` }
	return [body, { ...length, ...implied, ...location, ...reply.headers }]
}

/** Answer `res` with `reply`, unless the client already went away; the stream it opened, if any. */
function answer(res: ServerResponse, reply: Reply, origins: Origins, stage: Stage): StreamRecord | undefined {
	if (res.destroyed) return undefined
	if (reply.sse !== undefined) return serveSse(res, reply, reply.sse, stage)
	if (reply.ws !== undefined) {
		stage.violation(`${res.req.method} ${res.req.url}: a ws reply to a request that is no upgrade`)
		res.writeHead(500).end()
		return undefined
	}
	const [body, headers] = messageOf(reply, origins)
	res.writeHead(reply.status, headers)
	res.end(body)
	return undefined
}

/** Answer the upgrade request `req` with `reply`: accepted into its `ws` script, or refused as plain HTTP. */
function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, at: Answering): StreamRecord | undefined {
	const { origins, reply, stage } = at
	if (reply.ws !== undefined) return acceptUpgrade(req, socket, head, { headers: reply.headers, stage, ws: reply.ws })
	if (reply.sse !== undefined) stage.violation(`${req.method} ${req.url}: an sse reply to an upgrade request`)
	const [body, headers] = messageOf(reply, origins)
	refuseUpgrade(socket, reply.status, headers, body)
	return undefined
}
type Answering = { readonly origins: Origins; readonly reply: Reply; readonly stage: Stage }

/** `replies`, refused when one names more than one body (a stream is one), or `ws` without 101: which would win is no test's business. */
function checked(replies: readonly Reply[]): readonly Reply[] {
	for (const [i, reply] of replies.entries()) {
		const bodies = [reply.json, reply.text, reply.bytes, reply.sse, reply.ws].filter((body) => body !== undefined)
		if (bodies.length > 1) throw new Error(`reply ${i} names ${bodies.length} bodies; give at most one`)
		if (reply.ws !== undefined && reply.status !== 101)
			throw new Error(`reply ${i} accepts a WebSocket with status 101`)
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
	const rawHeaders: [string, string][][] = []
	const bodies: Buffer[] = []
	const streams: (StreamRecord | undefined)[] = []
	const stage = streamStage()
	const origins: Record<RecordedHop["origin"], string> = { alt: "", primary: "" }
	/* record the hop, then run `respond` with its reply once the reply's delay passed */
	const record = (
		req: IncomingMessage,
		hop: RecordedHop,
		body: Buffer,
		respond: (reply: Reply) => StreamRecord | undefined,
	) => {
		const index = hops.push(hop) - 1
		rawHeaders.push(linesOf(req))
		bodies.push(body)
		streams.push(undefined)
		const reply = replies[index] ?? { json: {}, status: 200 }
		const run = () => void (streams[index] = respond(reply))
		if (reply.delayMs === undefined) run()
		else void stage.wait(reply.delayMs).then((passed) => passed && run())
	}
	const serve = (origin: RecordedHop["origin"]) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				const body = Buffer.concat(chunks)
				record(req, hopOf(req, body, origin), body, (reply) => answer(res, reply, origins, stage))
			})
		})
		server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
			stage.hold(socket)
			const empty = Buffer.alloc(0)
			record(req, hopOf(req, empty, origin), empty, (reply) => upgrade(req, socket, head, { origins, reply, stage }))
		})
		return server
	}
	const primary = serve("primary")
	const other = serve("alt")
	const [url, alt] = await Promise.all([listen(primary), listen(other)])
	origins.primary = url as string
	origins.alt = alt as string
	return {
		alt: origins.alt,
		bodies,
		close: async () => {
			const violations = stage.stop()
			await Promise.all([close(primary), close(other)])
			if (violations.length > 0) throw new Error(`the stream server saw protocol violations:\n${violations.join("\n")}`)
		},
		hops,
		rawHeaders,
		streams,
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
