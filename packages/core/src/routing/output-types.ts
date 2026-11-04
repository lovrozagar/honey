/**
 * The `.output()` type algebra: what a route declares it answers (a media type's bodies by status
 * key, its redirects, the headers of each status), and ctx.res narrowed to it. A declared helper
 * takes only the declared status keys, each body typed by its status's schema and its options
 * carrying the status's declared headers; an undeclared one is gone, and so is raw; noContent and
 * stream stay; redirect takes only the declared redirect keys; sse only for an event stream; binary
 * for octet-stream or an open type.
 * The handler's return is narrowed the same way: a declared media type at one of its status keys, or the body
 * itself when the route declares one 2xx status under one media type. Status keys alone (`{ ok: schema }`) are the
 * shorthand for `{ "application/json": { ok: schema } }`.
 */
import type { BinaryBody } from "../response/binary.ts"
import type { HoneyRes, ResponseOptions, StreamBody, TypedResponse } from "../response/response.ts"
import type { RedirectKey, StatusKey } from "../response/status.ts"
import type { InferInput, StandardSchemaLike } from "../validation/standard-schema.ts"

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
	/** The status keys this media type answers with, each with a body schema or `true`. */
	readonly [mediaType: `${string}/${string}`]: StatusSchemas
} & {
	/** The schema of the headers each status carries, by status key; that status's helper then requires them. */ readonly headers?: HeaderSchemas
	/** Redirect statuses the route may answer with: `ctx.res.redirect` takes only these, and the generators record them. */ readonly redirect?: RedirectStatuses
}

/** `.output()`'s shorthand: JSON bodies by status key, beside the headers and redirects of the explicit form. */
export type JsonShorthand = StatusSchemas & {
	/** The schema of the headers each status carries, by status key; that status's helper then requires them. */ readonly headers?: HeaderSchemas
	/** Redirect statuses the route may answer with: `ctx.res.redirect` takes only these, and the generators record them. */ readonly redirect?: RedirectStatuses
}

/** The media types a declaration names. */
type MediaTypes<TOutput> = Extract<keyof TOutput, `${string}/${string}`>

/** Whether `TOutput` is the shorthand: no media type, and a status key. */
type IsShorthand<TOutput> = [MediaTypes<TOutput>] extends [never]
	? [Extract<keyof TOutput, StatusKey>] extends [never]
		? false
		: true
	: false

/** The declaration `.output()` records: the shorthand as its `application/json` form, the explicit one as written. */
export type NormalizeOutput<TOutput> = [TOutput] extends [never]
	? never
	: IsShorthand<TOutput> extends true
		? {
				readonly [K in "application/json" | Extract<keyof TOutput, "headers" | "redirect">]: K extends keyof TOutput
					? TOutput[K]
					: { readonly [S in Exclude<keyof TOutput, "headers" | "redirect">]: TOutput[S] }
			}
		: TOutput

/**
 * `TOutput` with every key under a media type, `headers` or `redirect` that names no status, and every outer key
 * that is none of those (a status key, in the shorthand), mapped to `never`: intersected with the declaration, a
 * typo or a status key beside a media type is an error where it is written. `assertOutputKeys`
 * (openapi/output-keys.ts) refuses the same keys where an app is documented.
 */
export type KnownStatusKeys<TOutput> = {
	readonly [CT in keyof TOutput]: CT extends `${string}/${string}` | "headers" | "redirect"
		? { readonly [K in keyof TOutput[CT]]: K extends StatusKey ? TOutput[CT][K] : never }
		: CT extends StatusKey
			? IsShorthand<TOutput> extends true
				? TOutput[CT]
				: never
			: never
}

/** The helper each media type is answered with. */
type HelperOf = {
	/** The `ctx.res` method that answers `application/json`. */
	"application/json": "json"
	/** The `ctx.res` method that answers `application/xml`. */
	"application/xml": "xml"
	/** The `ctx.res` method that answers `text/csv`. */
	"text/csv": "csv"
	/** The `ctx.res` method that answers `text/event-stream`. */
	"text/event-stream": "sse"
	/** The `ctx.res` method that answers `text/html`. */
	"text/html": "html"
	/** The `ctx.res` method that answers `text/plain`. */
	"text/plain": "text"
}

/** The media types answered through `binary`: octet-stream and any type no other helper answers. */
type BinaryTypes<TOutput> = Exclude<Extract<keyof TOutput, `${string}/${string}`>, keyof HelperOf>

/** The helpers a declaration allows. */
export type AllowedResMethods<TOutput> =
	| { [CT in keyof HelperOf]: CT extends keyof TOutput ? HelperOf[CT] : never }[keyof HelperOf]
	| ([BinaryTypes<TOutput>] extends [never] ? never : "binary")

/** The helpers a route that declares an output keeps; `raw` is gone, since a raw Response declares nothing. */
type UniversalRes = Pick<HoneyRes, "noContent" | "stream">

/** The redirect keys the output's `redirect` entry declares, or `never`. */
type RedirectsOf<TOutput> = TOutput extends { readonly redirect?: infer R }
	? Extract<keyof NonNullable<R>, RedirectKey>
	: never

/**
 * What a handler may return: any typed answer without `.output()`; with one, a declared media type at one of its
 * status keys, a bodiless answer (no content, a redirect), or the sole body.
 */
export type DeclaredAnswer<TOutput> = [TOutput] extends [never]
	? TypedResponse
	:
			| { [CT in MediaTypes<TOutput>]: TypedResponse<CT, Extract<keyof TOutput[CT], StatusKey>> }[MediaTypes<TOutput>]
			| TypedResponse<"none", "no_content" | RedirectsOf<TOutput>>
			| SoleBody<TOutput>

/** A declared body's type: its schema's input, what output validation accepts; `unknown` without a schema. */
type BodyOf<S> = S extends StandardSchemaLike ? InferInput<S> : unknown

/** The 2xx status keys. */
type SuccessKey =
	| "accepted"
	| "already_reported"
	| "created"
	| "im_used"
	| "multi_status"
	| "no_content"
	| "non_authoritative_information"
	| "ok"
	| "partial_content"
	| "reset_content"

/** Whether `T` is exactly one member: not `never`, not a union. */
type IsOne<T, TAll = T> = [T] extends [never] ? false : T extends unknown ? ([TAll] extends [T] ? true : false) : never

/**
 * The body a handler may return for honey to answer: with one media type and one 2xx status under it, that status's
 * body as its helper takes it. Never for an event stream, a bodiless status, or a status that declares headers.
 */
type SoleBody<TOutput> = IsOne<MediaTypes<TOutput>> extends true ? SoleBodyAt<TOutput, MediaTypes<TOutput>> : never

/** `SoleBody` under media type `CT`. */
type SoleBodyAt<TOutput, CT extends keyof TOutput> =
	IsOne<Extract<keyof TOutput[CT], SuccessKey>> extends true
		? SoleBodyOf<TOutput, CT, Extract<keyof TOutput[CT], SuccessKey>>
		: never

/** `SoleBody` at status `K` of media type `CT`. */
type SoleBodyOf<TOutput, CT extends keyof TOutput, K extends keyof TOutput[CT]> = K extends
	| "no_content"
	| "reset_content"
	? never
	: [HeadersOf<TOutput, K>] extends [never]
		? CT extends "application/json"
			? BodyOf<TOutput[CT][K]>
			: CT extends "text/event-stream"
				? never
				: CT extends Exclude<keyof HelperOf, "application/json">
					? string | StreamBody
					: BinaryBody | StreamBody
		: never

/** The header schema status `K` declares, or `never`. */
type HeadersOf<TOutput, K> = TOutput extends { readonly headers?: infer H }
	? K extends keyof NonNullable<H>
		? Exclude<NonNullable<H>[K], undefined>
		: never
	: never

/** The headers status `K` must carry in its options: its declared ones, others beside them. */
type HeaderOpt<TOutput, K> = [HeadersOf<TOutput, K>] extends [never]
	? {}
	: {
			/** Headers for the response: the declared ones are required, others are allowed. */ headers: InferInput<
				HeadersOf<TOutput, K>
			> &
				Record<string, string>
		}

/** The options for status `K`: required when it declares headers, optional otherwise. */
type OptsFor<TOutput, K, TExtra = {}> = [HeadersOf<TOutput, K>] extends [never]
	? [opts?: ResponseOptions & TExtra]
	: [opts: ResponseOptions & TExtra & HeaderOpt<TOutput, K>]

/** `method` narrowed to `CT`'s declared status keys, the body typed (`json`) or text (the others). */
type Narrowed<TOutput, CT extends keyof HelperOf, TText extends boolean> = CT extends keyof TOutput
	? {
			[M in HelperOf[CT]]: <K extends keyof TOutput[CT] & StatusKey>(
				statusKey: K,
				body: TText extends true ? string | StreamBody : BodyOf<TOutput[CT][K]> | StreamBody,
				...opts: OptsFor<TOutput, K>
			) => TypedResponse<CT, K>
		}
	: {}

/** `binary` for a declared open type, its content type named; octet-stream may leave it out. */
type BinaryCall<TOutput> = (<CT extends BinaryTypes<TOutput>, K extends keyof TOutput[CT] & StatusKey>(
	statusKey: K,
	body: BinaryBody | StreamBody,
	opts: ResponseOptions &
		HeaderOpt<TOutput, K> & {
			/** The media type of the body, one the route declares; only `application/octet-stream` may be left out. */ contentType: CT
		},
) => TypedResponse<CT, K>) &
	("application/octet-stream" extends keyof TOutput
		? <K extends keyof TOutput["application/octet-stream"] & StatusKey>(
				statusKey: K,
				body: BinaryBody | StreamBody,
				...opts: OptsFor<
					TOutput,
					K,
					{
						/** The media type of the body; left out, it is `application/octet-stream`. */ contentType?: "application/octet-stream"
					}
				>
			) => TypedResponse<"application/octet-stream", K>
		: unknown)

/** ctx.res for a route declaring `TOutput`. */
type OutputRes<TOutput> = UniversalRes & {
	/**
	 * Answers `response` as it is, its status decided elsewhere (a stored file's 206 or 304); a status or media type
	 * the route does not declare is refused as an undeclared answer is. Its body is not validated.
	 */
	forward: (response: Response) => Exclude<DeclaredAnswer<TOutput>, SoleBody<TOutput>>
} & Narrowed<TOutput, "application/json", false> &
	Narrowed<TOutput, "text/plain", true> &
	Narrowed<TOutput, "text/html", true> &
	Narrowed<TOutput, "application/xml", true> &
	Narrowed<TOutput, "text/csv", true> &
	("text/event-stream" extends keyof TOutput ? Pick<HoneyRes, "sse"> : {}) &
	([RedirectsOf<TOutput>] extends [never]
		? {}
		: {
				/** A redirect to `url`, at one of the redirect keys the output declares. */ redirect: <
					SK extends RedirectsOf<TOutput>,
				>(
					statusKey: SK,
					url: string,
					opts?: ResponseOptions,
				) => TypedResponse<"none", SK>
			}) &
	([BinaryTypes<TOutput>] extends [never]
		? {}
		: {
				/** Answers with a binary body; available when the route declares a media type no other helper answers, such as `image/png`. */ binary: BinaryCall<TOutput>
			})

/** `TCtx` with ctx.res narrowed to `TOutput`; a route without `.output()` keeps the whole HoneyRes. */
export type ApplyOutput<TCtx, TOutput> = [TOutput] extends [never]
	? TCtx
	: Omit<TCtx, "res"> & {
			/** The context's `res`, narrowed to the route's declared output. */ readonly res: OutputRes<TOutput>
		}
