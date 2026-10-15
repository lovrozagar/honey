/**
 * `.input()`: what a route declares about the request it takes, compiled once into one step that
 * runs after the route's middleware and before its handler. Sources are read in order (params,
 * search, headers, cookies, then the body), and the first that fails answers. The step stays
 * synchronous until a validator or the body has to wait (F6): a route with only sync validators
 * and no body schema answers without a microtask, and only the route that declares one pays.
 */
import type { MaybePromise } from "../middleware/middleware.ts"
import type { BodyParser } from "../response/media-type.ts"
import { assertBodySchemaAllowed, assertRequestContentType } from "../validation/content-type.ts"
import { type BinaryBody, binaryInput, binaryRanges, type BinaryTypes, binaryType } from "./binary.ts"
import type { InferInput, InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"
import { type Shape, shapeOf } from "../validation/validate-input.ts"
import { cookiesInput } from "./cookies.ts"
import { formInput } from "./form.ts"
import { headersInput } from "./headers.ts"
import { jsonInput } from "./json.ts"
import { paramsInput } from "./params.ts"
import { searchInput } from "./query.ts"

/**
 * A source whose schema documents the shape (for the client and docs) but is not run: a body is
 * left unread for the handler to stream from `ctx.req`, a non-body source passes as parsed.
 */
export type ReadableStreamSchema<S> = { readonly _tag: "readableStream"; readonly schema: S }

/** Hand the source on unvalidated: see {@link ReadableStreamSchema}. */
export function readableStream<S extends StandardSchemaLike>(schema: S): ReadableStreamSchema<S> {
	return { _tag: "readableStream", schema }
}

/** A source's schema, or its `readableStream()` wrapper. */
export type InputEntry = StandardSchemaLike | ReadableStreamSchema<StandardSchemaLike>

/** The non-body sources: all a WebSocket route may declare, since an upgrade has no body. */
export type NonBodyInput = {
	readonly cookies?: InputEntry
	readonly headers?: InputEntry
	readonly params?: InputEntry
	readonly search?: InputEntry
}

/** What `.input()` takes: json, form and binary are exclusive, as a request carries one body. */
export type InputSchemas =
	| (NonBodyInput & { readonly binary?: never; readonly form?: InputEntry; readonly json?: never })
	| (NonBodyInput & { readonly binary?: never; readonly form?: never; readonly json?: InputEntry })
	| (NonBodyInput & { readonly binary?: BinaryTypes; readonly form?: never; readonly json?: never })

/** The media type ctx.input.binary names: a declared essence, or any subtype of a `type/*` range. */
type BinaryTypeOf<T> = (T extends readonly (infer U)[] ? U : T) extends infer E
	? E extends `${infer Type}/*`
		? `${Type}/${string}`
		: E
	: never

/** What an unvalidated non-body source carries: the record as parsed. */
type RawSource<K> = K extends "search" ? Record<string, string | string[]> : Record<string, string>

/** One source on ctx.input: the schema's output, or the raw record a `readableStream()` entry passes. */
type SourceValue<K, E> = K extends "binary"
	? BinaryBody<Extract<BinaryTypeOf<E>, string>>
	: E extends ReadableStreamSchema<unknown>
		? RawSource<K>
		: InferOutput<E>

/** The keys ctx.input carries: every declared source except a body left unread. */
type InputKey<T> = {
	[K in keyof T]-?: [NonNullable<T[K]>] extends [never]
		? never
		: K extends "form" | "json"
			? NonNullable<T[K]> extends ReadableStreamSchema<unknown>
				? never
				: K
			: K
}[keyof T]

/** ctx.input for a declaration: each source as validated, typed by its schema. */
export type InferInputMap<T> = { readonly [K in InputKey<T>]: SourceValue<K, NonNullable<T[K]>> }

/** One source as a client sends it: the schema's input type, a `readableStream()` entry by the schema it wraps. */
type RequestValue<K, E> = K extends "binary"
	? BinaryBody<Extract<BinaryTypeOf<E>, string>>
	: InferInput<E extends ReadableStreamSchema<infer S> ? S : E>

/** The keys a client sends: every declared source, a body left unread included. */
type RequestKey<T> = { [K in keyof T]-?: [NonNullable<T[K]>] extends [never] ? never : K }[keyof T]

/** What a client sends for a declaration (the route record's `request`): `readableStream()` entries unwrapped. */
export type InferRequestMap<T> = { readonly [K in RequestKey<T>]: RequestValue<K, NonNullable<T[K]>> }

/** What `.input()` records at the type level: the handler's ctx.input and the client's request. */
export type InputTypes<T> = { input: InferInputMap<T>; request: InferRequestMap<T> }

/** What the input step reads off a request context. */
type InputCtx = {
	readonly cookies: Record<string, string>
	readonly headers: Record<string, string>
	input?: unknown
	readonly params: Record<string, string>
	readonly req: Request
	readonly searchAll: Record<string, string[]>
}

/** One compiled source: its schema (`null` for a readableStream entry) and, for search and form, its shape. */
type Compiled = { readonly schema: StandardSchemaLike | null; readonly shape: Shape | null }

/** The compiled step: sets ctx.input, or a promise of having set it when something had to wait. */
export type InputStep = (ctx: InputCtx) => Promise<void> | undefined

function compile(entry: InputEntry | undefined): Compiled | null {
	if (entry === undefined) return null
	const schema = "_tag" in entry ? null : entry
	return { schema, shape: schema === null ? null : shapeOf(schema) }
}

/** A body left unread for the handler: no ctx.input key. */
const UNREAD: unique symbol = /* @__PURE__ */ Symbol("honey.unread")

/** The body source, read once, or UNREAD for a `readableStream()` body. */
function readBody(body: Compiled, ctx: InputCtx, parser: BodyParser): unknown {
	if (body.schema === null) return UNREAD
	return parser === "json" ? jsonInput(body.schema, ctx.req) : formInput(body.schema, ctx.req, parser, body.shape)
}

/**
 * Compile `schemas` for a route at `path` reached by `methods`. A body schema on a route only GET
 * or HEAD reach, or json and form together, throws here, at registration.
 */
export function compileInput(schemas: InputSchemas, methods: readonly string[], path: string): InputStep {
	assertBodySchemaAllowed(schemas, methods, path)
	const params = compile(schemas.params)
	const search = compile(schemas.search)
	const headers = compile(schemas.headers)
	const cookies = compile(schemas.cookies)
	const json = compile(schemas.json)
	const form = compile(schemas.form)
	const reads: Array<[string, (ctx: InputCtx) => unknown]> = []
	if (params !== null) reads.push(["params", (ctx) => paramsInput(params.schema, ctx.params)])
	if (search !== null) reads.push(["search", (ctx) => searchInput(search.schema, ctx.searchAll, search.shape)])
	if (headers !== null) reads.push(["headers", (ctx) => headersInput(headers.schema, ctx.headers)])
	if (cookies !== null) reads.push(["cookies", (ctx) => cookiesInput(cookies.schema, ctx.cookies)])
	const body = json ?? form
	if (schemas.binary !== undefined) {
		const ranges = binaryRanges(schemas.binary, methods[0] as string, path)
		reads.push(["binary", (ctx) => binaryInput(ctx.req, binaryType(ranges, ctx.req.headers.get("content-type")))])
	} else if (body !== null) {
		reads.push([
			json !== null ? "json" : "form",
			(ctx) =>
				readBody(body, ctx, assertRequestContentType(schemas, ctx.req.headers.get("content-type")) as BodyParser),
		])
	}
	return (ctx) => run(reads, 0, ctx, {})
}

/**
 * Run `reads` from `from`: synchronously while each answers at once, then after each that has to
 * wait. ctx.input is set once every source passed, so code after a failed step never sees a part.
 */
function run(
	reads: ReadonlyArray<[string, (ctx: InputCtx) => unknown]>,
	from: number,
	ctx: InputCtx,
	input: Record<string, unknown>,
): Promise<void> | undefined {
	for (let i = from; i < reads.length; i++) {
		const [key, read] = reads[i] as [string, (ctx: InputCtx) => unknown]
		const value = read(ctx)
		if (value instanceof Promise) {
			return value.then((settled: unknown) => {
				input[key] = settled
				return run(reads, i + 1, ctx, input)
			})
		}
		if (value !== UNREAD) input[key] = value
	}
	ctx.input = input
	return undefined
}

/** `handler` behind `step`: the handler runs once ctx.input is set, synchronously when the step was. */
export function withInput(
	step: InputStep,
	handler: (ctx: object) => MaybePromise<Response>,
): (ctx: object) => MaybePromise<Response> {
	return (ctx) => {
		const pending = step(ctx as InputCtx)
		return pending === undefined ? handler(ctx) : pending.then(() => handler(ctx))
	}
}
