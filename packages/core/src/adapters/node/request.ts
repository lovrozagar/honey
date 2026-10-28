/**
 * The `node:http` → Fetch side of the Node adapter: a Request-shaped view of the IncomingMessage
 * that builds a real `Request` only when something needs one (formData, blob, clone,
 * `toFetchRequest`).
 */
import type { IncomingMessage } from "node:http"
import { Readable } from "node:stream"
import { PEER_ADDRESS } from "../../context/peer.ts"
import { EK, HoneyError } from "../../errors/error.ts"
import { NODE_OUTBOUND } from "../../response/builder.ts"
import { REPLACE_BODY, TO_FETCH_REQUEST } from "../fetch-request.ts"
import { NodeHeaders } from "./headers.ts"

/** The serve side calls this when the response closed before it finished: client gone, or shutdown. */
export const ABORT_REQUEST: unique symbol = /* @__PURE__ */ Symbol("honey.abortRequest")

/** True once a body read went over the cap: the body is left on the socket, so the connection is not reused. */
export const BODY_OVERFLOW: unique symbol = /* @__PURE__ */ Symbol("honey.bodyOverflow")

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

	/** Swap the body for `body` (bodyLimit's counted stream) and stay the view: nothing has read it yet. */
	[REPLACE_BODY](body: ReadableStream<Uint8Array>): void {
		this.#stream = body
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

	clone(): ReturnType<Request["clone"]> {
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
