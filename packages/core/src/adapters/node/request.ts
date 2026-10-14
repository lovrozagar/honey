/**
 * The `node:http` → Fetch side of the Node adapter: the request URL from what the client sent,
 * and a Request-shaped view of the IncomingMessage that builds a real `Request` only when
 * something needs one (formData, blob, clone, `toFetchRequest`).
 */
import type { IncomingMessage } from "node:http"
import { Readable } from "node:stream"
import { PEER_ADDRESS } from "../../context/peer.ts"
import { EK, HoneyError } from "../../errors/error.ts"
import { NODE_OUTBOUND } from "../../response/builder.ts"
import { TO_FETCH_REQUEST } from "../fetch-request.ts"
import { NodeHeaders } from "./headers.ts"

/** The serve side calls this when the response closed before it finished: client gone, or shutdown. */
export const ABORT_REQUEST: unique symbol = /* @__PURE__ */ Symbol("honey.abortRequest")

/** True once a body read went over the cap: the body is left on the socket, so the connection is not reused. */
export const BODY_OVERFLOW: unique symbol = /* @__PURE__ */ Symbol("honey.bodyOverflow")

/** `host[:port]` as RFC 9110 allows it in `Host`: no userinfo, path or anything else that changes the URL. */
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?)(?::\d{1,5})?$/

/** Already what URL parsing serializes: lowercase labels ending in a letter-led one, or a dotted quad. */
const CANONICAL_HOST =
	/^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z](?:[a-z0-9-]*[a-z0-9])?\.?|(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))(?::[1-9]\d{0,4})?$/

/** Characters URL parsing leaves alone in a path and query, on every runtime. */
const PLAIN_TARGET = /^\/[\w\-.~!$&()*+,;=:@/?%]*$/
const ESCAPED_DOT = /%2e/i

/** A target URL parsing would leave exactly as it is: no dot segment, escaped or not. */
function isPlainTarget(target: string): boolean {
	return PLAIN_TARGET.test(target) && !target.includes("/.") && !ESCAPED_DOT.test(target)
}

/** `URL.parse` without it: Node 20 lacks it. */
function parseUrl(text: string): URL | null {
	try {
		return new URL(text)
	} catch {
		return null
	}
}

/**
 * The host as the Request URL carries it (Bun and Workers serialize it through URL parsing), or
 * `null` when it is not one. The common spelling skips the parse; IPv4 shorthands, IPv6 literals,
 * punycode, uppercase and a default port go through it.
 */
function canonicalHost(scheme: string, host: string): string | null {
	if (!HOST.test(host)) return null
	if (CANONICAL_HOST.test(host) && !host.includes("xn--")) {
		const colon = host.lastIndexOf(":")
		if (colon === -1) return host
		const port = host.slice(colon + 1)
		if (Number(port) <= 65535 && port !== (scheme === "https" ? "443" : "80")) return host
	}
	return parseUrl(`${scheme}://${host}/`)?.host ?? null
}

function absoluteFormUrl(scheme: string, target: string): string | null {
	const lower = target.slice(0, 8).toLowerCase()
	if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null
	const url = parseUrl(target)
	if (url === null || url.username !== "" || url.password !== "" || !HOST.test(url.host)) return null
	return `${scheme}://${url.host}${url.pathname}${url.search}`
}

/**
 * The request URL: the scheme from the socket's TLS state, the authority from `Host` (or from an
 * absolute-form target, which wins per RFC 9112), the path and query from the target, parsed as
 * Bun and Workers parse the same bytes. Any other target form, and any `Host` that is not
 * `host[:port]`, is `null`: the request gets 400.
 */
export function nodeRequestUrl(incoming: IncomingMessage): string | null {
	const scheme = (incoming.socket as { encrypted?: boolean }).encrypted === true ? "https" : "http"
	/* a request node:http parsed always has its target and method */
	const target = incoming.url as string
	if (target.charCodeAt(0) !== 47) return absoluteFormUrl(scheme, target)
	const header = incoming.headers.host
	const given = header === undefined || header === "" ? (incoming.httpVersion === "1.0" ? "localhost" : null) : header
	const host = given === null ? null : canonicalHost(scheme, given)
	if (host === null) return null
	if (isPlainTarget(target)) return `${scheme}://${host}${target}`
	/* never `new URL(target, base)`: a `//x/y` target would become the host. A canonical host and a
	 * target starting with `/` always parse. */
	const url = new URL(`${scheme}://${host}${target}`)
	return `${scheme}://${host}${url.pathname}${url.search}`
}

/** Request-shaped view of an IncomingMessage: no `new Request()` until something needs the real one. */
class NodeRequest {
	readonly headers: NodeHeaders
	readonly method: string
	readonly url: string

	readonly #incoming: IncomingMessage
	readonly #hasBody: boolean
	readonly #maxBody: number
	#received = 0
	#overflow = false
	#bodyUsed = false
	#stream: ReadableStream<Uint8Array> | undefined
	#fetch: Request | undefined
	#controller: AbortController | undefined
	/* the abort that came before anything read `signal` */
	#abortReason: { readonly reason: unknown } | undefined

	constructor(incoming: IncomingMessage, url: string, maxBody: number) {
		this.#incoming = incoming
		this.#maxBody = maxBody
		this.url = url
		this.method = incoming.method as string
		this.headers = new NodeHeaders(incoming)
		this.#hasBody = this.method !== "GET" && this.method !== "HEAD"
	}

	get cache(): RequestCache {
		return "default"
	}
	get credentials(): RequestCredentials {
		return "same-origin"
	}
	get destination(): RequestDestination {
		return ""
	}
	get duplex(): "half" {
		return "half"
	}
	get integrity(): string {
		return ""
	}
	get keepalive(): boolean {
		return false
	}
	get mode(): RequestMode {
		return "cors"
	}
	get redirect(): RequestRedirect {
		return "follow"
	}
	get referrer(): string {
		return "about:client"
	}
	get referrerPolicy(): ReferrerPolicy {
		return ""
	}

	get [NODE_OUTBOUND](): true {
		return true
	}

	/** The socket peer, for `ctx.ip`. */
	get [PEER_ADDRESS](): string | null {
		return this.#incoming.socket.remoteAddress ?? null
	}

	get [BODY_OVERFLOW](): boolean {
		return this.#overflow
	}

	get body(): ReadableStream<Uint8Array> | null {
		if (!this.#hasBody) return null
		/* once a Fetch Request owns the stream, it is the body */
		if (this.#fetch !== undefined) return this.#fetch.body
		this.#stream ??= this.#cappedStream()
		return this.#stream
	}

	get bodyUsed(): boolean {
		if (this.#fetch !== undefined) return this.#fetch.bodyUsed
		return this.#bodyUsed || (this.#hasBody && this.#incoming.readableEnded)
	}

	/** Aborts when the response closes before it finished: the client left, or the server shut down. */
	get signal(): AbortSignal {
		if (this.#controller === undefined) {
			this.#controller = new AbortController()
			if (this.#abortReason !== undefined) this.#controller.abort(this.#abortReason.reason)
		}
		return this.#controller.signal
	}

	[ABORT_REQUEST](reason: unknown = new DOMException("The client disconnected", "AbortError")): void {
		if (this.#controller !== undefined) this.#controller.abort(reason)
		else this.#abortReason ??= { reason }
	}

	/** The real Fetch `Request` behind the view: `new Request(x)`, `fetch(x)` and `instanceof` take it. */
	[TO_FETCH_REQUEST](): Request {
		return this.#asFetch()
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const buf = await this.#read()
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
	}

	async bytes(): Promise<Uint8Array> {
		const buf = await this.#read()
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
	}

	/** As Fetch: an empty body is a `SyntaxError`, not `null`. */
	async json(): Promise<unknown> {
		return JSON.parse(await this.text())
	}

	async text(): Promise<string> {
		return (await this.#read()).toString("utf8")
	}

	blob(): Promise<Blob> {
		return this.#asFetch().blob()
	}

	clone(): Request {
		return this.#asFetch().clone()
	}

	formData(): Promise<FormData> {
		return this.#asFetch().formData()
	}

	#asFetch(): Request {
		this.#fetch ??= new Request(this.url, {
			body: this.body,
			duplex: "half",
			/* every value of a repeated header, as the view reports them */
			headers: [...this.headers],
			method: this.method,
			signal: this.signal,
		} as RequestInit)
		return this.#fetch
	}

	/** Count bytes against the cap; over it, the read fails with 413 and the rest stays unread. */
	#count(n: number): void {
		this.#received += n
		if (this.#maxBody > 0 && this.#received > this.#maxBody) this.#tooLarge()
	}

	/** A declared length over the cap fails before anything is read. */
	#checkDeclared(): void {
		if (this.#maxBody > 0 && Number(this.#incoming.headers["content-length"]) > this.#maxBody) this.#tooLarge()
	}

	#tooLarge(): never {
		this.#overflow = true
		throw new HoneyError({ errorKey: EK.content_too_large, status: "content_too_large" })
	}

	#cappedStream(): ReadableStream<Uint8Array> {
		/* Node's web stream and the DOM ReadableStream brands do not overlap */
		if (this.#maxBody <= 0) return Readable.toWeb(this.#incoming) as unknown as ReadableStream<Uint8Array>
		const chunks = this.#incoming[Symbol.asyncIterator]()
		return new ReadableStream<Uint8Array>({
			cancel: async () => {
				await chunks.return?.()
			},
			pull: async (controller) => {
				try {
					this.#checkDeclared()
					const { done, value } = (await chunks.next()) as IteratorResult<Buffer>
					if (done === true) return controller.close()
					this.#count(value.byteLength)
					controller.enqueue(value)
				} catch (error) {
					controller.error(error)
					void chunks.return?.()
				}
			},
		})
	}

	async #read(): Promise<Buffer> {
		/* a request without a body reads as empty, any number of times */
		if (!this.#hasBody) return Buffer.alloc(0)
		if (this.bodyUsed) throw new TypeError("Body has already been used")
		this.#bodyUsed = true
		if (this.#fetch !== undefined) return Buffer.from(await this.#fetch.arrayBuffer())
		if (this.#stream !== undefined) return Buffer.from(await new Response(this.#stream).arrayBuffer())
		this.#checkDeclared()
		const chunks: Buffer[] = []
		for await (const chunk of this.#incoming as AsyncIterable<Buffer>) {
			this.#count(chunk.byteLength)
			chunks.push(chunk)
		}
		return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)
	}
}

/**
 * The Request the app sees for `incoming`. It is not a Fetch `Request` (`instanceof Request` is
 * false): `toFetchRequest()` gives the real one. A body over `maxBody` bytes fails its read with
 * 413; `0` turns the cap off.
 */
export function nodeRequest(incoming: IncomingMessage, url: string, maxBody: number): Request {
	return new NodeRequest(incoming, url, maxBody) as unknown as Request
}
