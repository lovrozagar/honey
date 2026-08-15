/** NodeRequest sets this so HoneyRes can skip `new Response()` on Node. */
export const NODE_OUTBOUND = Symbol.for("honey.nodeOut")

const HONEY_RESPONSE = Symbol.for("honey.response")

export function isNodeOutbound(req: Request): boolean {
	return (req as unknown as Record<symbol, unknown>)[NODE_OUTBOUND] === true
}

export function isHoneyResponse(value: unknown): value is HoneyResponse {
	return typeof value === "object" && value !== null && HONEY_RESPONSE in value
}

/**
 * Headers view over a plain map. `get`/`has` stay on the record.
 * A real `Headers` is built only if something iterates or mutates.
 */
export class HoneyOutHeaders {
	#map: Record<string, string | string[]>
	#native: Headers | null = null

	constructor(map: Record<string, string | string[]>) {
		this.#map = map
	}

	append(name: string, value: string): void {
		this.#ensureNative().append(name, value)
	}

	delete(name: string): void {
		this.#ensureNative().delete(name)
	}

	get(name: string): string | null {
		if (this.#native) return this.#native.get(name)
		const raw = this.#map[name.toLowerCase()]
		if (raw === undefined) return null
		return Array.isArray(raw) ? raw.join(", ") : raw
	}

	getSetCookie(): string[] {
		if (this.#native) return this.#native.getSetCookie()
		const raw = this.#map["set-cookie"]
		if (raw === undefined) return []
		return Array.isArray(raw) ? raw : [raw]
	}

	has(name: string): boolean {
		if (this.#native) return this.#native.has(name)
		return this.#map[name.toLowerCase()] !== undefined
	}

	set(name: string, value: string): void {
		this.#ensureNative().set(name, value)
	}

	forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
		this.#ensureNative().forEach(callback, thisArg)
	}

	keys(): IterableIterator<string> {
		return this.#ensureNative().keys()
	}

	values(): IterableIterator<string> {
		return this.#ensureNative().values()
	}

	entries(): IterableIterator<[string, string]> {
		return this.#ensureNative().entries()
	}

	[Symbol.iterator](): IterableIterator<[string, string]> {
		if (this.#native) return this.#native[Symbol.iterator]()
		return iterateRecord(this.#map)
	}

	get [Symbol.toStringTag](): string {
		return "Headers"
	}

	toRecord(): Record<string, string | string[]> {
		if (!this.#native) return this.#map
		const out: Record<string, string | string[]> = {}
		this.#native.forEach((value, key) => {
			if (key === "set-cookie") return
			out[key] = value
		})
		const cookies = this.#native.getSetCookie()
		if (cookies.length > 0) out["set-cookie"] = cookies
		return out
	}

	#ensureNative(): Headers {
		if (this.#native) return this.#native
		const headers = new Headers()
		for (const [name, value] of iterateRecord(this.#map)) {
			headers.append(name, value)
		}
		this.#native = headers
		return headers
	}
}

function* iterateRecord(map: Record<string, string | string[]>): IterableIterator<[string, string]> {
	for (const key in map) {
		const value = map[key]
		if (Array.isArray(value)) {
			for (const item of value) yield [key, item]
		} else if (value !== undefined) {
			yield [key, value]
		}
	}
}

/**
 * Response-shaped bag for Node. Avoids `new Response()` until something
 * needs a real Fetch body stream (cors/etag wrap, clone).
 */
export class HoneyResponse {
	readonly [HONEY_RESPONSE] = true
	readonly ok: boolean
	readonly redirected = false
	readonly status: number
	readonly statusText: string
	readonly type = "default" as ResponseType
	readonly url = ""

	#headerMap: Record<string, string | string[]>
	#headers: HoneyOutHeaders | null = null
	#raw: string | Uint8Array | null
	#stream: ReadableStream<Uint8Array> | null | undefined
	#bodyUsed = false

	constructor(init: {
		headers: Record<string, string | string[]>
		raw?: string | Uint8Array | null
		status: number
		statusText?: string
		stream?: ReadableStream<Uint8Array> | null
	}) {
		this.status = init.status
		this.statusText = init.statusText ?? ""
		this.ok = init.status >= 200 && init.status < 300
		this.#headerMap = init.headers
		this.#raw = init.raw === undefined ? null : init.raw
		this.#stream = init.stream
	}

	get headers(): HoneyOutHeaders {
		if (!this.#headers) this.#headers = new HoneyOutHeaders(this.#headerMap)
		return this.#headers
	}

	get body(): ReadableStream<Uint8Array> | null {
		if (this.#stream !== undefined) return this.#stream
		if (this.#raw === null) {
			this.#stream = null
			return null
		}
		const raw = this.#raw
		this.#stream = new ReadableStream({
			start(controller) {
				controller.enqueue(typeof raw === "string" ? new TextEncoder().encode(raw) : raw)
				controller.close()
			},
		})
		return this.#stream
	}

	get bodyUsed(): boolean {
		return this.#bodyUsed
	}

	/** Plain header map for `res.writeHead`. */
	get plainHeaders(): Record<string, string | string[]> {
		return this.#headers ? this.#headers.toRecord() : this.#headerMap
	}

	/** Known-size body for `res.end`. */
	get rawBody(): string | Uint8Array | null {
		return this.#raw
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		this.#bodyUsed = true
		if (this.#raw === null) {
			if (this.#stream) return streamToArrayBuffer(this.#stream)
			return new ArrayBuffer(0)
		}
		if (typeof this.#raw === "string") {
			const bytes = new TextEncoder().encode(this.#raw)
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
		}
		return this.#raw.buffer.slice(this.#raw.byteOffset, this.#raw.byteOffset + this.#raw.byteLength) as ArrayBuffer
	}

	async blob(): Promise<Blob> {
		const buf = await this.arrayBuffer()
		return new Blob([buf], { type: this.headers.get("content-type") ?? "" })
	}

	async bytes(): Promise<Uint8Array> {
		const buf = await this.arrayBuffer()
		return new Uint8Array(buf)
	}

	clone(): Response {
		return new HoneyResponse({
			headers: { ...this.plainHeaders },
			raw: this.#raw,
			status: this.status,
			statusText: this.statusText,
			stream: this.#stream === undefined || this.#stream === null ? this.#stream : this.#stream.tee()[1],
		}) as unknown as Response
	}

	async formData(): Promise<FormData> {
		return new Response(this.body, {
			headers: this.plainHeaders as HeadersInit,
			status: this.status,
		}).formData()
	}

	async json(): Promise<unknown> {
		const text = await this.text()
		return text.length === 0 ? null : JSON.parse(text)
	}

	async text(): Promise<string> {
		this.#bodyUsed = true
		if (this.#raw === null) {
			if (this.#stream) return new TextDecoder().decode(await streamToArrayBuffer(this.#stream))
			return ""
		}
		return typeof this.#raw === "string" ? this.#raw : new TextDecoder().decode(this.#raw)
	}

	/** Copy this bag with new headers/status/body — keeps the Node `res.end` path. */
	derive(init: {
		headers?: Record<string, string | string[]> | Headers | HoneyOutHeaders
		raw?: string | Uint8Array | null
		status?: number
		stream?: ReadableStream<Uint8Array> | null
	}): HoneyResponse {
		return new HoneyResponse({
			headers: init.headers === undefined ? { ...this.plainHeaders } : headersInitToRecord(init.headers),
			raw: init.raw === undefined ? this.#raw : init.raw,
			status: init.status ?? this.status,
			statusText: this.statusText,
			stream: init.stream === undefined ? this.#stream : init.stream,
		})
	}
}

export function createHoneyResponse(init: {
	headers: Record<string, string | string[]>
	raw?: string | Uint8Array | null
	status: number
	stream?: ReadableStream<Uint8Array> | null
}): Response {
	return new HoneyResponse(init) as unknown as Response
}

/** Rebuild a response without dropping a HoneyResponse back to `new Response()`. */
export function replaceResponse(
	response: Response,
	init: {
		body?: BodyInit | null
		headers?: Headers | HoneyOutHeaders | Record<string, string | string[]>
		status?: number
	},
): Response {
	if (isHoneyResponse(response)) {
		if (init.body === undefined) {
			return response.derive({ headers: init.headers, status: init.status }) as unknown as Response
		}
		if (typeof init.body === "string" || init.body instanceof Uint8Array) {
			return response.derive({
				headers: init.headers,
				raw: init.body,
				status: init.status,
				stream: null,
			}) as unknown as Response
		}
		if (init.body instanceof ArrayBuffer) {
			return response.derive({
				headers: init.headers,
				raw: new Uint8Array(init.body),
				status: init.status,
				stream: null,
			}) as unknown as Response
		}
		if (init.body === null) {
			return response.derive({
				headers: init.headers,
				raw: null,
				status: init.status,
				stream: null,
			}) as unknown as Response
		}
	}
	return new Response(init.body !== undefined ? init.body : response.body, {
		headers: init.headers === undefined ? undefined : headersToInit(init.headers),
		status: init.status ?? response.status,
	})
}

function headersToInit(
	headers: Headers | HoneyOutHeaders | Record<string, string | string[]>,
): HeadersInit {
	if (headers instanceof HoneyOutHeaders) return headers.toRecord() as HeadersInit
	if (headers instanceof Headers) return headers
	return headers as HeadersInit
}

function headersInitToRecord(
	headers: Record<string, string | string[]> | Headers | HoneyOutHeaders,
): Record<string, string | string[]> {
	if (headers instanceof HoneyOutHeaders) return headers.toRecord()
	if (!(headers instanceof Headers) && !("forEach" in headers)) {
		return { ...headers }
	}
	const out: Record<string, string | string[]> = {}
	const h = headers as Headers
	h.forEach((value, key) => {
		if (key === "set-cookie") return
		out[key] = value
	})
	if (typeof h.getSetCookie === "function") {
		const cookies = h.getSetCookie()
		if (cookies.length > 0) out["set-cookie"] = cookies
	}
	return out
}

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		total += value.byteLength
	}
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out.buffer
}
