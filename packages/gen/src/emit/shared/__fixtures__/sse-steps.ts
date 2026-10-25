/**
 * The recording server's event streams (stream-server.ts holds the stage they run on, and the
 * WebSockets): a reply's `sse` script written step by step, each step flushed as it comes. A step is
 * raw text, raw bytes, a pause, or a latch the test opens: JS strings cannot split a UTF-8 sequence across two writes, so a
 * `bytes` step carries the bytes themselves (base64), and a parser's split-sequence case is
 * expressible.
 */
import type { ServerResponse } from "node:http"
import { constants, createDeflate, createGzip } from "node:zlib"
import type { Stage, StreamRecord } from "./stream-server.ts"

/** Raw text, written and flushed as given (CRLF, CR, a BOM, half an event); raw bytes, base64; a pause; or a latch. */
export type SseStep =
	| string
	| { readonly bytes: string }
	| { readonly waitMs: number }
	/* the next step waits until the test's latch opens: a client's own signal, never a timer */
	| { readonly after: () => Promise<unknown> }

/**
 * An event stream: chunked, no content-length, `text/event-stream` unless `contentType`. Its end:
 * `close` finishes the body; `drop` ends the connection once the steps reached it, with no final
 * chunk; `hold` keeps it open until the client leaves or the server closes. `encoding` sends it
 * gzip- or deflate-encoded, each step sync-flushed, so a step still arrives as it is written.
 */
export type SseScript = {
	readonly contentType?: string
	readonly encoding?: "deflate" | "gzip"
	readonly end: "close" | "drop" | "hold"
	readonly steps: readonly SseStep[]
}

/** Where a stream's bytes go: written and flushed, resolving once they left; then the body's end. */
type Sink = { readonly end: () => void; readonly write: (chunk: Buffer | string) => Promise<unknown> }

/** `res` as a sink, through a sync-flushed gzip or deflate encoder under `encoding`. */
function sinkOf(res: ServerResponse, encoding: SseScript["encoding"]): Sink {
	if (encoding === undefined)
		/* a write waits until it left: a `drop` that ends the socket on a write still corked in Node's response loses it */
		return { end: () => res.end(), write: (chunk) => new Promise((flushed) => res.write(chunk, flushed)) }
	const encoder = encoding === "gzip" ? createGzip() : createDeflate()
	encoder.pipe(res)
	return {
		end: () => encoder.end(),
		write: (chunk) =>
			new Promise((flushed) => {
				encoder.write(chunk)
				encoder.flush(constants.Z_SYNC_FLUSH, () => flushed(undefined))
			}),
	}
}

/** `step` into `sink`: its text or bytes written, resolving once they left; a pause on `stage`. */
async function written(sink: Sink, step: SseStep, stage: Stage): Promise<void> {
	if (typeof step !== "string" && "waitMs" in step) return void (await stage.wait(step.waitMs))
	if (typeof step !== "string" && "after" in step) return void (await step.after())
	await sink.write(typeof step === "string" ? step : Buffer.from(step.bytes, "base64"))
}

/** Serve `script` on `res` with `status` and `headers` (over the default content-type); its record. */
export function serveSse(
	res: ServerResponse,
	head: { readonly headers?: Readonly<Record<string, string>>; readonly status: number },
	script: SseScript,
	stage: Stage,
): StreamRecord {
	const record: StreamRecord = { clientGone: false, received: [] }
	let ended = false
	res.once("close", () => {
		if (!ended && !stage.stopped) stage.leave(record)
		ended = true
	})
	const encoded = script.encoding === undefined ? {} : { "content-encoding": script.encoding }
	res.writeHead(head.status, {
		"content-type": script.contentType ?? "text/event-stream",
		...encoded,
		...head.headers,
	})
	res.flushHeaders()
	const sink = sinkOf(res, script.encoding)
	void (async () => {
		for (const step of script.steps) {
			if (ended) return
			await written(sink, step, stage)
		}
		if (ended || script.end === "hold") return
		ended = true
		if (script.end === "close") sink.end()
		else res.socket?.end()
	})()
	return record
}
