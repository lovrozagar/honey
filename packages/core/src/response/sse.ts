/**
 * The `text/event-stream` emitter behind `ctx.res.sse()`: event framing, the retry and id
 * directives, keepalive heartbeats, and the stream a callback writes events into.
 */
import { type ProducerOptions, type ProducerSink, producerStream } from "../streaming/producer-stream.ts"

export type SSEEvent = {
	data: object | string
	event: string
	/** The id a reconnecting client sends back as `Last-Event-ID`; `""` tells it to forget its last one. */
	id?: string
	/** Reconnect delay in ms; anything but a non-negative finite number is left out. */
	retry?: number
}

export type SSEOptions = {
	/** A `retry:` directive sent before any event. */
	defaultRetry?: number
	/** Send a heartbeat comment every this many ms while the stream is open. */
	keepalive?: number
	/** The id the client resumes from. Default: its `Last-Event-ID` header. */
	lastEventId?: string
}

export type SSEStream = {
	/** End the stream. Idempotent and synchronous: safe in a `finally`. */
	close(): void
	/** True once the stream ended: closed, or the client went away. */
	readonly closed: boolean
	readonly lastEventId: string | undefined
	/**
	 * Queue an event. Resolves when the client is ready for more. After the stream ended it
	 * rejects with an `AbortError`, which ends an awaiting loop; an unawaited one never surfaces
	 * as an unhandled rejection.
	 */
	send(event: SSEEvent): Promise<void>
	/** Aborts when the client disconnects or the request ends. */
	readonly signal: AbortSignal
}

/* no `connection: keep-alive`: HTTP/1.1 keeps the connection anyway, the header would override a
 * client's `Connection: close`, and HTTP/2 forbids it */
export const SSE_HEADERS: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze({
	"cache-control": "no-cache",
	"content-type": "text/event-stream",
})

const NEWLINE = /[\r\n]/
const LINE_BREAK = /\r\n|\r|\n/
const HEARTBEAT = ": heartbeat\n\n"

function swallow(): void {}

function isRetry(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0
}

/** One event on the wire. A newline in the name or the id would start another field: it throws. */
export function encodeEvent(event: SSEEvent): string {
	if (NEWLINE.test(event.event)) throw new Error("SSE event name must not contain newlines")
	if (event.id !== undefined && NEWLINE.test(event.id)) throw new Error("SSE id must not contain newlines")
	const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data)
	let out = `event: ${event.event}\n`
	for (const line of data.split(LINE_BREAK)) out += `data: ${line}\n`
	if (event.id !== undefined) out += event.id === "" ? "id:\n" : `id: ${event.id}\n`
	if (isRetry(event.retry)) out += `retry: ${Math.floor(event.retry)}\n`
	return `${out}\n`
}

/**
 * Heartbeats while the stream is open. At most one waits for the reader: a client that stopped
 * reading never has heartbeats piling up behind it.
 */
function keepAlive(sink: ProducerSink, every: number, encoder: TextEncoder): void {
	const heartbeat = encoder.encode(HEARTBEAT)
	let waiting = false
	const timer = setInterval(() => {
		if (waiting) return
		waiting = true
		sink.write(heartbeat).then(() => {
			waiting = false
		}, swallow)
	}, every)
	sink.onEnd(() => clearInterval(timer))
}

/** The body an SSE callback writes into; it ends when the callback settles, the client leaves, or the request ends. */
export function sseBody(
	callback: (stream: SSEStream) => Promise<void>,
	options: SSEOptions,
	producer: ProducerOptions,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return producerStream((sink) => {
		const stream: SSEStream = {
			close: () => sink.close(),
			get closed() {
				return sink.closed
			},
			lastEventId: options.lastEventId,
			send: (event) => sink.write(encoder.encode(encodeEvent(event))),
			signal: sink.signal,
		}
		if (isRetry(options.defaultRetry)) {
			sink.write(encoder.encode(`retry: ${Math.floor(options.defaultRetry)}\n\n`)).catch(swallow)
		}
		if (options.keepalive !== undefined && options.keepalive > 0) keepAlive(sink, options.keepalive, encoder)
		return callback(stream)
	}, producer)
}
