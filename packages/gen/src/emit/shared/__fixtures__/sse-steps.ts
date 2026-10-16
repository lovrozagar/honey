/**
 * The recording server's event streams (stream-server.ts holds the stage they run on, and the
 * WebSockets): a reply's `sse` script written step by step, each step flushed as it comes. A step is
 * raw text, raw bytes or a pause: JS strings cannot split a UTF-8 sequence across two writes, so a
 * `bytes` step carries the bytes themselves (base64), and a parser's split-sequence case is
 * expressible.
 */
import type { ServerResponse } from "node:http"
import type { Stage, StreamRecord } from "./stream-server.ts"

/** Raw text, written and flushed as given (CRLF, CR, a BOM, half an event); raw bytes, base64; or a pause. */
export type SseStep = string | { readonly bytes: string } | { readonly waitMs: number }

/**
 * An event stream: chunked, no content-length, `text/event-stream` unless `contentType`. Its end:
 * `close` finishes the body; `drop` ends the connection once the steps reached it, with no final
 * chunk; `hold` keeps it open until the client leaves or the server closes.
 */
export type SseScript = {
	readonly contentType?: string
	readonly end: "close" | "drop" | "hold"
	readonly steps: readonly SseStep[]
}

/** `step` on `res`: its text or bytes written, resolving once they left; a pause on `stage`. */
async function written(res: ServerResponse, step: SseStep, stage: Stage): Promise<void> {
	if (typeof step !== "string" && "waitMs" in step) return void (await stage.wait(step.waitMs))
	const chunk = typeof step === "string" ? step : Buffer.from(step.bytes, "base64")
	/* a write waits until it left: a `drop` that ends the socket on a write still corked in Node's response loses it */
	await new Promise((flushed) => res.write(chunk, flushed))
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
		if (!ended && !stage.stopped) record.clientGone = true
		ended = true
	})
	res.writeHead(head.status, { "content-type": script.contentType ?? "text/event-stream", ...head.headers })
	res.flushHeaders()
	void (async () => {
		for (const step of script.steps) {
			if (ended) return
			await written(res, step, stage)
		}
		if (ended || script.end === "hold") return
		ended = true
		if (script.end === "close") res.end()
		else res.socket?.end()
	})()
	return record
}
