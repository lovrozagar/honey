/**
 * A recording HTTP server for executed-SDK tests, the in-process stand-in for the reference app's
 * wire recorder: two listeners on 127.0.0.1 (`url`, and `alt`, another origin), every request kept
 * as the grid's `WireHop` in arrival order, each answered by the next scripted reply (200 `{}` once
 * the script runs out). A compiled SDK runs in a child process, so the server answers while it waits.
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

/** One scripted answer: its status, a JSON body, extra headers. */
export type Reply = {
	readonly headers?: Readonly<Record<string, string>>
	readonly json?: Json
	readonly status: number
}

export type RecordingServer = {
	readonly alt: string
	close(): Promise<void>
	/** every request received so far, in arrival order */
	readonly hops: readonly RecordedHop[]
	readonly url: string
}

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

/** Answer `res` with `reply`: a JSON body when it has one. */
function answer(res: ServerResponse, reply: Reply): void {
	const text = reply.json === undefined ? "" : JSON.stringify(reply.json)
	const type: Record<string, string> = reply.json === undefined ? {} : { "content-type": "application/json" }
	res.writeHead(reply.status, { ...type, ...reply.headers })
	res.end(text)
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
	const hops: RecordedHop[] = []
	const serve = (origin: RecordedHop["origin"]) =>
		createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				hops.push(hopOf(req, Buffer.concat(chunks), origin))
				answer(res, replies[hops.length - 1] ?? { json: {}, status: 200 })
			})
		})
	const primary = serve("primary")
	const other = serve("alt")
	const [url, alt] = await Promise.all([listen(primary), listen(other)])
	return {
		alt: alt as string,
		close: async () => void (await Promise.all([close(primary), close(other)])),
		hops,
		url: url as string,
	}
}
