import type { IncomingMessage } from "node:http"
import { Readable } from "node:stream"

/** bodyLimit uses this to swap the inbound stream without `new Request(req)`. */
export const REPLACE_BODY = Symbol.for("honey.replaceBody")

/**
 * Headers view over IncomingMessage. `get`/`has` read Node's already-parsed
 * map. A real `Headers` is built only if something iterates or mutates.
 */
export class NodeHeaders {
	#incoming: IncomingMessage
	#native: Headers | null = null

	constructor(incoming: IncomingMessage) {
		this.#incoming = incoming
	}

	append(name: string, value: string): void {
		this.#ensureNative().append(name, value)
	}

	delete(name: string): void {
		this.#ensureNative().delete(name)
	}

	get(name: string): string | null {
		if (this.#native) return this.#native.get(name)
		const raw = this.#incoming.headers[name.toLowerCase()]
		if (raw === undefined) return null
		return Array.isArray(raw) ? raw.join(", ") : raw
	}

	getSetCookie(): string[] {
		return this.#ensureNative().getSetCookie()
	}

	has(name: string): boolean {
		if (this.#native) return this.#native.has(name)
		return this.#incoming.headers[name.toLowerCase()] !== undefined
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
		return this.#ensureNative()[Symbol.iterator]()
	}

	get [Symbol.toStringTag](): string {
		return "Headers"
	}

	#ensureNative(): Headers {
		if (this.#native) return this.#native
		const headers = new Headers()
		const raw = this.#incoming.rawHeaders
		for (let i = 0; i < raw.length; i += 2) {
			const name = raw[i]
			if (name.charCodeAt(0) === 58) continue
			headers.append(name, raw[i + 1])
		}
		this.#native = headers
		return headers
	}
}

/**
 * Request-shaped wrapper around IncomingMessage. Avoids `new Request()`
 * until a body method needs the real Fetch object (formData / blob / clone).
 */
export class NodeRequest {
	readonly cache = "default" as RequestCache
	readonly credentials = "same-origin" as RequestCredentials
	readonly destination = "" as RequestDestination
	readonly headers: NodeHeaders
	readonly integrity = ""
	readonly keepalive = false
	readonly method: string
	readonly mode = "cors" as RequestMode
	readonly redirect = "follow" as RequestRedirect
	readonly referrer = "about:client"
	readonly referrerPolicy = "" as ReferrerPolicy
	readonly url: string

	#incoming: IncomingMessage
	#hasBody: boolean
	#webBody: ReadableStream<Uint8Array> | null | undefined
	#bodyUsed = false
	#fetch: Request | null = null
	#signal: AbortSignal | null = null

	constructor(incoming: IncomingMessage) {
		this.#incoming = incoming
		const host = incoming.headers.host ?? "localhost"
		this.url = `http://${host}${incoming.url ?? "/"}`
		this.method = (incoming.method ?? "GET").toUpperCase()
		this.headers = new NodeHeaders(incoming)
		this.#hasBody = this.method !== "GET" && this.method !== "HEAD"
	}

	get body(): ReadableStream<Uint8Array> | null {
		if (!this.#hasBody) return null
		if (this.#webBody === undefined) {
			this.#webBody = Readable.toWeb(this.#incoming) as ReadableStream<Uint8Array>
		}
		return this.#webBody
	}

	get bodyUsed(): boolean {
		return this.#bodyUsed || this.#incoming.readableEnded
	}

	get signal(): AbortSignal {
		if (this.#signal) return this.#signal
		const ac = new AbortController()
		this.#incoming.once("aborted", () => ac.abort())
		this.#signal = ac.signal
		return this.#signal
	}

	get duplex(): "half" {
		return "half"
	}

	[REPLACE_BODY](stream: ReadableStream<Uint8Array>): void {
		this.#webBody = stream
		this.#hasBody = true
		this.#fetch = null
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const buf = await this.#readIncoming()
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
	}

	async blob(): Promise<Blob> {
		return this.#asFetch().blob()
	}

	async bytes(): Promise<Uint8Array> {
		const buf = await this.#readIncoming()
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
	}

	clone(): Request {
		return this.#asFetch().clone()
	}

	async formData(): Promise<FormData> {
		return this.#asFetch().formData()
	}

	async json(): Promise<unknown> {
		const text = await this.text()
		return text.length === 0 ? null : JSON.parse(text)
	}

	async text(): Promise<string> {
		const buf = await this.#readIncoming()
		return buf.toString("utf8")
	}

	#asFetch(): Request {
		if (this.#fetch) return this.#fetch
		this.#fetch = new Request(this.url, {
			body: this.body,
			duplex: this.#hasBody ? "half" : undefined,
			headers: this.#incoming.headers as HeadersInit,
			method: this.method,
			signal: this.signal,
		} as RequestInit)
		this.#bodyUsed = true
		return this.#fetch
	}

	async #readIncoming(): Promise<Buffer> {
		this.#bodyUsed = true
		if (!this.#hasBody) return Buffer.alloc(0)
		if (this.#fetch) return Buffer.from(await this.#fetch.arrayBuffer())
		if (this.#webBody) return streamToBuffer(this.#webBody)
		const chunks: Buffer[] = []
		for await (const chunk of this.#incoming) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
		}
		return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
	}
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
	const reader = stream.getReader()
	const chunks: Buffer[] = []
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(Buffer.from(value))
	}
	return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
}

const REQUEST_HAS_INSTANCE = Symbol.for("honey.requestHasInstance")

function installRequestHasInstance(): void {
	const ctor = Request as typeof Request & { [REQUEST_HAS_INSTANCE]?: boolean }
	if (ctor[REQUEST_HAS_INSTANCE]) return
	const original = Request[Symbol.hasInstance]
	Object.defineProperty(Request, Symbol.hasInstance, {
		configurable: true,
		value(this: Function, value: unknown) {
			if (this === Request && value instanceof NodeRequest) return true
			return original.call(this, value)
		},
	})
	ctor[REQUEST_HAS_INSTANCE] = true
}

installRequestHasInstance()

export function incomingToNodeRequest(req: IncomingMessage): Request {
	return new NodeRequest(req) as unknown as Request
}
