import type { ClientConfig, RequestMeta } from "./config.ts"
import { ClientError, DecodeError } from "./error.ts"
import { HTTPClient } from "./http.ts"
import { interpolatePath, PathParamError } from "./path.ts"
import { newClientRequestId, type RequestOptions } from "./request.ts"
import { type Answer, resultOf } from "./response.ts"
import { resolveInvalidationTargets, StaleIndex } from "./stale.ts"

/** One operation as the service map holds it: where it goes and how its answer is read. */
export type ServiceEntry = {
	/** the declared non-JSON media type, sent as `Accept` */
	accept?: string
	/** the operation declares no success body: a 2xx answer is null, its body reached only through `raw` */
	empty?: boolean
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
	/** how a stream, WebSocket or realtime operation is called; a REST one has none */
	call?: OperationCall
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

/** What a REST call takes; a stream, WebSocket or realtime operation's own call types its input further. */
export type CallInput = RequestOptions

export type OperationFn<I = CallInput> = (input?: I) => unknown

/** The function a non-REST entry is called through: its own adapter, which the service map names. */
export type OperationCall = (core: SdkCore, entry: ServiceEntry, safe: boolean) => OperationFn<never>

const isEntry = (node: unknown): node is ServiceEntry =>
	typeof node === "object" &&
	node !== null &&
	Object.hasOwn(node, "method") &&
	typeof (node as ServiceEntry).method === "string"

/** Only the map's own keys are operations: never `toString`, `constructor` or `then`. */
const childOf = (node: ServiceMapNode, key: string): ServiceMapNode | undefined =>
	Object.hasOwn(node, key) ? (node as Record<string, ServiceMapNode>)[key] : undefined

/** The template the runtime interpolates: a wildcard param's `{name}` becomes the rest-of-path `*name`. */
export function templateOf(entry: ServiceEntry): string {
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
export function optionsFor(entry: ServiceEntry, input: CallInput): RequestOptions {
	const headers: Record<string, string | undefined> = {}
	if (entry.accept) headers["accept"] = entry.accept
	Object.assign(headers, input.headers)
	if (entry.idempotent && !Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key"))
		headers["Idempotency-Key"] = input.idempotencyKey ?? newClientRequestId()
	return { ...input, headers }
}

/** The client behind a generated SDK class: operations from the service map, read-after-write tracking, dispose. */
export class SdkCore {
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
	meta(selector: string, path: string, method: string): RequestMeta | undefined {
		if (!this.#stale) return undefined
		const { by, isStale } = this.#stale.lookup(selector, path, method, Date.now())
		return { invalidatedBy: by, isStale, selector, seqSnapshot: this.#seq }
	}

	/** Mark what a successful mutation `selector` invalidates. */
	mark(entry: ServiceEntry, params: Record<string, string> | undefined, selector: string): void {
		if (!this.#stale || !entry.invalidate?.length) return
		const now = Date.now()
		const at = { now, seq: ++this.#seq, until: now + (this.#config.invalidation?.staleTime ?? 0) }
		for (const target of resolveInvalidationTargets(entry.invalidate, params)) this.#stale.mark(target, selector, at)
	}

	/** A REST op's answer, its `x-invalidate` targets marked and its stale mark cleared once it is a 2xx. */
	async request(entry: ServiceEntry, input: CallInput): Promise<Answer> {
		const template = templateOf(entry)
		let path: string
		try {
			path = interpolatePath(template, input.params)
		} catch (e) {
			throw e instanceof PathParamError ? pathError(e, entry) : e
		}
		const selector = `${entry.method} ${path}`
		const meta = this.meta(selector, path, entry.method)
		const opts = optionsFor(entry, input)
		const declared = entry.empty ? null : entry.accept
		const settle = () => {
			this.mark(entry, input.params, selector)
			if (meta?.isStale) this.#stale?.clear(selector, path, entry.method, meta.seqSnapshot)
		}
		try {
			const answer = await this.http.requestOperation({ declared, meta, method: entry.method, opts, path: template })
			settle()
			return answer
		} catch (e) {
			/* a 2xx whose body does not decode still changed what it invalidates */
			if (e instanceof DecodeError) settle()
			throw e
		}
	}
}

/** The function an entry is called through, named by its member path; a safe one's REST answer a Result. */
function callable(core: SdkCore, entry: ServiceEntry, name: string, safe: boolean): OperationFn<never> {
	let fn: OperationFn<never>
	/* a stream, WebSocket or realtime op is called through the adapter its entry names */
	if (entry.call) fn = entry.call(core, entry, safe)
	else if (safe) fn = (input?: CallInput) => resultOf(core.request(entry, input ?? {}), entry.headers)
	else fn = async (input?: CallInput) => (await core.request(entry, input ?? {})).data
	Object.defineProperty(fn, "name", { value: name })
	return fn
}

/** A namespace of the map: each read of a key returns the same function or namespace object. */
function namespace(core: SdkCore, node: ServiceMapNode, path: readonly string[], safe: boolean): object {
	const members = new Map<string, unknown>()
	return new Proxy({} as Record<string, unknown>, {
		get(target, key: string | symbol) {
			if (typeof key === "symbol") return Reflect.get(target, key)
			const child = childOf(node, key)
			if (child === undefined) return Reflect.get(target, key)
			return memberOf(core, members, { child, path: [...path, key], safe })
		},
	})
}

type At = { child: ServiceMapNode; path: string[]; safe: boolean }

/** A member at its node and path, the twin's or not, once: a callable for an entry, a namespace object otherwise. */
function memberOf(core: SdkCore, members: Map<string, unknown>, at: At) {
	const key = at.path.join(".")
	let member = members.get(key)
	if (member === undefined) {
		member = isEntry(at.child) ? callable(core, at.child, key, at.safe) : namespace(core, at.child, at.path, at.safe)
		members.set(key, member)
	}
	return member
}

/** `config` with the API's auth scheme as its header pair's default. */
export function schemeAuth<T extends ClientConfig>(config: T, headerName: string, prefix: string): T {
	if (config.authHeaderName !== undefined) return config
	return { ...config, authHeaderName: headerName, authHeaderPrefix: config.authHeaderPrefix ?? prefix }
}

/**
 * A generated SDK's base class. The instance is a Proxy over the service map: `sdk.users.create(input)`
 * dispatches the entry at `users.create`; the client's own members (`safe`, `state`, `dispose`, `toString`)
 * always win, and a key the map does not hold reads as `undefined`.
 */
export class SDKClient {
	/** the same operations, each answering a Result, never throwing an API answer (bit 21 i) */
	readonly safe: object
	state: Record<string, unknown>
	readonly #core: SdkCore

	constructor(serviceMap: ServiceMap, config: SDKConfig) {
		this.state = config.state ?? {}
		this.#core = new SdkCore({ ...config, state: this.state })
		const core = this.#core
		this.safe = namespace(core, serviceMap, [], true)
		const members = new Map<string, unknown>()
		return new Proxy(this, {
			get(target, key: string | symbol) {
				if (typeof key === "symbol" || key in target) {
					const value: unknown = Reflect.get(target, key)
					return typeof value === "function" ? value.bind(target) : value
				}
				const child = childOf(serviceMap, key)
				return child === undefined ? undefined : memberOf(core, members, { child, path: [key], safe: false })
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
