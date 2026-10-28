/**
 * The `.output()` type algebra: what a route declares it answers (a media type's bodies by status
 * key, its redirects, the headers of each status), and ctx.res narrowed to it. A declared helper
 * takes only the declared status keys, each body typed by its status's schema and its options
 * carrying the status's declared headers; an undeclared one is gone; noContent, raw, redirect and
 * stream are always there; sse only for an event stream; binary for octet-stream or an open type.
 */
import type { BinaryBody } from "../response/binary.ts"
import type { HoneyRes, ResponseOptions, TypedResponse } from "../response/response.ts"
import type { StatusKey } from "../response/status.ts"
import type { InferInput, InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"

/** A media type's declared bodies by status key: a schema, or `true` for a body with none. */
export type StatusSchemas = { readonly [K in StatusKey]?: StandardSchemaLike | true }

/** The headers each status carries, by status key: a schema over the headers by lowercased name. */
export type HeaderSchemas = { readonly [K in StatusKey]?: StandardSchemaLike }

/** Redirect statuses a route declares, for the generators: no body, no schema. */
export type RedirectStatuses = { readonly [K in StatusKey]?: true }

/**
 * What `.output()` takes: each media type it answers with (`type/subtype`), the redirects it may
 * answer (`redirect`), and the headers each status carries (`headers`).
 */
export type OutputSchemas = {
	readonly [mediaType: `${string}/${string}`]: StatusSchemas
} & { readonly headers?: HeaderSchemas; readonly redirect?: RedirectStatuses }

/**
 * `TOutput` with every key under a media type, `headers` or `redirect` that names no status, and every outer key
 * that is none of those, mapped to `never`: intersected with the declaration, a typo is an error where it is
 * written. `assertOutputKeys` (openapi/output-keys.ts) refuses the same keys where an app is documented.
 */
export type KnownStatusKeys<TOutput> = {
	readonly [CT in keyof TOutput]: CT extends `${string}/${string}` | "headers" | "redirect"
		? { readonly [K in keyof TOutput[CT]]: K extends StatusKey ? TOutput[CT][K] : never }
		: never
}

/** The helper each media type is answered with. */
type HelperOf = {
	"application/json": "json"
	"application/xml": "xml"
	"text/csv": "csv"
	"text/event-stream": "sse"
	"text/html": "html"
	"text/plain": "text"
}

/** The media types answered through `binary`: octet-stream and any type no other helper answers. */
type BinaryTypes<TOutput> = Exclude<Extract<keyof TOutput, `${string}/${string}`>, keyof HelperOf>

/** The helpers a declaration allows. */
export type AllowedResMethods<TOutput> =
	| { [CT in keyof HelperOf]: CT extends keyof TOutput ? HelperOf[CT] : never }[keyof HelperOf]
	| ([BinaryTypes<TOutput>] extends [never] ? never : "binary")

/** The helpers every route keeps, whatever it declares. */
type UniversalRes = Pick<HoneyRes, "noContent" | "raw" | "redirect" | "stream">

/** A declared body's type: its schema's output; `unknown` for a body declared without one. */
type BodyOf<S> = S extends StandardSchemaLike ? InferOutput<S> : unknown

/** The header schema status `K` declares, or `never`. */
type HeadersOf<TOutput, K> = TOutput extends { readonly headers?: infer H }
	? K extends keyof NonNullable<H>
		? Exclude<NonNullable<H>[K], undefined>
		: never
	: never

/** The headers status `K` must carry in its options: its declared ones, others beside them. */
type HeaderOpt<TOutput, K> = [HeadersOf<TOutput, K>] extends [never]
	? {}
	: { headers: InferInput<HeadersOf<TOutput, K>> & Record<string, string> }

/** The options for status `K`: required when it declares headers, optional otherwise. */
type OptsFor<TOutput, K, TExtra = {}> = [HeadersOf<TOutput, K>] extends [never]
	? [opts?: ResponseOptions & TExtra]
	: [opts: ResponseOptions & TExtra & HeaderOpt<TOutput, K>]

/** `method` narrowed to `CT`'s declared status keys, the body typed (`json`) or text (the others). */
type Narrowed<TOutput, CT extends keyof HelperOf, TText extends boolean> = CT extends keyof TOutput
	? {
			[M in HelperOf[CT]]: <K extends keyof TOutput[CT] & StatusKey>(
				statusKey: K,
				body: TText extends true ? string : BodyOf<TOutput[CT][K]>,
				...opts: OptsFor<TOutput, K>
			) => TypedResponse<CT, K>
		}
	: {}

/** `binary` for a declared open type, its content type named; octet-stream may leave it out. */
type BinaryCall<TOutput> = (<CT extends BinaryTypes<TOutput>, K extends keyof TOutput[CT] & StatusKey>(
	statusKey: K,
	body: BinaryBody,
	opts: ResponseOptions & HeaderOpt<TOutput, K> & { contentType: CT },
) => TypedResponse<CT, K>) &
	("application/octet-stream" extends keyof TOutput
		? <K extends keyof TOutput["application/octet-stream"] & StatusKey>(
				statusKey: K,
				body: BinaryBody,
				...opts: OptsFor<TOutput, K, { contentType?: "application/octet-stream" }>
			) => TypedResponse<"application/octet-stream", K>
		: unknown)

/** ctx.res for a route declaring `TOutput`. */
type OutputRes<TOutput> = UniversalRes &
	Narrowed<TOutput, "application/json", false> &
	Narrowed<TOutput, "text/plain", true> &
	Narrowed<TOutput, "text/html", true> &
	Narrowed<TOutput, "application/xml", true> &
	Narrowed<TOutput, "text/csv", true> &
	("text/event-stream" extends keyof TOutput ? Pick<HoneyRes, "sse"> : {}) &
	([BinaryTypes<TOutput>] extends [never] ? {} : { binary: BinaryCall<TOutput> })

/** `TCtx` with ctx.res narrowed to `TOutput`; a route without `.output()` keeps the whole HoneyRes. */
export type ApplyOutput<TCtx, TOutput> = [TOutput] extends [never]
	? TCtx
	: Omit<TCtx, "res"> & { readonly res: OutputRes<TOutput> }
