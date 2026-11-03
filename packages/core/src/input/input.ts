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
import { type ParamSchemas, paramsStep } from "./params.ts"
import { searchInput } from "./query.ts"
import { parsePattern, patternParams } from "../routing/pattern.ts"
import type { ParamKeys, ParamsFromPath } from "../routing/types.ts"

/**
 * A source whose schema documents the shape (for the client and docs) but is not run: a body is
 * left unread for the handler to stream from `ctx.req`, a non-body source passes as parsed.
 */
export type ReadableStreamSchema<S> = {
	/** Marks the entry as a `readableStream()` wrapper. */
	readonly _tag: "readableStream"
	/** The schema that documents the source without being run. */
	readonly schema: S
}

/** Hand the source on unvalidated: see {@link ReadableStreamSchema}. */
export function readableStream<S extends StandardSchemaLike>(schema: S): ReadableStreamSchema<S> {
	return { _tag: "readableStream", schema }
}

/** A source's schema, or its `readableStream()` wrapper. */
export type InputEntry = StandardSchemaLike | ReadableStreamSchema<StandardSchemaLike>

/**
 * The non-body sources: all a WebSocket route may declare, since an upgrade has no body. A value its schema rejects
 * answers 400 `validation_failed`.
 */
export type NonBodyInput = {
	/** Schema for the request's cookies, a record by name holding the first value of a repeated name. */
	readonly cookies?: InputEntry
	/** Schema for the request headers, a record with lower-case names. */
	readonly headers?: InputEntry
	/**
	 * A schema for each path param that needs one, by name, validated onto `ctx.params`; every other param stays the
	 * string the path carried. A name the path does not have is a type error and throws at registration.
	 */
	readonly params?: ParamSchemas
	/**
	 * Schema for the query string. A repeated key follows the schema: a key it types as an array gets every value, a
	 * key it types as a scalar the first.
	 */
	readonly search?: InputEntry
}

/** What `.input()` takes: json, form and binary are exclusive, as a request carries one body. */
export type InputSchemas =
	| (NonBodyInput & {
			/** Not allowed beside `form`. */
			readonly binary?: never
			/** Schema for a urlencoded or multipart form body; any other media type answers 415. */
			readonly form?: InputEntry
			/** Not allowed beside `form`. */
			readonly json?: never
	  })
	| (NonBodyInput & {
			/** Not allowed beside `json`. */
			readonly binary?: never
			/** Not allowed beside `json`. */
			readonly form?: never
			/** Schema for a JSON body; any other media type answers 415, an empty or unparseable body 400. */
			readonly json?: InputEntry
	  })
	| (NonBodyInput & {
			/** The media types accepted as a raw body; any other answers 415 before the body is read. */
			readonly binary?: BinaryTypes
			/** Not allowed beside `binary`. */
			readonly form?: never
			/** Not allowed beside `binary`. */
			readonly json?: never
	  })

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

/** The keys ctx.input carries: every declared source except the params (on `ctx.params`) and a body left unread. */
type InputKey<T> = {
	[K in keyof T]-?: [NonNullable<T[K]>] extends [never]
		? never
		: K extends "params"
			? never
			: K extends "form" | "json"
				? NonNullable<T[K]> extends ReadableStreamSchema<unknown>
					? never
					: K
				: K
}[keyof T]

/** ctx.input for a declaration: each source as validated, typed by its schema. */
export type InferInputMap<T> = { readonly [K in InputKey<T>]: SourceValue<K, NonNullable<T[K]>> }

/** `TPathParams` with each param `TSchemas` declares typed by `TSchema`'s side of its schema. */
type WithParamSchemas<TPathParams, TSchemas, TOutput extends boolean> = {
	[K in keyof TPathParams | keyof TSchemas]: K extends keyof TSchemas
		? TOutput extends true
			? InferOutput<TSchemas[K]>
			: InferInput<TSchemas[K]>
		: K extends keyof TPathParams
			? TPathParams[K]
			: never
}

/** One source as a client sends it: the schema's input type, a `readableStream()` entry by the schema it wraps. */
type RequestValue<K, E, TPathParams> = K extends "binary"
	? BinaryBody<Extract<BinaryTypeOf<E>, string>>
	: K extends "params"
		? WithParamSchemas<TPathParams, E, false>
		: InferInput<E extends ReadableStreamSchema<infer S> ? S : E>

/** The keys a client sends: every declared source, a body left unread included. */
type RequestKey<T> = { [K in keyof T]-?: [NonNullable<T[K]>] extends [never] ? never : K }[keyof T]

/** What a client sends for a declaration (the route record's `request`): `readableStream()` entries unwrapped. */
export type InferRequestMap<T, TPathParams = {}> = {
	readonly [K in RequestKey<T>]: RequestValue<K, NonNullable<T[K]>, TPathParams>
}

/** `ctx.params` for a route at `TPath` declaring `T`: the declared params as their schemas produce them. */
export type InferParams<T, TPath extends string> = T extends { readonly params?: infer P }
	? [NonNullable<P>] extends [never]
		? ParamsFromPath<TPath>
		: WithParamSchemas<ParamsFromPath<TPath>, NonNullable<P>, true>
	: ParamsFromPath<TPath>

/** `T` with each declared params key the path at `TPath` does not name mapped to `never`: a typo is an error there. */
export type KnownParams<T, TPath extends string> = T extends { readonly params?: infer P }
	? {
			/** The declared params, each one a param of the path. */ readonly params?: {
				readonly [K in keyof NonNullable<P>]: K extends ParamKeys<TPath> ? NonNullable<P>[K] : never
			}
		}
	: unknown

/** What `.input()` records at the type level: the handler's ctx.input and ctx.params, and the client's request. */
export type InputTypes<T, TPath extends string = string> = {
	/** The handler's `ctx.input`. */
	input: InferInputMap<T>
	/** The handler's `ctx.params`. */
	params: InferParams<T, TPath>
	/** What a client sends. */
	request: InferRequestMap<T, ParamsFromPath<TPath>>
}

/** What the input step reads off a request context. */
type InputCtx = {
	/** The request cookies by name. */
	readonly cookies: Record<string, string>
	/** The request headers, with lower-case names. */
	readonly headers: Record<string, string>
	/** Set by the input step once every source has passed; a body left unread has no key in it. */
	input?: unknown
	/** The path parameters by name: the input step puts the validated ones in place. */
	params: Record<string, unknown>
	/** The request, whose body the step reads. */
	readonly req: Request
	/** Every query string value, repeated keys included. */
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

/** A source with no ctx.input key: a body left unread for the handler, or the params, put on ctx.params. */
const UNREAD: unique symbol = /* @__PURE__ */ Symbol("honey.unread")

/** The body source, read once, or UNREAD for a `readableStream()` body. */
function readBody(body: Compiled, ctx: InputCtx, parser: BodyParser): unknown {
	if (body.schema === null) return UNREAD
	return parser === "json" ? jsonInput(body.schema, ctx.req) : formInput(body.schema, ctx.req, parser, body.shape)
}

/** Throws, naming the route, for a declared param `path` does not have. */
function assertParamsNamed(schemas: ParamSchemas, methods: readonly string[], path: string): void {
	const names = patternParams(parsePattern(path))
	for (const key of Object.keys(schemas))
		if (!names.includes(key))
			throw new Error(
				`${methods.join(",")} ${path}: .input() params key "${key}" is no param of the path (${names.join(", ")})`,
			)
}

/** The params read: validated onto ctx.params, which code after the step reads as it does without a schema. */
function paramsRead(schemas: ParamSchemas): (ctx: InputCtx) => unknown {
	const step = paramsStep(schemas)
	const place = (ctx: InputCtx, params: unknown): typeof UNREAD => {
		ctx.params = params as Record<string, unknown>
		return UNREAD
	}
	return (ctx) => {
		const params = step(ctx.params as Record<string, string>)
		return params instanceof Promise ? params.then((settled) => place(ctx, settled)) : place(ctx, params)
	}
}

/**
 * Compile `schemas` for a route at `path` reached by `methods`. A body schema on a route only GET
 * or HEAD reach, more than one body source, a malformed binary type, or a params key the path does not have throws
 * here, at registration.
 */
export function compileInput(schemas: InputSchemas, methods: readonly string[], path: string): InputStep {
	assertBodySchemaAllowed(schemas, methods, path)
	if (schemas.params !== undefined) assertParamsNamed(schemas.params, methods, path)
	const search = compile(schemas.search)
	const headers = compile(schemas.headers)
	const cookies = compile(schemas.cookies)
	const json = compile(schemas.json)
	const form = compile(schemas.form)
	const reads: Array<[string, (ctx: InputCtx) => unknown]> = []
	if (schemas.params !== undefined) reads.push(["params", paramsRead(schemas.params)])
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
				if (settled !== UNREAD) input[key] = settled
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
