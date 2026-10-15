import type { ClientConfig, RequestMeta } from "./config.ts"
import { ClientError } from "./error.ts"
import { HTTPClient } from "./http.ts"
import { interpolatePath, PathParamError } from "./path.ts"
import { newClientRequestId, type RequestOptions } from "./request.ts"
import type { SSEEvent } from "./sse.ts"
import { resolveInvalidationTargets, StaleIndex } from "./stale.ts"
import { createTypedWebSocket, type TypedWebSocket } from "./ws.ts"

/** One operation as the service map holds it: where it goes and how its answer is read. */
export type ServiceEntry = {
	/** the declared non-JSON media type, sent as `Accept` */
	accept?: string
	/** the declared response headers, lower case (A2) */
	headers?: readonly string[]
	idempotent?: boolean
	invalidate?: readonly string[]
	method: string
	params?: readonly string[]
	/** the OpenAPI path template, `{param}` kept */
	path: string
	realtime?: boolean
	/** an event stream; `"json"` when its events carry JSON `data` the client parses */
	sse?: boolean | "json"
	/** the param that spans segments (`x-honey-wildcard`) */
	wildcard?: string
	ws?: boolean
}

export type ServiceMapNode = ServiceEntry | { readonly [key: string]: ServiceMapNode }

export type ServiceMap = { readonly [key: string]: ServiceMapNode }

/** Read-after-write tracking: a mutation's `x-invalidate` targets read as stale for `staleTime` ms. */
export type InvalidationConfig = {
	/** how many mutations a stale mark remembers in `invalidatedBy`. Default 16. */
	maxSourcesPerTarget?: number
	/** how many exact stale marks are kept; past it expired, then the oldest, marks go. Default 1000. */
	staleMaxEntries?: number
	staleTime: number
}

export type SDKConfig = ClientConfig & { invalidation?: InvalidationConfig }

/** What a call takes beyond `RequestOptions`: a WebSocket's protocols and resume token. */
type CallInput = RequestOptions & { protocols?: string | string[]; reconnectToken?: string }

type OperationFn = (input?: CallInput) => unknown

const isEntry = (node: unknown): node is ServiceEntry =>
	typeof node === "object" &&
	node !== null &&
	Object.hasOwn(node, "method") &&
	typeof (node as ServiceEntry).method === "string"

/** Only the map's own keys are operations: never `toString`, `constructor` or `then`. */
const childOf = (node: ServiceMapNode, key: string): ServiceMapNode | undefined =>
	Object.hasOwn(node, key) ? (node as Record<string, ServiceMapNode>)[key] : undefined

/** The template the runtime interpolates: a wildcard param's `{name}` becomes the rest-of-path `*name`. */
function templateOf(entry: ServiceEntry): string {
	return entry.wildcard === undefined ? entry.path : entry.path.replace(`{${entry.wildcard}}`, `*${entry.wildcard}`)
}

/** A call whose path params cannot form a path, as a status-0 ClientError: no request was sent. */
function pathError(e: PathParamError, entry: ServiceEntry): ClientError {
	return new ClientError({
		body: null,
		message: `${e.message} for ${entry.method} ${entry.path}`,
		response: Response.error(),
		status: 0,
	})
}

/** The per-call options an entry adds: its `Accept` and an `Idempotency-Key`. */
function optionsFor(entry: ServiceEntry, input: CallInput): RequestOptions {
	const headers: Record<string, string | undefined> = {}
	if (entry.accept) headers.accept = entry.accept
	Object.assign(headers, input.headers)
	if (entry.idempotent && !Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key"))
		headers["Idempotency-Key"] = input.idempotencyKey ?? newClientRequestId()
	return { ...input, headers }
}

/** Each event with its `data` parsed as JSON; an event that does not parse fails the stream, naming it. */
function jsonEvents(events: AsyncIterable<SSEEvent>): AsyncIterable<SSEEvent<unknown>> {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const event of events) {
				let data: unknown
				try {
					data = JSON.parse(event.data)
				} catch (e) {
					const name = event.id === undefined ? "an event" : `event ${JSON.stringify(event.id)}`
					const message = `SSE ${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
					throw new ClientError({ body: event.data, message, response: Response.error(), status: 0 })
				}
				yield { ...event, data }
			}
		},
	}
}

/** The client behind a generated SDK class: operations from the service map, read-after-write tracking, dispose. */
class SdkCore {
	readonly http: HTTPClient
	readonly #config: SDKConfig
	readonly #disposal = new AbortController()
	#stale: StaleIndex | null
	#seq = 0

	constructor(config: SDKConfig) {
		this.#config = config
		this.http = new HTTPClient(config, this.#disposal.signal)
		this.#stale = this.#newIndex()
	}

	#newIndex(): StaleIndex | null {
		const invalidation = this.#config.invalidation
		if (!invalidation || invalidation.staleTime <= 0) return null
		const maxSources = Math.max(invalidation.maxSourcesPerTarget ?? 16, 1)
		return new StaleIndex({ maxEntries: invalidation.staleMaxEntries ?? 1000, maxSources })
	}

	dispose(): void {
		this.#disposal.abort(new Error("The client was disposed"))
		this.#stale = this.#newIndex()
	}

	/** The stale view of the read `selector` before it is sent. */
	#meta(selector: string, path: string, method: string): RequestMeta | undefined {
		if (!this.#stale) return undefined
		const { by, isStale } = this.#stale.lookup(selector, path, method, Date.now())
		return { invalidatedBy: by, isStale, selector, seqSnapshot: this.#seq }
	}

	/** Mark what a successful mutation `selector` invalidates. */
	#mark(entry: ServiceEntry, params: Record<string, string> | undefined, selector: string): void {
		if (!this.#stale || !entry.invalidate?.length) return
		const now = Date.now()
		const at = { now, seq: ++this.#seq, until: now + (this.#config.invalidation?.staleTime ?? 0) }
		for (const target of resolveInvalidationTargets(entry.invalidate, params)) this.#stale.mark(target, selector, at)
	}

	async request(entry: ServiceEntry, input: CallInput): Promise<unknown> {
		const shouldThrow = this.#config.throwOnError === true
		const template = templateOf(entry)
		let path: string
		try {
			path = interpolatePath(template, input.params)
		} catch (e) {
			if (!(e instanceof PathParamError)) throw e
			const error = pathError(e, entry)
			if (shouldThrow) throw error
			return { data: null, error, response: error.response, status: 0 }
		}
		const selector = `${entry.method} ${path}`
		const meta = this.#meta(selector, path, entry.method)
		const opts = optionsFor(entry, input)
		const { accept: declared, headers } = entry
		const op = { declared, headers, meta, method: entry.method, opts, path: template, shouldThrow }
		const result = await this.http.requestOperation(op)
		const status = result instanceof Response ? result.status : (result as { status?: number } | null)?.status
		if (shouldThrow || (status !== undefined && status >= 200 && status < 300)) {
			this.#mark(entry, input.params, selector)
			if (meta?.isStale) this.#stale?.clear(selector, path, entry.method, meta.seqSnapshot)
		}
		return result
	}

	/** An SSE op: its stale view for the hooks, and its `x-invalidate` targets marked once the answer is ok. */
	stream(entry: ServiceEntry, input: CallInput): AsyncIterable<unknown> {
		const opts = optionsFor(entry, input)
		const template = templateOf(entry)
		let selector: string | undefined
		let meta: RequestMeta | undefined
		try {
			const path = interpolatePath(template, input.params)
			selector = `${entry.method} ${path}`
			meta = this.#meta(selector, path, entry.method)
		} catch {
			/* a bad param fails the stream when it is sent, as for any call */
		}
		const onOpen = () => {
			if (selector !== undefined) this.#mark(entry, input.params, selector)
		}
		const events = this.http.streamOperation({ meta, method: entry.method, onOpen, opts, path: template })
		return entry.sse === "json" ? jsonEvents(events) : events
	}

	connect(entry: ServiceEntry, input: CallInput): TypedWebSocket {
		const url = new URL(this.http.buildWSUrl(templateOf(entry), { params: input.params, search: input.search }))
		if (input.reconnectToken) url.searchParams.append("reconnect_token", input.reconnectToken)
		const socket = createTypedWebSocket(url.toString(), { protocols: input.protocols })
		if (entry.invalidate?.length) {
			const selector = `WS ${interpolatePath(templateOf(entry), input.params)}`
			socket.on("open", () => this.#mark(entry, input.params, selector))
		}
		return socket
	}
}

/** The function an entry is called through, named by its dotted member path for stack traces. */
function callable(core: SdkCore, entry: ServiceEntry, name: string): OperationFn {
	let fn: OperationFn
	/* a realtime op dispatches by its transport; `realtime` only says the resume runtime applies */
	if (entry.ws) fn = (input) => core.connect(entry, input ?? {})
	else if (entry.sse) fn = (input) => core.stream(entry, input ?? {})
	else fn = (input) => core.request(entry, input ?? {})
	Object.defineProperty(fn, "name", { value: name })
	return fn
}

/** A namespace of the map: each read of a key returns the same function or namespace object. */
function namespace(core: SdkCore, node: ServiceMapNode, path: readonly string[]): object {
	const members = new Map<string, unknown>()
	return new Proxy({} as Record<string, unknown>, {
		get(target, key: string | symbol) {
			if (typeof key === "symbol") return Reflect.get(target, key)
			const child = childOf(node, key)
			if (child === undefined) return Reflect.get(target, key)
			return memberOf(core, members, { child, path: [...path, key] })
		},
	})
}

/** A member, once: a callable for an entry, a namespace object otherwise. */
function memberOf(core: SdkCore, members: Map<string, unknown>, at: { child: ServiceMapNode; path: string[] }) {
	const key = at.path.join(".")
	let member = members.get(key)
	if (member === undefined) {
		member = isEntry(at.child) ? callable(core, at.child, key) : namespace(core, at.child, at.path)
		members.set(key, member)
	}
	return member
}

/**
 * A generated SDK's base class. The instance is a Proxy over the service map: `sdk.users.create(input)`
 * dispatches the entry at `users.create`; the client's own members (`state`, `dispose`, `toString`)
 * always win, and a key the map does not hold reads as `undefined`.
 */
export class SDKClient {
	state: Record<string, unknown>
	readonly #core: SdkCore

	constructor(serviceMap: ServiceMap, config: SDKConfig) {
		this.state = config.state ?? {}
		this.#core = new SdkCore({ ...config, state: this.state })
		const core = this.#core
		const members = new Map<string, unknown>()
		return new Proxy(this, {
			get(target, key: string | symbol) {
				if (typeof key === "symbol" || key in target) {
					const value: unknown = Reflect.get(target, key)
					return typeof value === "function" ? value.bind(target) : value
				}
				const child = childOf(serviceMap, key)
				return child === undefined ? undefined : memberOf(core, members, { child, path: [key] })
			},
		})
	}

	/** Printable: `String(sdk)` is `[object <SdkName>]`. */
	get [Symbol.toStringTag](): string {
		return this.constructor.name
	}

	/** Abort every call in flight, refuse later ones, and drop the stale marks. */
	dispose(): void {
		this.#core.dispose()
	}
}
