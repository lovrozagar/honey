export type SSEEvent = {
	data: string
	event?: string
	/** The last event ID (sticky across events, as `EventSource.lastEventId`). Absent while empty. */
	id?: string
	retry?: number
}

const DEFAULT_MAX_BUFFER = 1024 * 1024

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
			this.#size += value.length + 1
			if (this.#size > this.#max) throw new Error(`SSE event exceeded ${this.#max} characters`)
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
	while (start < pending.length) {
		let end = start
		while (end < pending.length && pending.charCodeAt(end) !== 10 && pending.charCodeAt(end) !== 13) end++
		if (end === pending.length) break
		/* a CR as the last character may be the first half of CRLF */
		if (pending.charCodeAt(end) === 13 && end === pending.length - 1) break
		lines.push(pending.slice(start, end))
		start = end + (pending.charCodeAt(end) === 13 && pending.charCodeAt(end + 1) === 10 ? 2 : 1)
	}
	return { lines, rest: pending.slice(start) }
}

/**
 * Parse a `text/event-stream` body per the WHATWG "event stream interpretation" rules: lines end
 * at CRLF, LF or CR; a leading BOM is skipped; `id` persists until changed and an `id` holding NUL
 * is ignored; `retry` counts only when all ASCII digits; an event still open when the stream ends
 * is discarded. `maxBufferSize` caps an unterminated line and one event's data; exceeding it throws.
 */
export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
	opts?: { maxBufferSize?: number },
): AsyncGenerator<SSEEvent, void, undefined> {
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	const maxBuffer = opts?.maxBufferSize ?? DEFAULT_MAX_BUFFER
	const fields = new EventFields(maxBuffer)
	let pending = ""
	let first = true
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			pending += decoder.decode(chunk.value, { stream: true })
			if (first && pending.length > 0) {
				if (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1)
				first = false
			}
			const { lines, rest } = completeLines(pending)
			pending = rest
			for (const line of lines) {
				const out = line === "" ? fields.dispatch() : fields.read(line)
				if (out) yield out
			}
			if (pending.length > maxBuffer) throw new Error(`SSE buffer exceeded ${maxBuffer} characters`)
		}
		/* a lone CR held back at the end of the stream still ends a blank line; anything else open is discarded */
		if (pending === "\r") {
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
