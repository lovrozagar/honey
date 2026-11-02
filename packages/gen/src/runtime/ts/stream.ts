import type { RequestMeta } from "./config.ts"
import { type Call, CONFIG, type HTTPClient, SEND } from "./http.ts"
import { parseMediaType } from "./media-type.ts"
import type { RequestOptions } from "./request.ts"
import { type Answer, errorFromResponse, finishRequest, type Sent } from "./response.ts"
import { parseSSEStream, type SSEEvent } from "./sse.ts"

/** An event stream's call: its stale view, and what runs once its answer is ok. */
export type StreamCall = Call & { meta?: RequestMeta | undefined; onOpen?: ((response: Response) => void) | undefined }

/** Whether `response` answers with an event stream. */
export function isEventStream(response: Response): boolean {
	return parseMediaType(response.headers.get("content-type"))?.essence === "text/event-stream"
}

/** An event stream sent when its iteration starts: `open`'s events. */
export const later = (open: () => Promise<Answer>): AsyncIterable<SSEEvent> => ({
	async *[Symbol.asyncIterator]() {
		yield* (await open()).data as AsyncIterable<SSEEvent>
	},
})

/** The events of a sent stream, read as they arrive; the request is done when iteration ends. */
function iterate(http: HTTPClient, sent: Sent): AsyncIterable<SSEEvent> {
	const config = http[CONFIG]
	const caps = { maxEventBytes: config.sseMaxEventBytes, maxLineBytes: config.sseMaxLineBytes }
	return {
		async *[Symbol.asyncIterator]() {
			try {
				if (sent.response.body) yield* parseSSEStream(sent.response.body, { ...caps, failed: sent.failed })
			} finally {
				sent.done()
			}
		},
	}
}

/**
 * One request whose shape is decided by the answer: an event stream becomes an
 * `AsyncIterable<SSEEvent>` (never buffered, exempt from the timeout once headers arrive);
 * anything else is read as in `request`.
 */
export async function requestAuto(
	http: HTTPClient,
	method: string,
	path: string,
	opts: RequestOptions,
): Promise<Answer> {
	const sent = await http[SEND]({ method, opts, path }, "auto")
	if (!sent.response.ok || !isEventStream(sent.response) || opts.raw)
		return finishRequest(sent, { limits: http[CONFIG], method, raw: opts.raw })
	sent.exemptFromTimeout()
	return { data: iterate(http, sent), response: sent.response }
}

export function requestStream(
	http: HTTPClient,
	method: string,
	path: string,
	opts: RequestOptions,
): AsyncIterable<SSEEvent> {
	return streamOperation(http, { method, opts, path })
}

/** An event stream, sent when iteration starts; `onOpen` runs once the answer is ok. */
export function streamOperation(http: HTTPClient, op: StreamCall): AsyncIterable<SSEEvent> {
	return later(() => openStream(http, op))
}

/** An event stream opened: its non-2xx thrown as its ClientError, `onOpen` run, its events read as they arrive. */
export async function openStream(
	http: HTTPClient,
	op: StreamCall,
): Promise<{ data: AsyncIterable<SSEEvent>; response: Response }> {
	const sent = await http[SEND](op, "stream", op.meta)
	/* the timeout bounded the open; the stream itself is never cut by it */
	sent.exemptFromTimeout()
	if (!sent.response.ok) {
		try {
			throw await errorFromResponse(sent.response, http[CONFIG])
		} finally {
			sent.done()
		}
	}
	op.onOpen?.(sent.response)
	return { data: iterate(http, sent), response: sent.response }
}
