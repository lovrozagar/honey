/**
 * The `.output()` type algebra: what a route declares it answers (a media type's bodies by status
 * key, its redirects, the headers of each status), and ctx.res narrowed to it. A declared helper
 * takes only the declared status keys, each body typed by its status's schema; an undeclared one
 * is gone; noContent, raw, redirect and stream are always there; sse only for an event stream.
 */
import type { HoneyRes, ResponseOptions, TypedResponse } from "../response/response.ts"
import type { StatusKey } from "../response/status.ts"
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"

/** A media type's declared bodies by status key: a schema, or `true` for a body with none. */
export type StatusSchemas = { readonly [K in StatusKey]?: StandardSchemaLike | true }

/** Redirect statuses a route declares, for the generators: no body, no schema. */
export type RedirectStatuses = { readonly [K in StatusKey]?: true }

/**
 * What `.output()` takes: each media type it answers with (`type/subtype`), the redirects it may
 * answer (`redirect`), and the headers each status carries (`headers`).
 */
export type OutputSchemas = {
	readonly [mediaType: `${string}/${string}`]: StatusSchemas
} & { readonly headers?: { readonly [K in StatusKey]?: StandardSchemaLike }; readonly redirect?: RedirectStatuses }

/** The helper each media type is answered with. */
type HelperOf = {
	"application/json": "json"
	"application/xml": "xml"
	"text/csv": "csv"
	"text/event-stream": "sse"
	"text/html": "html"
	"text/plain": "text"
}

/** The helpers a declaration allows. */
export type AllowedResMethods<TOutput> = {
	[CT in keyof HelperOf]: CT extends keyof TOutput ? HelperOf[CT] : never
}[keyof HelperOf]

/** The helpers every route keeps, whatever it declares. */
type UniversalRes = Pick<HoneyRes, "noContent" | "raw" | "redirect" | "stream">

/** A declared body's type: its schema's output; `unknown` for a body declared without one. */
type BodyOf<S> = S extends StandardSchemaLike ? InferOutput<S> : unknown

/** `method` narrowed to `CT`'s declared status keys, the body typed (`json`) or text (the others). */
type Narrowed<TOutput, CT extends keyof HelperOf, TText extends boolean> = CT extends keyof TOutput
	? {
			[M in HelperOf[CT]]: <K extends keyof TOutput[CT] & StatusKey>(
				statusKey: K,
				body: TText extends true ? string : BodyOf<TOutput[CT][K]>,
				opts?: ResponseOptions,
			) => TypedResponse<CT, K>
		}
	: {}

/** ctx.res for a route declaring `TOutput`. */
type OutputRes<TOutput> = UniversalRes &
	Narrowed<TOutput, "application/json", false> &
	Narrowed<TOutput, "text/plain", true> &
	Narrowed<TOutput, "text/html", true> &
	Narrowed<TOutput, "application/xml", true> &
	Narrowed<TOutput, "text/csv", true> &
	("text/event-stream" extends keyof TOutput ? Pick<HoneyRes, "sse"> : {})

/** `TCtx` with ctx.res narrowed to `TOutput`; a route without `.output()` keeps the whole HoneyRes. */
export type ApplyOutput<TCtx, TOutput> = [TOutput] extends [never]
	? TCtx
	: Omit<TCtx, "res"> & { readonly res: OutputRes<TOutput> }
