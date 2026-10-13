export type SSEEvent = {
	data: string
	event?: string
	/** The last event ID (sticky across events, as `EventSource.lastEventId`). Absent while empty. */
	id?: string
	retry?: number
}

const DEFAULT_MAX_BUFFER = 1024 * 1024

/**
 * Parse a `text/event-stream` body per the WHATWG HTML "event stream interpretation" rules:
 *
 * - lines end at CRLF, LF or CR (a CR at a chunk boundary waits for a possible LF);
 * - a leading BOM is skipped;
 * - `id` persists across events until changed, and an `id` containing NUL is ignored;
 * - `retry` is accepted only when it is all ASCII digits;
 * - an event still open when the stream ends is discarded, never dispatched.
 *
 * `maxBufferSize` caps both an unterminated line and the data of one event (UTF-16 code
 * units); exceeding it throws.
 */
export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
	opts?: { maxBufferSize?: number },
): AsyncGenerator<SSEEvent, void, undefined> {
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	const maxBuffer = opts?.maxBufferSize ?? DEFAULT_MAX_BUFFER

	let pending = ""
	let first = true
	let data: string[] = []
	let dataSize = 0
	let hasData = false
	let event: string | undefined
	let lastId = ""
	let retry: number | undefined

	const dispatch = (): SSEEvent | undefined => {
		const out = hasData ? ({ data: data.join("\n") } as SSEEvent) : undefined
		if (out) {
			if (event !== undefined && event !== "") out.event = event
			if (lastId !== "") out.id = lastId
			if (retry !== undefined) out.retry = retry
			retry = undefined
		}
		data = []
		dataSize = 0
		hasData = false
		event = undefined
		return out
	}

	const processLine = (line: string): void => {
		if (line.charCodeAt(0) === 58 /* : */) return
		const colon = line.indexOf(":")
		const field = colon === -1 ? line : line.slice(0, colon)
		let value = colon === -1 ? "" : line.slice(colon + 1)
		if (value.charCodeAt(0) === 32) value = value.slice(1)
		switch (field) {
			case "data":
				dataSize += value.length + 1
				if (dataSize > maxBuffer) throw new Error(`SSE event exceeded ${maxBuffer} characters`)
				data.push(value)
				hasData = true
				break
			case "event":
				event = value
				break
			case "id":
				if (!value.includes("\0")) lastId = value
				break
			case "retry":
				if (/^\d+$/.test(value)) retry = Number(value)
				break
		}
	}

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			pending += decoder.decode(value, { stream: true })
			if (first && pending.length > 0) {
				if (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1)
				first = false
			}

			let start = 0
			while (start < pending.length) {
				let end = start
				while (end < pending.length) {
					const c = pending.charCodeAt(end)
					if (c === 10 || c === 13) break
					end++
				}
				if (end === pending.length) break
				/* A CR as the last character may be the first half of CRLF. */
				if (pending.charCodeAt(end) === 13 && end === pending.length - 1) break
				const line = pending.slice(start, end)
				start = end + (pending.charCodeAt(end) === 13 && pending.charCodeAt(end + 1) === 10 ? 2 : 1)
				if (line === "") {
					const out = dispatch()
					if (out) yield out
				} else {
					processLine(line)
				}
			}
			pending = pending.slice(start)
			if (pending.length > maxBuffer) {
				throw new Error(`SSE buffer exceeded ${maxBuffer} characters`)
			}
		}
		/* A lone CR held back at the end of the stream still terminates its line. */
		if (pending.endsWith("\r")) {
			const line = pending.slice(0, -1)
			if (line === "") {
				const out = dispatch()
				if (out) yield out
			}
		}
		/* Anything else still open is an incomplete event: discard it. */
	} finally {
		await reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}
