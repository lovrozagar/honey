/**
 * The `${stem}.types.gen.ts` text: the component schemas, each operation's input, data, error and
 * header types, the SDK's config, and the interface its class merges with. Types and runtime meet
 * in the member tree, so a renamed member (`state` → `state_`) is renamed in both.
 */
import type { IR, IRBody, IRNamespace, IRParam, IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, isJsonMedia, mediaEssence, type SdkOp, sdkModel, sseEventSchema } from "../../ir/sdk-model.ts"
import { bodiesOf } from "../../ir/slots.ts"
import { blockCommentText, tsString } from "../shared/escape.ts"
import { compareCodeUnits, NameTable, pascalWords } from "../shared/lang.ts"
import { quoteKey } from "../shared/literals.ts"
import { irToTs, type TypeOptions } from "../shared/type-emitter.ts"
import { memberTree } from "./service-map.ts"

/* globals the emitted types read, and the names they declare: a component schema never takes one */
const RESERVED = [
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

/** The input fields every call takes, by transport. */
const SHARED = `export type HttpOptions = {
	baseURL?: string
	cookies?: Record<string, string>
	headers?: Record<string, string>
	idempotencyKey?: string
	signal?: AbortSignal
	timeout?: number
}
export type SseOptions = Omit<HttpOptions, "idempotencyKey"> & { lastEventId?: string }
export type WsOptions = { protocols?: string | string[]; reconnectToken?: string }
export type RealtimeCallOptions = Omit<HttpOptions, "idempotencyKey" | "timeout"> & RealtimeOptions

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
	[K in keyof T]: T[K] extends (...input: never[]) => ResumableConnection<infer _> | TypedWebSocket
		? T[K]
		: T[K] extends HoneyCall<infer I, infer D, infer E, infer H>
			? {
					(input: I & HttpOptions & { raw: true }): Promise<Result<Response, E>>
					(...input: HoneyArgs<I, HttpOptions & { raw?: false }>): Promise<Result<D, E, H>>
				}
			: T[K] extends HoneyStream<infer I, infer V, infer E>
				? (...input: HoneyArgs<I, SseOptions>) => Promise<Result<AsyncIterable<V>, E>>
				: HoneySafe<T[K]>
}
`

/** One field of an input object: required or not, by whether any of its members is. */
type Part = { field: string; required: boolean; type: string }

const objectText = (fields: readonly string[]) => (fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`)

/** A params, search, headers or cookies field from declared parameters. */
function paramsPart(field: string, params: readonly IRParam[], value: (p: IRParam) => string): Part | null {
	if (params.length === 0) return null
	const entries = [...params]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((p) => `${quoteKey(p.name)}${p.required === true ? "" : "?"}: ${value(p)}`)
	return { field, required: params.some((p) => p.required === true), type: objectText(entries) }
}

/** The input field a request body fills, by its media type. */
function bodyField(body: IRBody): "body" | "form" | "json" | null {
	if (body.kind === "stream") return "body"
	if (body.kind === "multipart") return "form"
	if (isJsonMedia(body.contentType)) return "json"
	const essence = mediaEssence(body.contentType)
	return essence === "multipart/form-data" || essence === "application/x-www-form-urlencoded" ? "form" : null
}

/** One input field per body kind, the preferred content type of each kind winning: bytes, JSON, a form. */
function bodyParts(op: SdkOp, types: TypeOptions): Part[] {
	const byField = new Map<string, IRBody>()
	for (const body of bodiesOf(op.ir)) {
		const field = bodyField(body)
		if (field && !byField.has(field)) byField.set(field, body)
	}
	return (["body", "json", "form"] as const).flatMap((field) => {
		const body = byField.get(field)
		if (body === undefined) return []
		/* a multipart file part is a Blob, so a File passes; in JSON a binary field stays a string */
		const type =
			body.kind === "stream"
				? "ArrayBuffer | Blob | ReadableStream<Uint8Array> | Uint8Array"
				: irToTs(body.schema, field === "form" ? { ...types, binary: "Blob" } : types)
		return [{ field, required: body.required, type }]
	})
}

/** A call's input object, and whether it must be passed. */
function inputOf(op: SdkOp, types: TypeOptions): { required: boolean; type: string } {
	/* a header or cookie is text on the wire: an enum keeps its values, anything else is a string */
	const text = (p: IRParam) => (p.schema.kind === "scalar" && p.schema.enum ? irToTs(p.schema, types) : "string")
	const pathParams = op.pathParams.map((p) => ({ ...p, required: true }))
	const parts = [
		paramsPart("params", pathParams, (p) => irToTs(p.schema, types)),
		paramsPart("search", op.query, (p) => irToTs(p.schema, types)),
		paramsPart("headers", op.headers, text),
		paramsPart("cookies", op.ir.params.cookie ?? [], text),
		...bodyParts(op, types),
	].filter((part): part is Part => part !== null)
	const ordered = [...parts.filter((p) => p.required), ...parts.filter((p) => !p.required)]
	const fields = ordered.map((p) => `${p.field}${p.required ? "" : "?"}: ${p.type}`)
	return { required: parts.some((p) => p.required), type: objectText(fields) }
}

/** The data a successful call resolves to: JSON from its schema, text as a string, bytes (A1), else null. */
function dataOf(op: SdkOp, types: TypeOptions): string {
	const { kind, schema } = op.success
	if (kind === "none") return "null"
	if (kind === "text") return "string"
	if (kind === "binary") return "Uint8Array<ArrayBuffer>"
	return schema ? irToTs(schema, types) : "unknown"
}

/** The declared error bodies by concrete status; honey's envelope with its keys as literals. */
function errorsOf(op: SdkOp, types: TypeOptions, resolve: (schema: IRSchema) => IRSchema): string | null {
	const entries = op.errorStatuses.flatMap((status) => {
		const response = op.ir.responses[String(status)]
		if (!response?.schema || !response.contentType || !isJsonMedia(response.contentType)) return []
		const envelope = irErrorEnvelope(response.schema, resolve)
		if (!envelope) return [`${status}: ${irToTs(response.schema, types)}`]
		return [`${status}: ErrorEnvelope<${envelope.status}, ${envelope.keys.map(tsString).join(" | ")}>`]
	})
	return entries.length === 0 ? null : `{ ${entries.join("; ")} }`
}

/** The success answer's declared headers, lower case, a required one required (A2). */
function headersOf(op: SdkOp): string | null {
	const declared = op.ir.responses[op.success.status]?.headers ?? []
	if (declared.length === 0) return null
	const byName = new Map(declared.map((h) => [h.name.toLowerCase(), h.required]))
	const fields = [...byName].sort(([a], [b]) => compareCodeUnits(a, b))
	return objectText(fields.map(([name, required]) => `${quoteKey(name)}${required ? "" : "?"}: string`))
}

/** `op`'s member line `name`: a REST call a HoneyCall, a stream a HoneyStream, defaults dropped; a connection its method. */
function signature(name: string, op: SdkOp, ctx: Context): string {
	const input = inputOf(op, ctx.types)
	const arg = (extra: string) => {
		const type = input.type === "{}" ? extra : `${input.type} & ${extra}`
		return `${input.required ? "input" : "input?"}: ${type}`
	}
	const key = quoteKey(name)
	/* a realtime op is one resumable connection of its event data; any other is typed by its transport */
	const { realtime, sse, websocket } = op.ir.extensions
	if (realtime) {
		const events = sseEventSchema(op.ir, ctx.resolve)
		return `${key}(${arg("RealtimeCallOptions")}): ResumableConnection<${events ? irToTs(events, ctx.types) : "unknown"}>`
	}
	if (websocket) return `${key}(${arg("WsOptions")}): TypedWebSocket`
	const errors = errorsOf(op, ctx.types, ctx.resolve)
	if (sse) {
		const events = sseEventSchema(op.ir, ctx.resolve)
		const event = events === undefined ? "SSEEvent" : `SSEEvent<${irToTs(events, ctx.types)}>`
		return `${key}: HoneyStream<${[input.type, event, ...(errors === null ? [] : [errors])].join(", ")}>`
	}
	const headers = headersOf(op)
	const tail = headers === null ? (errors === null ? [] : [errors]) : [errors ?? "never", headers]
	return `${key}: HoneyCall<${[input.type, dataOf(op, ctx.types), ...tail].join(", ")}>`
}

type Context = { ops: Map<string, SdkOp>; resolve: (schema: IRSchema) => IRSchema; types: TypeOptions }

/* every line break a comment splits at, as the shared comment writers split (escape.ts) */
const LINE_BREAKS = /\r\n|\r|\n|\u2028|\u2029/

/**
 * `op`'s summary and description as a JSDoc block above its overloads at `indent`, a paragraph each, as Go, Rust,
 * Python and C# write them; spec text made inert by blockCommentText. None for an operation with neither.
 */
function opDoc(op: SdkOp, indent: string): string[] {
	const paragraphs = [op.summary, op.description].filter((text) => text !== "")
	if (paragraphs.length === 0) return []
	const lines = paragraphs.flatMap((text, i) => [
		...(i === 0 ? [] : [""]),
		...blockCommentText(text).split(LINE_BREAKS),
	])
	return [
		`${indent}/**`,
		...lines.map((line) => (line.trim() === "" ? `${indent} *` : `${indent} * ${line}`)),
		`${indent} */`,
	]
}

/** A namespace's members as type-literal lines, nested namespaces as nested literals. */
function members(ns: IRNamespace, ctx: Context, indent: string): string[] {
	return [...ns.entries].flatMap(([name, entry]) => {
		if (entry.kind === "method") {
			const op = ctx.ops.get(entry.op.id) as SdkOp
			return [...opDoc(op, indent), `${indent}${signature(name, op, ctx)}`]
		}
		return [`${indent}${quoteKey(name)}: {`, ...members(entry.ns, ctx, `${indent}\t`), `${indent}}`]
	})
}

/**
 * The component schemas' declared names, clear of `reserved` (the names the emitted file declares
 * and the globals it reads), claimed in code-unit order so the same document names them alike.
 */
export function componentNames(ir: IR, reserved: readonly string[]): (schema: string) => string {
	const table = new NameTable(reserved)
	for (const schema of Object.keys(ir.schemas).sort(compareCodeUnits)) {
		const base = pascalWords(schema) || "Schema"
		table.get(schema, /^[0-9]/.test(base) ? `Schema${base}` : base)
	}
	return (schema) => table.get(schema, "Schema")
}

/** The config type: `baseURL` optional when the document declares a server, the first one being its default. */
function configText(name: string, server: string | undefined): string {
	const head = `export type ${name}Config =`
	if (server === undefined) return `${head} SDKConfig`
	return `${head} Omit<SDKConfig, "baseURL"> & {
	/** Default: the document's first server, ${blockCommentText(server)} */
	baseURL?: string
}`
}

/** The `${stem}.types.gen.ts` text of `ir` for the SDK `name`, importing the runtime module `runtime`. */
export function sdkTypesText(ir: IR, name: string, runtime: string): string {
	const model = sdkModel(ir)
	const own = [name, `${name}Config`, `${name}Operations`, `${name}Safe`]
	const types: TypeOptions = { refName: componentNames(ir, [...RESERVED, ...own]) }
	const ctx: Context = { ops: model.opsById, resolve: model.resolve, types }
	const schemas = model.schemaNames.map(
		(schema) => `export type ${types.refName?.(schema)} = ${irToTs(ir.schemas[schema] as IRSchema, types)}`,
	)
	return `import type { RealtimeOptions, Result, ResumableConnection, SDKConfig, SSEEvent, TypedWebSocket } from "./${runtime}"

${schemas.length === 0 ? "" : `${schemas.join("\n")}\n\n`}${SHARED}
${configText(name, ir.servers[0])}

/** Every operation of the SDK, by its member path. */
export interface ${name}Operations {
${members(memberTree(ir.tree), ctx, "\t").join("\n")}
}

/** \`client.safe\`: every operation, a call answering a Result. */
export type ${name}Safe = HoneySafe<${name}Operations>
`
}
