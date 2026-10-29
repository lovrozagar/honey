import type { ClientConfig, HeadersContext, RequestMeta } from "./config.ts"
import { bindDefaultFetch, parseClientBaseURL } from "./defaults.ts"
import { ClientError, connectionErrors, noAnswer } from "./error.ts"
import { exchangeLog, runRequestHooks, runResponseHooks } from "./hooks.ts"
import { interpolatePath } from "./path.ts"
import { fetchFollowing } from "./redirects.ts"
import {
	defaultSearchParams,
	encodeBody,
	headersOf,
	isReplayable,
	type RequestKind,
	type RequestOptions,
	requestInit,
	requestSignal,
} from "./request.ts"
import {
	errorFromResponse,
	finishRequest,
	isEventStream,
	type Reading,
	type SafeResult,
	type Sent,
} from "./response.ts"
import { parseSSEStream, type SSEEvent } from "./sse.ts"

/** One request, ready to send: where, with what, and the hooks' view of it. */
type Prepared = { body: BodyInit | undefined; headers: Headers; url: URL }

/** One call: its method, path template and options; `refreshes: false` leaves a 401 to the realtime loop. */
type Call = { method: string; opts: RequestOptions; path: string; refreshes?: false }

/** The realtime loop's refresh key, exported by the SDK under no name. */
export const REFRESH_AUTH = /* @__PURE__ */ Symbol("honey.refreshAuth")

/** One operation of a generated SDK: the call, how it is read, and its stale view for the hooks. */
export type Operation = Call & {
	/** the non-JSON media type the operation declares, read as that type; null when it declares no body */
	declared?: string | null
	headers?: readonly string[]
	meta?: RequestMeta
	shouldThrow: boolean
}

/** Ignore a failed cancel: the body is being discarded either way. */
const discard = (response: Response) =>
	response.body?.cancel().catch(() => {
		/* discarded */
	})

export class HTTPClient {
	readonly #config: ClientConfig
	readonly #fetch: typeof fetch
	#base: URL | undefined
	#token: string | null = null
	#refreshing: Promise<string | null> | null = null

	readonly #disposal: AbortSignal | undefined

	/** `disposal` aborts every request in flight and refuses later ones (a generated SDK's `dispose()`). */
	constructor(config: ClientConfig, disposal?: AbortSignal) {
		this.#config = config
		this.#fetch = connectionErrors(bindDefaultFetch(config.fetch))
		this.#disposal = disposal
	}

	/** The base URL, parsed once; a per-call base (C2) is parsed for that call. */
	#baseFor(opts: RequestOptions): URL {
		if (opts.baseURL !== undefined) return parseClientBaseURL(opts.baseURL)
		this.#base ??= parseClientBaseURL(this.#config.baseURL)
		return this.#base
	}

	get #authName(): string {
		return this.#config.authHeaderName ?? "Authorization"
	}

	get #authPrefix(): string {
		return this.#config.authHeaderPrefix ?? (this.#config.authHeaderName === undefined ? "Bearer " : "")
	}

	#query(search: Record<string, unknown>): URLSearchParams {
		const params = (this.#config.buildSearchParams ?? defaultSearchParams)(search)
		if (this.#config.sortSearchParams) params.sort()
		return params
	}

	/** Resolve `path` against the base URL, keeping the base path and query, and assert it stays there. */
	#url(path: string, opts: RequestOptions): URL {
		const resolved = interpolatePath(path, opts.params)
		const base = this.#baseFor(opts)
		const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`
		const url = new URL(base.href)
		url.pathname = `${basePath}${resolved.startsWith("/") ? resolved.slice(1) : resolved}`
		url.hash = ""
		/* params are validated, so this only fires on a malformed template; never send it anywhere else */
		if (url.origin !== base.origin || !url.pathname.startsWith(basePath.slice(0, -1))) {
			throw new Error(`Request path ${JSON.stringify(path)} resolves outside the base URL`)
		}
		if (opts.search) for (const [k, v] of this.#query(opts.search).entries()) url.searchParams.append(k, v)
		return url
	}

	async #headers(opts: RequestOptions, ctx: HeadersContext): Promise<Headers> {
		const configured = this.#config.headers
		const resolved = typeof configured === "function" ? await configured(ctx) : configured
		/* a refreshed token replaces the configured one; per-call headers still win */
		const auth = this.#token === null ? {} : { [this.#authName]: `${this.#authPrefix}${this.#token}` }
		return headersOf([resolved ?? {}, auth, opts.headers ?? {}], opts.cookies, this.#config.requestId !== false)
	}

	/** Share one `onAuthExpired` call between concurrent 401s; reuse a token another request already got. */
	#refresh(rejectedToken: string | null): Promise<string | null> {
		if (this.#token !== null && rejectedToken !== this.#token) return Promise.resolve(this.#token)
		if (this.#refreshing) return this.#refreshing
		const hook = this.#config.onAuthExpired
		if (!hook) return Promise.resolve(null)
		this.#refreshing = Promise.resolve()
			.then(() => hook({ rejectedToken }))
			.then((token) => {
				this.#token = typeof token === "string" && token.length > 0 ? token : null
				return this.#token
			})
			.finally(() => {
				this.#refreshing = null
			})
		return this.#refreshing
	}

	/** The client's one shared refresh; whether a new token is in place. */
	async [REFRESH_AUTH](): Promise<boolean> {
		return (await this.#refresh(this.#token)) !== null
	}

	/** Build the request and let the `onRequest` hooks see and change it. */
	async #prepare({ method, opts, path }: Call, kind: RequestKind, meta?: RequestMeta) {
		const url = this.#url(path, opts)
		const headers = await this.#headers(opts, { method, path })
		if (kind === "stream") {
			headers.set("accept", "text/event-stream")
			if (opts.lastEventId) headers.set("last-event-id", opts.lastEventId)
		}
		const prepared: Prepared = { body: encodeBody(opts, headers), headers, url }
		if (!this.#config.onRequest) return prepared
		const ctx = { body: prepared.body, headers, method, path, state: this.#config.state ?? {}, url: url.toString() }
		prepared.body = await runRequestHooks(this.#config.onRequest, ctx, meta)
		return prepared
	}

	/** Send, following redirects; on a 401 with a refresh hook, retry once with the fresh token. */
	async #transmit(url: URL, init: RequestInit, isRetry: boolean): Promise<Response> {
		const options = { origin: url.origin, policy: this.#config.redirect ?? "same-origin" }
		const response = await fetchFollowing(this.#fetch, url, init, options)
		if (response.status !== 401 || !this.#config.onAuthExpired || isRetry || !isReplayable(init.body)) return response
		const sent = (init.headers as Headers).get(this.#authName)
		const rejected = sent?.startsWith(this.#authPrefix) ? sent.slice(this.#authPrefix.length) : (sent ?? null)
		const token = await this.#refresh(rejected)
		if (token === null) return response
		const headers = new Headers(init.headers)
		headers.set(this.#authName, `${this.#authPrefix}${token}`)
		init.headers = headers
		await discard(response)
		return fetchFollowing(this.#fetch, url, { ...init }, options)
	}

	/** Build, send and post-process one request: hooks, auth refresh, redirects. */
	async #send(call: Call, kind: RequestKind, meta?: RequestMeta, isRetry = false): Promise<Sent> {
		const { method, opts, path } = call
		const { body, headers, url } = await this.#prepare(call, kind, meta)
		const timeout = opts.timeout ?? this.#config.timeout
		const { done, exemptFromTimeout, signal } = requestSignal([opts.signal, this.#disposal], timeout)
		const cleanups: Array<() => void> = [done]
		const finish = () => {
			for (const fn of cleanups.splice(0)) fn()
		}
		const init = requestInit({ body, headers, method, signal }, this.#config)
		const log = exchangeLog(this.#config.onLog, `${method.toUpperCase()} ${path}`)
		try {
			signal?.throwIfAborted()
			let response = await this.#transmit(url, init, isRetry || call.refreshes === false)
			log.answered(response)
			if (this.#config.onResponse) {
				const retry = async () => {
					const again = await this.#send(call, kind, meta, true)
					cleanups.push(again.done)
					return again.response
				}
				const state = this.#config.state ?? {}
				const at = { init, isRetry, meta, method, path, response, retry, state, url }
				response = await runResponseHooks(this.#config.onResponse, at)
			}
			return { done: finish, exemptFromTimeout, failed: (cause) => noAnswer(cause, url, init), response }
		} catch (e) {
			finish()
			log.failed(e)
			throw e
		}
	}

	#iterate(sent: Sent): AsyncIterable<SSEEvent> {
		const caps = { maxEventBytes: this.#config.sseMaxEventBytes, maxLineBytes: this.#config.sseMaxLineBytes }
		return {
			async *[Symbol.asyncIterator]() {
				try {
					if (sent.response.body) yield* parseSSEStream(sent.response.body, { ...caps, failed: sent.failed })
				} finally {
					sent.done()
				}
			},
		}
	}

	#reading(method: string, opts: RequestOptions, shouldThrow: boolean): Reading {
		return { limits: this.#config, method, raw: opts.raw, shouldThrow }
	}

	/** Throw mode: the parsed body, or a ClientError (a per-status subclass) on non-2xx. */
	async request(method: string, path: string, opts: RequestOptions, meta?: RequestMeta): Promise<unknown> {
		return this.requestOperation({ meta, method, opts, path, shouldThrow: true })
	}

	/** Safe mode: `{ data, error, response, status }`; `error` is truthy for every non-2xx. */
	async requestSafe(method: string, path: string, opts: RequestOptions, meta?: RequestMeta): Promise<SafeResult> {
		return this.requestOperation({ meta, method, opts, path, shouldThrow: false }) as Promise<SafeResult>
	}

	/** One REST operation, read as `op` says: thrown or safe, raw, with its declared response headers (A2). */
	async requestOperation(op: Operation): Promise<unknown> {
		const { declared, headers, meta, method, opts, shouldThrow } = op
		let sent: Sent
		try {
			sent = await this.#send(op, "rest", meta)
		} catch (e) {
			/* a request that could not be built (status 0) is a safe-mode result like any other failure */
			if (shouldThrow || !(e instanceof ClientError)) throw e
			return { data: null, error: e, response: e.response, status: e.status }
		}
		return finishRequest(sent, { ...this.#reading(method, opts, shouldThrow), declared, headers })
	}

	/**
	 * One request whose shape is decided by the answer: an event stream becomes an
	 * `AsyncIterable<SSEEvent>` (never buffered, exempt from the timeout once headers arrive);
	 * anything else is read as in `request` / `requestSafe`.
	 */
	async requestAuto(method: string, path: string, opts: RequestOptions, shouldThrow: boolean): Promise<unknown> {
		const sent = await this.#send({ method, opts, path }, "auto")
		if (!sent.response.ok || !isEventStream(sent.response) || opts.raw)
			return finishRequest(sent, this.#reading(method, opts, shouldThrow))
		sent.exemptFromTimeout()
		return this.#iterate(sent)
	}

	requestStream(method: string, path: string, opts: RequestOptions, meta?: RequestMeta): AsyncIterable<SSEEvent> {
		return this.streamOperation({ meta, method, opts, path })
	}

	/** An event stream, sent when iteration starts; `onOpen` runs once the answer is ok. */
	streamOperation(op: Call & { meta?: RequestMeta; onOpen?: (response: Response) => void }): AsyncIterable<SSEEvent> {
		const send = () => this.#send(op, "stream", op.meta)
		const limits = this.#config
		const iterate = (sent: Sent) => this.#iterate(sent)
		return {
			async *[Symbol.asyncIterator]() {
				const sent = await send()
				/* the timeout bounded the open; the stream itself is never cut by it */
				sent.exemptFromTimeout()
				if (!sent.response.ok) {
					try {
						throw await errorFromResponse(sent.response, limits)
					} finally {
						sent.done()
					}
				}
				op.onOpen?.(sent.response)
				yield* iterate(sent)
			},
		}
	}

	buildUrl(path: string, opts: RequestOptions): string {
		return this.#url(path, opts).toString()
	}

	buildPath(path: string, opts: RequestOptions): string {
		const resolved = interpolatePath(path, opts.params)
		const qs = opts.search ? this.#query(opts.search).toString() : ""
		return qs ? `${resolved}?${qs}` : resolved
	}

	buildWSUrl(path: string, opts: RequestOptions): string {
		const url = this.#url(path, opts)
		if (url.protocol === "https:") url.protocol = "wss:"
		else if (url.protocol === "http:") url.protocol = "ws:"
		return url.toString()
	}
}
