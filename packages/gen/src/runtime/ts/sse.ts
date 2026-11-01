/** One server-sent event; `data` is the raw text, or the parsed value when the operation declares JSON events. */
export type SSEEvent<T = string> = {
	data: T
	event?: string
	/** The last event ID (sticky across events, as `EventSource.lastEventId`). Absent while empty. */
	id?: string
	retry?: number
}

/* the siblings' caps, in UTF-8 bytes */
const MAX_LINE = 1 << 20
const MAX_EVENT = 8 << 20

/** `text`'s UTF-8 bytes, counted until past `max`. */
function bytesOf(text: string, max = Infinity): number {
	let bytes = 0
	for (let i = 0; i < text.length && bytes <= max; i++) {
		const unit = text.charCodeAt(i)
		bytes += unit < 0x80 ? 1 : unit < 0x800 || (unit >= 0xd800 && unit < 0xe000) ? 2 : 3
	}
	return bytes
}

/** Whether `line` is over `max` UTF-8 bytes; a third of `max` in code units is within it, uncounted. */
const overLine = (line: string, max: number) => line.length * 3 > max && bytesOf(line, max) > max

/** One event being read: its fields as they arrive, dispatched on a blank line. */
class EventFields {
	readonly #max: number
	#data: string[] = []
	#size = 0
	#hasData = false
	#event: string | undefined
	#lastId = ""
	#retry: number | undefined

	constructor(max: number) {
		this.#max = max
	}

	/** The event so far, when it has data; every field but the sticky id resets. */
	dispatch(): SSEEvent | undefined {
		const out = this.#hasData ? ({ data: this.#data.join("\n") } as SSEEvent) : undefined
		if (out) {
			if (this.#event !== undefined && this.#event !== "") out.event = this.#event
			if (this.#lastId !== "") out.id = this.#lastId
			if (this.#retry !== undefined) out.retry = this.#retry
			this.#retry = undefined
		}
		this.#data = []
		this.#size = 0
		this.#hasData = false
		this.#event = undefined
		return out
	}

	/** One `field: value` line; a comment or an unknown field changes nothing. */
	read(line: string): void {
		if (line.charCodeAt(0) === 58 /* : */) return
		const colon = line.indexOf(":")
		const field = colon === -1 ? line : line.slice(0, colon)
		let value = colon === -1 ? "" : line.slice(colon + 1)
		if (value.charCodeAt(0) === 32) value = value.slice(1)
		if (field === "data") {
			this.#size += bytesOf(value) + (this.#hasData ? 1 : 0)
			if (this.#size > this.#max) throw new Error(`SSE event exceeds ${this.#max} bytes`)
			this.#data.push(value)
			this.#hasData = true
		} else if (field === "event") this.#event = value
		else if (field === "id") {
			if (!value.includes("\0")) this.#lastId = value
		} else if (field === "retry" && /^\d+$/.test(value)) this.#retry = Number(value)
	}
}

/** The complete lines at the head of `pending` (CRLF, LF or CR), and what is left after them. */
function completeLines(pending: string): { lines: string[]; rest: string } {
	const lines: string[] = []
	let start = 0
	let end = 0
	while (start < pending.length) {
		end = start
		while (end < pending.length && pending.charCodeAt(end) !== 10 && pending.charCodeAt(end) !== 13) end++
		if (end === pending.length) break
		/* a CR as the last character may be the first half of CRLF */
		if (pending.charCodeAt(end) === 13 && end === pending.length - 1) break
		lines.push(pending.slice(start, end))
		start = end + (pending.charCodeAt(end) === 13 && pending.charCodeAt(end + 1) === 10 ? 2 : 1)
	}
	return { lines, rest: pending.slice(start) }
}

/** The open line as its pieces and their UTF-8 bytes: joining it per chunk was quadratic. */
function openLine(max: number) {
	let pieces: string[] = []
	let bytes = 0
	return {
		/** The lines `text` completes; with no line end, and no CR before it, it extends the open line. */
		take(text: string): string[] {
			const last = pieces[pieces.length - 1]
			if (!/[\r\n]/.test(text) && last?.charCodeAt(last.length - 1) !== 13) {
				pieces.push(text)
				bytes += bytesOf(text, max)
				return []
			}
			const { lines, rest } = completeLines(pieces.join("") + text)
			pieces = rest === "" ? [] : [rest]
			bytes = bytesOf(rest, max)
			return lines
		},
		over: () => bytes > max,
		/** only a CR is open, held back as a possible CRLF's first half */
		lone: () => pieces.length === 1 && pieces[0] === "\r",
	}
}

/** `stream`'s reader, and a read whose failure throws `failed`'s error for it. */
function readerOf(stream: ReadableStream<Uint8Array>, failed = (cause: unknown) => cause) {
	const reader = stream.getReader()
	const read = () =>
		/* no answer (f2) */
		reader.read().catch((cause) => {
			throw failed(cause)
		})
	return { read, reader }
}

/**
 * Parse a `text/event-stream` body per the WHATWG "event stream interpretation" rules: lines end
 * at CRLF, LF or CR; a leading BOM is skipped; `id` persists until changed and an `id` holding NUL
 * is ignored; `retry` counts only when all ASCII digits; an event still open when the stream ends
 * is discarded. A line over `maxLineBytes` (1 MiB) or an event's data over `maxEventBytes` (8 MiB), in UTF-8 bytes,
 * throws after every event completed before it, as does a failed read, by `failed`. Leaving a `for await` early (a
 * break, return or throw) cancels the body's reader, which frees the connection.
 */
export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
	opts?: {
		failed?: ((cause: unknown) => unknown) | undefined
		maxLineBytes?: number | undefined
		maxEventBytes?: number | undefined
	},
): AsyncGenerator<SSEEvent, void, undefined> {
	const decoder = new TextDecoder()
	const { failed, maxEventBytes = MAX_EVENT, maxLineBytes: maxLine = MAX_LINE } = opts ?? {}
	const { read, reader } = readerOf(stream, failed)
	const fields = new EventFields(maxEventBytes)
	const open = openLine(maxLine)
	let first = true
	try {
		for (let chunk = await read(); !chunk.done; chunk = await read()) {
			let text = decoder.decode(chunk.value, { stream: true })
			if (first && text.length > 0) {
				if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
				first = false
			}
			for (const line of open.take(text)) {
				if (overLine(line, maxLine)) throw new Error(`SSE line exceeds ${maxLine} bytes`)
				const out = line === "" ? fields.dispatch() : fields.read(line)
				if (out) yield out
			}
			if (open.over()) throw new Error(`SSE line exceeds ${maxLine} bytes`)
		}
		/* a lone CR held back at the end of the stream still ends a blank line; anything else open is discarded */
		if (open.lone()) {
			const out = fields.dispatch()
			if (out) yield out
		}
	} finally {
		await reader.cancel().catch(() => {
			/* the stream is done either way */
		})
		reader.releaseLock()
	}
}
