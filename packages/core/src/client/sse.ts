export type SSEEvent = {
	data: string
	event?: string
	id?: string
	retry?: number
}

function parseBlock(block: string): SSEEvent | undefined {
	const lines = block.split(/\r\n|\r|\n/)
	let isComment = true
	let data: string | undefined
	let event: string | undefined
	let id: string | undefined
	let retry: number | undefined

	for (const line of lines) {
		if (line.startsWith(":")) continue
		isComment = false

		const colonIdx = line.indexOf(":")
		let field: string
		let val: string
		if (colonIdx === -1) {
			field = line
			val = ""
		} else {
			field = line.slice(0, colonIdx)
			val = line.slice(colonIdx + 1)
			if (val.startsWith(" ")) val = val.slice(1)
		}

		switch (field) {
			case "data":
				data = data === undefined ? val : `${data}\n${val}`
				break
			case "event":
				event = val
				break
			case "id":
				/* per spec: id containing null byte must be ignored */
				if (!val.includes("\0")) id = val
				break
			case "retry": {
				const n = Number(val)
				if (Number.isFinite(n) && n >= 0) retry = n
				break
			}
		}
	}

	if (isComment || data === undefined) return undefined

	const sse: SSEEvent = { data }
	if (event !== undefined) sse.event = event
	if (id !== undefined) sse.id = id
	if (retry !== undefined) sse.retry = retry
	return sse
}

const DEFAULT_MAX_BUFFER = 1024 * 1024

export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
	opts?: { maxBufferSize?: number },
): AsyncGenerator<SSEEvent, void, undefined> {
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	let buffer = ""
	const maxBuffer = opts?.maxBufferSize ?? DEFAULT_MAX_BUFFER

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })

			if (buffer.length > maxBuffer) {
				throw new Error(`SSE buffer exceeded ${maxBuffer} characters`)
			}

			/* split on double-newline (any combo of \r\n, \r, \n) */
			const blocks = buffer.split(/\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\n\r|\r\r|\n\n/)
			/* last element is incomplete — keep in buffer */
			buffer = blocks.pop() ?? ""

			for (const block of blocks) {
				if (block.trim() === "") continue
				const event = parseBlock(block)
				if (event) yield event
			}
		}

		/* flush remaining buffer */
		if (buffer.trim() !== "") {
			const event = parseBlock(buffer)
			if (event) yield event
		}
	} finally {
		await reader.cancel()
		reader.releaseLock()
	}
}
