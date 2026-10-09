import type { IncomingMessage } from "node:http"
import { Readable } from "node:stream"
import { NODE_OUTBOUND } from "./honey-response.ts"
import { PEER_ADDRESS } from "./peer.ts"
import { isValidHost } from "./trust.ts"

/** bodyLimit uses this to swap the inbound stream without `new Request(req)`. */
export const REPLACE_BODY = Symbol.for("honey.replaceBody")

/** The Node adapter calls this when the response closes before it finished (client disconnect, shutdown). */
export const ABORT_REQUEST = Symbol.for("honey.abortRequest")

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
		const key = name.toLowerCase()
		const headers = this.#incoming.headers
		if (!Object.hasOwn(headers, key)) return null
		const raw = headers[key]
		if (raw === undefined) return null
		return Array.isArray(raw) ? raw.join(", ") : raw
	}

	getSetCookie(): string[] {
		return this.#ensureNative().getSetCookie()
	}

	has(name: string): boolean {
		if (this.#native) return this.#native.has(name)
		const key = name.toLowerCase()
		const headers = this.#incoming.headers
		return Object.hasOwn(headers, key) && headers[key] !== undefined
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

/** Printable ASCII with no `\`, no dot segment, no `%2e`: what a WHATWG URL parse would leave as it is. */
function isPlainTarget(target: string): boolean {
	if (target.charCodeAt(0) !== 47) return false
	for (let i = 0; i < target.length; i++) {
		const c = target.charCodeAt(i)
		if (c <= 0x20 || c >= 0x7f || c === 92 /* \ */) return false
		if (c === 47 && target.charCodeAt(i + 1) === 46) return false
		if (c === 37 && target.charCodeAt(i + 1) === 50 && (target.charCodeAt(i + 2) | 0x20) === 101) return false
	}
	return true
}

/**
 * The request URL from what the client actually sent: scheme from the socket (TLS or not),
 * authority from `Host` (or from an absolute-form target, which takes precedence per RFC 9112),
 * path and query from the request target. Anything but an origin-form (`/path`) or http(s)
 * absolute-form target, and any `Host` that is not `host[:port]`, returns `null`: the request
 * gets 400. A target that needs it is parsed the way `new URL()` parses it, so the path matches
 * what Bun, Deno and Workers hand the app for the same bytes.
 */
export function nodeRequestUrl(incoming: IncomingMessage): string | null {
	const scheme = (incoming.socket as { encrypted?: boolean } | null)?.encrypted === true ? "https" : "http"
	const target = incoming.url ?? "/"
	const hostHeader = incoming.headers.host
	if (target.charCodeAt(0) !== 47) {
		/* absolute-form: http://host/path */
		const lower = target.slice(0, 8).toLowerCase()
		if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null
		let url: URL
		try {
			url = new URL(target)
		} catch {
			return null
		}
		if (url.username !== "" || url.password !== "" || !isValidHost(url.host)) return null
		return `${scheme}://${url.host}${url.pathname}${url.search}`
	}
	const host =
		hostHeader === undefined || hostHeader === "" ? (incoming.httpVersion === "1.0" ? "localhost" : null) : hostHeader
	if (host === null || !isValidHost(host)) return null
	if (isPlainTarget(target)) return `${scheme}://${host}${target}`
	try {
		/* never `new URL(target, base)`: a `//x/y` target would become a host */
		const url = new URL(`${scheme}://${host}${target}`)
		return `${scheme}://${host}${url.pathname}${url.search}`
	} catch {
		return null
	}
}

/**
 * Request-shaped wrapper around IncomingMessage. Avoids `new Request()`
 * until a body method needs the real Fetch object (formData / blob / clone).
 */
export class NodeRequest {
	readonly [NODE_OUTBOUND] = true
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
	#ac: AbortController | null = null
	/* set when the adapter aborted the request before anything read `signal` */
	#abortReason: { reason: unknown } | null = null

	/** @param url the request URL; `nodeRequestUrl(incoming)` when left out (throws if that is invalid) */
	constructor(incoming: IncomingMessage, url?: string) {
		this.#incoming = incoming
		const resolved = url ?? nodeRequestUrl(incoming)
		if (resolved === null) throw new TypeError("Invalid request target or Host header")
		this.url = resolved
		this.method = (incoming.method ?? "GET").toUpperCase()
		this.headers = new NodeHeaders(incoming)
		this.#hasBody = this.method !== "GET" && this.method !== "HEAD"
	}

	get body(): ReadableStream<Uint8Array> | null {
		if (!this.#hasBody) return null
		/* once a Fetch Request owns the stream (clone, formData, blob), it is the body */
		if (this.#fetch) return this.#fetch.body
		if (this.#webBody === undefined) {
			// Node's web stream and the DOM/Bun ReadableStream brands do not overlap.
			this.#webBody = Readable.toWeb(this.#incoming) as unknown as ReadableStream<Uint8Array>
		}
		return this.#webBody
	}

	/** The socket peer, for `ctx.ip`. */
	get [PEER_ADDRESS](): string | null {
		return this.#incoming.socket?.remoteAddress ?? null
	}

	get bodyUsed(): boolean {
		if (this.#fetch) return this.#fetch.bodyUsed
		return this.#bodyUsed || (this.#hasBody && this.#incoming.readableEnded)
	}

	/**
	 * Aborts when the response closes before it finished: the client disconnected, or the
	 * server shut down. Reading the body does not end it (Node's `'aborted'` event did).
	 */
	get signal(): AbortSignal {
		if (this.#ac === null) {
			this.#ac = new AbortController()
			if (this.#abortReason !== null) this.#ac.abort(this.#abortReason.reason)
		}
		return this.#ac.signal
	}

	[ABORT_REQUEST](reason?: unknown): void {
		const why = reason ?? new DOMException("The client disconnected", "AbortError")
		if (this.#ac !== null) this.#ac.abort(why)
		else if (this.#abortReason === null) this.#abortReason = { reason: why }
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

	/** As Fetch: an empty body is a `SyntaxError`, not `null`. */
	async json(): Promise<unknown> {
		return JSON.parse(await this.text())
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
		return this.#fetch
	}

	async #readIncoming(): Promise<Buffer> {
		/* a null body reads as empty, any number of times */
		if (!this.#hasBody) return Buffer.alloc(0)
		if (this.bodyUsed) throw new TypeError("Body has already been used")
		this.#bodyUsed = true
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

export function incomingToNodeRequest(req: IncomingMessage, url?: string): Request {
	return new NodeRequest(req, url) as unknown as Request
}
