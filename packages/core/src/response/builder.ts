/**
 * Response construction. `HoneyResponse` is a Response-shaped bag for Node: it keeps a buffered
 * body and a plain header map so the adapter can `res.end` it without `new Response()`, and builds
 * a Fetch body stream only when something reads one. The raw-body side table lets every reader
 * (raw(), HEAD, compress, output validation) find a native response's buffered body (H18.1).
 */
import { type HeaderMap, headersToRecord, HoneyOutHeaders } from "./out-headers.ts"

/** The Node adapter sets this on a request so `HoneyRes` can skip `new Response()`. */
export const NODE_OUTBOUND: unique symbol = /* @__PURE__ */ Symbol.for("honey.nodeOut")

const HONEY_RESPONSE: unique symbol = /* @__PURE__ */ Symbol.for("honey.response")

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()
// per-process-constant: text-codec
const decoder = /* @__PURE__ */ new TextDecoder()

/* weak keys: a response's entry goes with the response; no property is defined on the host object */
// per-process-constant: raw-body
const rawBodies = /* @__PURE__ */ new WeakMap<Response, string | Uint8Array>()

export type RawBody = string | Uint8Array

export function isNodeOutbound(req: Request): boolean {
	return (req as unknown as Record<symbol, unknown>)[NODE_OUTBOUND] === true
}

export function isHoneyResponse(value: unknown): value is HoneyResponse {
	return typeof value === "object" && value !== null && HONEY_RESPONSE in value
}

/**
 * Record the buffered body a native response was built from. Only for a response honey constructed:
 * a recorded body also tells withHeaders the headers are mutable.
 */
export function withRawBody(response: Response, body: RawBody): Response {
	rawBodies.set(response, body)
	return response
}

/** The buffered body a response was built from, or `null` for a streamed or foreign one. */
export function rawBodyOf(response: Response): RawBody | null {
	if (isHoneyResponse(response)) return response.rawBody
	return rawBodies.get(response) ?? null
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

type HoneyResponseInit = {
	headers: HeaderMap
	raw?: RawBody | null
	status: number
	statusText?: string
	stream?: ReadableStream<Uint8Array> | null
}

type DeriveInit = {
	headers?: HeaderMap | Headers | HoneyOutHeaders
	raw?: RawBody | null
	status?: number
	stream?: ReadableStream<Uint8Array> | null
}

function toHeaderMap(headers: HeaderMap | Headers | HoneyOutHeaders): HeaderMap {
	if (headers instanceof HoneyOutHeaders) return headers.toRecord()
	if (headers instanceof Headers) return headersToRecord(headers)
	return { ...headers }
}

export class HoneyResponse {
	readonly [HONEY_RESPONSE] = true
	readonly ok: boolean
	readonly redirected = false
	readonly status: number
	readonly statusText: string
	readonly type = "default" as ResponseType
	readonly url = ""

	#headerMap: HeaderMap
	#headers: HoneyOutHeaders | null = null
	#raw: RawBody | null
	/* `undefined`: not built yet; built from `#raw` on first read of `body` */
	#stream: ReadableStream<Uint8Array> | null | undefined
	#bodyUsed = false

	constructor(init: HoneyResponseInit) {
		this.status = init.status
		this.statusText = init.statusText ?? ""
		this.ok = init.status >= 200 && init.status < 300
		this.#headerMap = init.headers
		this.#raw = init.raw ?? null
		this.#stream = init.stream
	}

	get headers(): HoneyOutHeaders {
		this.#headers ??= new HoneyOutHeaders(this.#headerMap)
		return this.#headers
	}

	get body(): ReadableStream<Uint8Array> | null {
		if (this.#stream !== undefined) return this.#stream
		const raw = this.#raw
		this.#stream =
			raw === null
				? null
				: new ReadableStream({
						start(controller) {
							controller.enqueue(typeof raw === "string" ? encoder.encode(raw) : raw)
							controller.close()
						},
					})
		return this.#stream
	}

	get bodyUsed(): boolean {
		return this.#bodyUsed
	}

	/** Plain header map for `res.writeHead`. */
	get plainHeaders(): HeaderMap {
		return this.#headers ? this.#headers.toRecord() : this.#headerMap
	}

	/** Known-size body for `res.end`. */
	get rawBody(): RawBody | null {
		return this.#raw
	}

	/** A body is read once, as with Fetch: a second read throws instead of returning nothing. */
	#consume(): void {
		if (this.#bodyUsed || (this.#stream?.locked ?? false)) throw new TypeError("Body has already been used")
		this.#bodyUsed = true
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		this.#consume()
		const raw = this.#raw
		if (raw === null) return this.#stream ? new Response(this.#stream).arrayBuffer() : new ArrayBuffer(0)
		return toArrayBuffer(typeof raw === "string" ? encoder.encode(raw) : raw)
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.arrayBuffer()], { type: this.headers.get("content-type") ?? "" })
	}

	async bytes(): Promise<Uint8Array> {
		return new Uint8Array(await this.arrayBuffer())
	}

	clone(): Response {
		if (this.#bodyUsed) throw new TypeError("Body has already been used")
		let stream = this.#stream
		if (stream) {
			/* tee, keep one branch: the original stays readable */
			const [mine, theirs] = stream.tee()
			this.#stream = mine
			stream = theirs
		}
		const copy = new HoneyResponse({
			headers: { ...this.plainHeaders },
			raw: this.#raw,
			status: this.status,
			statusText: this.statusText,
			stream,
		})
		return copy as unknown as Response
	}

	async formData(): Promise<FormData> {
		const body = this.body
		this.#consume()
		return new Response(body, { headers: this.plainHeaders as HeadersInit, status: this.status }).formData()
	}

	async json(): Promise<unknown> {
		const text = await this.text()
		return text.length === 0 ? null : JSON.parse(text)
	}

	async text(): Promise<string> {
		const raw = this.#raw
		if (raw === null) return decoder.decode(await this.arrayBuffer())
		this.#consume()
		return typeof raw === "string" ? raw : decoder.decode(raw)
	}

	/** Copy this bag with new headers/status/body — keeps the Node `res.end` path. */
	derive(init: DeriveInit): HoneyResponse {
		return new HoneyResponse({
			headers: init.headers === undefined ? { ...this.plainHeaders } : toHeaderMap(init.headers),
			raw: init.raw === undefined ? this.#raw : init.raw,
			status: init.status ?? this.status,
			statusText: this.statusText,
			stream: init.stream === undefined ? this.#stream : init.stream,
		})
	}
}

export function createHoneyResponse(init: HoneyResponseInit): Response {
	return new HoneyResponse(init) as unknown as Response
}

type ReplaceInit = {
	body?: BodyInit | null
	headers?: Headers | HoneyOutHeaders | HeaderMap
	status?: number
}

/** A body a HoneyResponse keeps buffered, or `undefined` for one it cannot (a stream, a Blob, form data). */
function bufferedBody(body: BodyInit | null): RawBody | null | undefined {
	if (body === null || typeof body === "string" || body instanceof Uint8Array) return body
	if (body instanceof ArrayBuffer) return new Uint8Array(body)
	return undefined
}

function headersToInit(headers: Headers | HoneyOutHeaders | HeaderMap): HeadersInit {
	if (headers instanceof HoneyOutHeaders) return headers.toRecord() as HeadersInit
	return headers as HeadersInit
}

/** Rebuild a response without dropping a HoneyResponse back to `new Response()`. */
export function replaceResponse(response: Response, init: ReplaceInit): Response {
	/* an upgrade response belongs to the runtime: rebuilding it throws (RangeError) or breaks the socket */
	if (response.status === 101) return response
	if (isHoneyResponse(response)) {
		if (init.body === undefined)
			return response.derive({ headers: init.headers, status: init.status }) as unknown as Response
		const raw = bufferedBody(init.body)
		if (raw !== undefined) {
			return response.derive({ headers: init.headers, raw, status: init.status, stream: null }) as unknown as Response
		}
	}
	const status = init.status ?? response.status
	return new Response(init.body === undefined ? response.body : init.body, {
		/* left out, the headers carry over: a status change must not drop them */
		headers: headersToInit(init.headers ?? (response.headers as Headers | HoneyOutHeaders)),
		status,
		statusText: status === response.status ? response.statusText : undefined,
	})
}
