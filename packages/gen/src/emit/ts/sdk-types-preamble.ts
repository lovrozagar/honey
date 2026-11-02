/**
 * What a `${stem}.types.gen.ts` says before its own types: the import line, naming only the runtime
 * types the file goes on to read, and the vocabulary every generated client shares (the call and
 * stream shapes, the error envelope, the safe mirror). Here so sdk-types.ts holds only how a
 * document becomes those types.
 */
import type { TsRuntimeFeatures } from "./http.ts"

/* globals the emitted types read, and the names they declare: a component schema never takes one */
export const RESERVED = [
	"AbortSignal",
	"ArrayBuffer",
	"AsyncIterable",
	"Blob",
	"ErrorEnvelope",
	"ErrorField",
	"HoneyArgs",
	"HoneyCall",
	"HoneySafe",
	"HoneyStream",
	"HttpOptions",
	"Omit",
	"Promise",
	"ReadableStream",
	"RealtimeCallOptions",
	"RealtimeOptions",
	"Record",
	"ResumableConnection",
	"Response",
	"Result",
	"SDKConfig",
	"SSEEvent",
	"SseOptions",
	"TypedWebSocket",
	"Uint8Array",
	"WsOptions",
]

/** What the types file may import from the runtime module, in the order the import lists them. */
const RUNTIME_TYPES = [
	"RealtimeOptions",
	"Result",
	"ResumableConnection",
	"SDKConfig",
	"SSEEvent",
	"TypedWebSocket",
] as const

/** The input fields every call takes, by transport. */
const OPTIONS = `export type HttpOptions = {
	baseURL?: string
	cookies?: Record<string, string>
	headers?: Record<string, string>
	idempotencyKey?: string
	signal?: AbortSignal
	timeout?: number
}
export type SseOptions = Omit<HttpOptions, "idempotencyKey"> & { lastEventId?: string }
export type WsOptions = { protocols?: string | string[]; reconnectToken?: string }
`

/* the error envelope, the call and stream shapes, and the safe mirror's opening */
const CALLS = `
type ErrorField = { error_key: string; message: string; path: string }

/** honey's error envelope at one status, its error keys as literals. */
export type ErrorEnvelope<TStatus extends number, TKey extends string> = {
	error_key: TKey
	fields: Record<string, ErrorField[]>
	message: string
	status: TStatus
	status_key: string
	success: false
}

/* a call's declared errors and headers, which only its safe twin reads: a type, never a value */
declare const answer: unique symbol

/** A call's input: optional when none of its fields is required. */
type HoneyArgs<I, O> = {} extends I ? [input?: I & O] : [input: I & O]

/** A REST operation: its raw overload and its value, an error status thrown; its declared errors and headers. */
type HoneyCall<I, D, E = never, H = never> = {
	(input: I & HttpOptions & { raw: true }): Promise<Response>
	(...input: HoneyArgs<I, HttpOptions & { raw?: false }>): Promise<D>
	readonly [answer]?: [E, H]
}

/** An event stream, sent when its iteration starts; its opening answer's declared errors. */
type HoneyStream<I, V, E = never> = {
	(...input: HoneyArgs<I, SseOptions>): AsyncIterable<V>
	readonly [answer]?: [E, never]
}

/** \`client.safe\`: every REST and stream call answering a Result, never throwing an API answer; a connection as is. */
export type HoneySafe<T> = {
	[K in keyof T]: `

/* the safe mirror's REST and stream arms */
const SAFE_ARMS = `			? {
					(input: I & HttpOptions & { raw: true }): Promise<Result<Response, E>>
					(...input: HoneyArgs<I, HttpOptions & { raw?: false }>): Promise<Result<D, E, H>>
				}
			: T[K] extends HoneyStream<infer I, infer V, infer E>
				? (...input: HoneyArgs<I, SseOptions>) => Promise<Result<AsyncIterable<V>, E>>
				: HoneySafe<T[K]>
}
`

/** The input fields every call takes, by transport, and the safe twin's types, for an API with `features`. */
export function shared(features: TsRuntimeFeatures): string {
	const connections = [
		...(features.realtime ? ["ResumableConnection<infer _>"] : []),
		...(features.ws || features.realtime ? ["TypedWebSocket"] : []),
	]
	const realtime = features.realtime
		? `export type RealtimeCallOptions = Omit<HttpOptions, "idempotencyKey" | "timeout"> & RealtimeOptions\n`
		: ""
	const rest = "T[K] extends HoneyCall<infer I, infer D, infer E, infer H>"
	const safe =
		connections.length === 0
			? rest
			: `T[K] extends (...input: never[]) => ${connections.join(" | ")}\n\t\t? T[K]\n\t\t: ${rest}`
	return `${OPTIONS}${realtime}${CALLS}${safe}\n${SAFE_ARMS}`
}

/** The runtime types this text names, in order: a document with no realtime route uses neither
 *  `SSEEvent` nor `ResumableConnection`, and an import a file never reads is a consumer's error
 *  under `noUnusedLocals`. A type in `aliases` is imported, and named in `body`, by its alias. */
export function importText(body: string, runtime: string, aliases: Readonly<Record<string, string>> = {}): string {
	const used = RUNTIME_TYPES.flatMap((type) => {
		const local = aliases[type] ?? type
		if (!new RegExp(`\\b${local}\\b`).test(body)) return []
		return local === type ? [type] : [`${type} as ${local}`]
	})
	return `import type { ${used.join(", ")} } from "./${runtime}"\n`
}
