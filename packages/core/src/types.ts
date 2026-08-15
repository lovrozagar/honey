export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT"

/** Overwrite keys in T with keys from U -- used by .use() to support narrowing middleware */
export type Overwrite<T, U> = Omit<T, keyof U> & U

export type WSReadyState = 0 | 1 | 2 | 3

/** All HTTP status codes 2xx–5xx as snake_case keys */
export type StatusKey =
	/* 2xx success */
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
	/* 3xx redirection */
	| "found"
	| "moved_permanently"
	| "multiple_choices"
	| "not_modified"
	| "permanent_redirect"
	| "see_other"
	| "temporary_redirect"
	/* 4xx client error */
	| "bad_request"
	| "conflict"
	| "expectation_failed"
	| "failed_dependency"
	| "forbidden"
	| "gone"
	| "im_a_teapot"
	| "length_required"
	| "locked"
	| "method_not_allowed"
	| "misdirected_request"
	| "not_acceptable"
	| "not_found"
	| "content_too_large"
	| "payment_required"
	| "precondition_failed"
	| "precondition_required"
	| "proxy_authentication_required"
	| "range_not_satisfiable"
	| "request_header_fields_too_large"
	| "request_timeout"
	| "too_early"
	| "too_many_requests"
	| "unauthorized"
	| "unavailable_for_legal_reasons"
	| "unprocessable_entity"
	| "unsupported_media_type"
	| "upgrade_required"
	| "uri_too_long"
	/* 5xx server error */
	| "bad_gateway"
	| "gateway_timeout"
	| "http_version_not_supported"
	| "insufficient_storage"
	| "internal_server_error"
	| "loop_detected"
	| "network_authentication_required"
	| "not_extended"
	| "not_implemented"
	| "service_unavailable"
	| "variant_also_negotiates"

export const statusKeyToCode: Record<StatusKey, number> = {
	accepted: 202,
	already_reported: 208,
	bad_gateway: 502,
	bad_request: 400,
	conflict: 409,
	content_too_large: 413,
	created: 201,
	expectation_failed: 417,
	failed_dependency: 424,
	forbidden: 403,
	found: 302,
	gateway_timeout: 504,
	gone: 410,
	http_version_not_supported: 505,
	im_a_teapot: 418,
	im_used: 226,
	insufficient_storage: 507,
	internal_server_error: 500,
	length_required: 411,
	locked: 423,
	loop_detected: 508,
	method_not_allowed: 405,
	misdirected_request: 421,
	moved_permanently: 301,
	multi_status: 207,
	multiple_choices: 300,
	network_authentication_required: 511,
	no_content: 204,
	non_authoritative_information: 203,
	not_acceptable: 406,
	not_extended: 510,
	not_found: 404,
	not_implemented: 501,
	not_modified: 304,
	ok: 200,
	partial_content: 206,
	payment_required: 402,
	permanent_redirect: 308,
	precondition_failed: 412,
	precondition_required: 428,
	proxy_authentication_required: 407,
	range_not_satisfiable: 416,
	request_header_fields_too_large: 431,
	request_timeout: 408,
	reset_content: 205,
	see_other: 303,
	service_unavailable: 503,
	temporary_redirect: 307,
	too_early: 425,
	too_many_requests: 429,
	unauthorized: 401,
	unavailable_for_legal_reasons: 451,
	unprocessable_entity: 422,
	unsupported_media_type: 415,
	upgrade_required: 426,
	uri_too_long: 414,
	variant_also_negotiates: 506,
}

export const codeToStatusKey: Record<number, StatusKey> = Object.fromEntries(
	Object.entries(statusKeyToCode).map(([k, v]) => [v, k]),
) as Record<number, StatusKey>

/** Framework error keys — centralized to prevent typo-induced silent failures */
export const EK = {
	bad_gateway: "bad_gateway",
	content_too_large: "content_too_large",
	forbidden: "forbidden",
	gateway_timeout: "gateway_timeout",
	internal_server_error: "internal_server_error",
	method_not_allowed: "method_not_allowed",
	not_found: "not_found",
	output_content_type_mismatch: "output_content_type_mismatch",
	output_validation_failed: "output_validation_failed",
	request_timeout: "request_timeout",
	too_many_requests: "too_many_requests",
	unsupported_media_type: "unsupported_media_type",
	validation_failed: "validation_failed",
} as const

/** Framework status keys — centralized subset of StatusKey used internally */
export const SK = {
	bad_gateway: "bad_gateway",
	bad_request: "bad_request",
	content_too_large: "content_too_large",
	forbidden: "forbidden",
	gateway_timeout: "gateway_timeout",
	internal_server_error: "internal_server_error",
	method_not_allowed: "method_not_allowed",
	not_found: "not_found",
	unprocessable_entity: "unprocessable_entity",
	unsupported_media_type: "unsupported_media_type",
} as const satisfies Record<string, StatusKey>

export type FieldError = {
	error_key: string
	message: string
	path: string
}

/* shared frozen empty objects — avoid per-call {} allocations */
export const EMPTY_OBJ: Record<string, never> = Object.freeze(Object.create(null)) as Record<
	string,
	never
>
export const EMPTY_FIELDS: Record<string, FieldError[]> = EMPTY_OBJ as Record<string, FieldError[]>

export type NormalizedIssue = {
	code: string
	message: string
	meta: {
		expected?: string
		field?: string
		max?: number
		min?: number
		multipleOf?: number
		received?: string
	}
	path: PropertyKey[]
}

export type SchemaDefinition = {
	input: unknown
	output: unknown
}

/**
 * Minimal Standard Schema interface (StandardSchemaV1).
 * Compatible with Zod, Valibot, ArkType, etc.
 */
export type StandardSchemaLike = {
	readonly "~standard": {
		readonly types?: { readonly input: unknown; readonly output: unknown } | undefined
		readonly validate: (value: unknown) =>
			| {
					readonly issues?: ReadonlyArray<StandardSchemaIssue> | undefined
					readonly value?: unknown
			  }
			| Promise<{
					readonly issues?: ReadonlyArray<StandardSchemaIssue> | undefined
					readonly value?: unknown
			  }>
		readonly vendor: string
		readonly version: number
	}
}

export type StandardSchemaIssue = {
	readonly message: string
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

/** Extract the output type from a Standard Schema compatible schema */
export type InferOutput<T> = T extends {
	readonly "~standard": { readonly types?: infer TTypes }
}
	? NonNullable<TTypes> extends { readonly output: infer O }
		? O
		: unknown
	: unknown

/** Map input schema definitions to their inferred output types, dropping undefined keys */
export type InferInputMap<T> = {
	[K in keyof T as T[K] extends undefined | null ? never : K]-?: InferOutput<
		UnwrapInputSchema<NonNullable<T[K]>>
	>
}

/**
 * Extract param names from a route path string.
 * "/users/:id/posts/:postId" → "id" | "postId"
 * Handles optional params (:id?) and wildcards (*name)
 */
export type ParamKeys<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
	? ParamKey<Param> | ParamKeys<`/${Rest}`>
	: Path extends `${string}:${infer Param}`
		? ParamKey<Param>
		: Path extends `${string}*${infer Name}`
			? Name extends ""
				? "*"
				: Name
			: never

type ParamKey<T extends string> = T extends `${infer Name}?` ? Name : T

/** Build a params record from a route path string */
export type ParamsFromPath<Path extends string> = [ParamKeys<Path>] extends [never]
	? Record<string, string>
	: { [K in ParamKeys<Path>]: string }

/** Tagged schema wrapper for runtime behavior control */
type TaggedSchema = {
	readonly _tag: "readableStream"
	readonly schema: StandardSchemaLike
}

/** A schema entry: plain StandardSchema or wrapped with readableStream() */
export type InputSchemaEntry = StandardSchemaLike | TaggedSchema

/** Unwrap tagged schemas to get the inner StandardSchemaLike for type inference */
type UnwrapInputSchema<T> = T extends {
	readonly _tag: string
	readonly schema: infer S
}
	? S
	: T

/** Non-body input sources — combine freely */
type InputNonBody = {
	cookies?: InputSchemaEntry
	headers?: InputSchemaEntry
	params?: InputSchemaEntry
	search?: InputSchemaEntry
}

/** Input schema definition — json and form are mutually exclusive (one Content-Type per request) */
export type InputSchemasDef =
	| (InputNonBody & { form?: InputSchemaEntry; json?: never })
	| (InputNonBody & { form?: never; json?: InputSchemaEntry })

/** 2xx-only status keys for output declarations */
export type SuccessStatusKey =
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

/** Status-key → schema map for a single content type (2xx only) */
type StatusSchemaMap = Partial<Record<SuccessStatusKey, StandardSchemaLike>>

/** 3xx redirect status keys (excludes not_modified — cache, not redirect) */
export type RedirectStatusKey =
	| "found"
	| "moved_permanently"
	| "multiple_choices"
	| "permanent_redirect"
	| "see_other"
	| "temporary_redirect"

/** Redirect declaration map — no body schema, just status keys */
type RedirectSchemaMap = Partial<Record<RedirectStatusKey, true>>

/** Output schema definition — maps content-type → status-key → schema */
export type OutputSchemaDef = {
	"application/cbor"?: StatusSchemaMap
	"application/json"?: StatusSchemaMap
	"application/msgpack"?: StatusSchemaMap
	"application/octet-stream"?: StatusSchemaMap
	"application/pdf"?: StatusSchemaMap
	"application/xml"?: StatusSchemaMap
	"redirect"?: RedirectSchemaMap
	"text/csv"?: StatusSchemaMap
	"text/event-stream"?: StatusSchemaMap
	"text/html"?: StatusSchemaMap
	"text/plain"?: StatusSchemaMap
}

/** Maps content-type strings to HoneyRes method names */
export type ContentTypeMethodMap = {
	"application/json": "json"
	"application/octet-stream": "binary"
	"application/xml": "xml"
	"text/csv": "csv"
	"text/event-stream": "sse"
	"text/html": "html"
	"text/plain": "text"
}

/** Methods always available on ctx.res regardless of output declaration */
export type UniversalResMethods = "noContent" | "raw" | "redirect" | "stream"

/** Derive allowed response methods from declared output content types */
export type AllowedResMethods<TOutput> = {
	[CT in keyof ContentTypeMethodMap]: CT extends keyof TOutput ? ContentTypeMethodMap[CT] : never
}[keyof ContentTypeMethodMap]

/** Extract schemas for any content type from an OutputSchemaDef */
export type ExtractSchemas<T, CT extends string> = T extends {
	[K in CT]: infer S extends Record<string, unknown>
}
	? S
	: never

/** Extract JSON output schemas from an OutputSchemaDef */
export type ExtractJsonSchemas<T> = ExtractSchemas<T, "application/json">

/** Infer output types from a JSON output schema map */
export type InferJsonOutputMap<T extends Record<string, StandardSchemaLike>> = {
	[K in keyof T]: InferOutput<T[K]>
}

/** OpenAPI operation-level metadata (also serves as built-in meta base) */
export type OpenApiMeta = {
	internal?: boolean
	deprecated?: boolean
	description?: string
	invalidate?: readonly string[] | null
	mcp?: boolean
	operationId?: string
	security?: Array<Record<string, string[]>> | string | string[]
	summary?: string
	tags?: string | string[]
}

/** Built-in meta shape — always available on .meta() */
export type DefaultMeta = OpenApiMeta

/** Augmented by generated code per-app to narrow invalidate selectors */
export interface HoneyCodegen {}

type ResolveSelector = HoneyCodegen extends { routeSelector: infer R }
	? R extends string ? R : string
	: string

/** Utility: merges built-in meta, custom meta T, and type-safe invalidate from codegen */
export type HoneyMeta<T = {}> = DefaultMeta & T & {
	invalidate?: readonly ResolveSelector[] | null
}

/** Accumulated route schema entry for RPC client generation */
export type RouteRecord<
	TMethod extends string,
	TPath extends string,
	TInput,
	TOutput,
	TCtx = unknown,
	TErrors extends string = never,
	TErrorsByStatus = never,
> = {
	[P in TPath]: {
		[M in Lowercase<TMethod>]: {
			ctx: TCtx
			errors: TErrors
			errorsByStatus: TErrorsByStatus
			input: TInput
			output: TOutput
		}
	}
}

/** Merge a new route record into accumulated routes via flat intersection */
export type MergeRoute<
	TRoutes,
	TPath extends string,
	TMethod extends string,
	TInput,
	TOutput,
	TCtx,
	TMeta = {},
	TErrors extends string = never,
	TErrorsByStatus = never,
> = TRoutes & {
	[P in TPath]: {
		[M in Lowercase<TMethod>]: {
			ctx: TCtx
			errors: TErrors
			errorsByStatus: TErrorsByStatus
			input: TInput
			meta: TMeta
			output: TOutput
		}
	}
}

/** Extract accumulated routes from a Honey instance type */
export type InferRoutes<T> = T extends { readonly $routes: infer R } ? R : never

/** Extract accumulated middleware context. `res` is omitted so handler ctx is assignable into services. Use InferRouteCtx for the route's constrained `res`. */
export type InferCtx<T> = T extends { readonly $ctx: infer TCtx } ? Omit<TCtx, "res"> : never

/** Extract environment type (TEnv) from a Honey instance */
export type InferEnv<T> = T extends { readonly $env: infer TEnv } ? TEnv : never

/** All HTTP methods used across all routes */
export type InferMethods<T> =
	InferRoutes<T> extends infer R ? { [P in keyof R]: keyof R[P] & string }[keyof R] : never

/** Available route paths registered on a Honey instance */
export type InferRoutePaths<T> = keyof InferRoutes<T> & string

/** Available methods for a given path ("get", "post", etc.) */
export type InferRouteMethods<
	T,
	TPath extends InferRoutePaths<T>,
> = InferRoutes<T>[TPath] extends infer M ? keyof M & string : never

/** Lookup a specific route's record from the accumulated route map */
type RouteLookup<T, TPath extends string, TMethod extends string> =
	InferRoutes<T> extends infer R
		? TPath extends keyof R
			? R[TPath] extends infer Methods
				? TMethod extends keyof Methods
					? Methods[TMethod]
					: never
				: never
			: never
		: never

/** Extract the meta type generic (TMeta) from a Honey instance */
export type InferMeta<T> = T extends { readonly $meta: infer M } ? M : never

/** Extract the full handler context type for a specific route */
export type InferRouteCtx<
	T,
	TPath extends InferRoutePaths<T>,
	TMethod extends InferRouteMethods<T, TPath>,
> = RouteLookup<T, TPath, TMethod> extends { ctx: infer C } ? C : never

/** Extract input type for a specific route */
export type InferRouteInput<
	T,
	TPath extends InferRoutePaths<T>,
	TMethod extends InferRouteMethods<T, TPath>,
> = RouteLookup<T, TPath, TMethod> extends { input: infer I } ? I : never

/** Extract meta type for a specific route */
export type InferRouteMeta<
	T,
	TPath extends InferRoutePaths<T>,
	TMethod extends InferRouteMethods<T, TPath>,
> = RouteLookup<T, TPath, TMethod> extends { meta: infer M } ? M : never

/** Extract output type for a specific route */
export type InferRouteOutput<
	T,
	TPath extends InferRoutePaths<T>,
	TMethod extends InferRouteMethods<T, TPath>,
> = RouteLookup<T, TPath, TMethod> extends { output: infer O } ? O : never

/** Extract error keys for a specific route */
export type InferRouteErrors<
	T,
	TPath extends InferRoutePaths<T>,
	TMethod extends InferRouteMethods<T, TPath>,
> = RouteLookup<T, TPath, TMethod> extends { errors: infer E } ? E : never

/** Extract the error factory type from a Honey instance */
export type InferErrorFactory<T> = T extends { readonly $errorFactory: infer F } ? F : never

/**
 * Compute errorsByStatus from error factory + declared error keys.
 * Maps status codes to body shapes for client-side discrimination.
 */
export type ComputeErrorsByStatus<
	TFactory,
	TErrorKeys extends string,
	TMetaSymbol extends symbol,
> = TFactory extends { readonly [K in TMetaSymbol]: infer TMeta }
	? TMeta extends Record<string, { schema: infer _S; statusKey: infer _SK }>
		? _BuildByStatus<TMeta, TErrorKeys>
		: never
	: never

/** Internal: build { [statusCode]: bodyShape } from meta + error keys */
type _BuildByStatus<
	TMeta extends Record<string, { schema: unknown; statusKey: unknown }>,
	TKeys extends string,
> = {
	[SK in _UsedStatusKeys<TMeta, TKeys> & StatusKey as StatusKeyToCodeType<SK>]: _ShapesForStatus<
		TMeta,
		TKeys,
		SK
	>
}

/** Internal: collect all statusKeys used by the declared error keys */
type _UsedStatusKeys<
	TMeta extends Record<string, { schema: unknown; statusKey: unknown }>,
	TKeys extends string,
> = TKeys extends keyof TMeta ? TMeta[TKeys]["statusKey"] : never

/** Internal: union of shapes for all error keys that map to a given statusKey */
type _ShapesForStatus<
	TMeta extends Record<string, { schema: unknown; statusKey: unknown }>,
	TKeys extends string,
	TSK extends StatusKey,
> = TKeys extends keyof TMeta
	? TMeta[TKeys]["statusKey"] extends TSK
		? TMeta[TKeys]["schema"] extends StandardSchemaLike
			? InferOutput<TMeta[TKeys]["schema"]>
			: null
		: never
	: never

/** Map StatusKey string to numeric status code at the type level */
type StatusKeyToCodeType<SK extends StatusKey> = SK extends "ok"
	? 200
	: SK extends "created"
		? 201
		: SK extends "accepted"
			? 202
			: SK extends "no_content"
				? 204
				: SK extends "bad_request"
					? 400
					: SK extends "unauthorized"
						? 401
						: SK extends "payment_required"
							? 402
							: SK extends "forbidden"
								? 403
								: SK extends "not_found"
									? 404
									: SK extends "method_not_allowed"
										? 405
										: SK extends "not_acceptable"
											? 406
											: SK extends "conflict"
												? 409
												: SK extends "gone"
													? 410
													: SK extends "unprocessable_entity"
														? 422
														: SK extends "too_many_requests"
															? 429
															: SK extends "internal_server_error"
																? 500
																: SK extends "not_implemented"
																	? 501
																	: SK extends "bad_gateway"
																		? 502
																		: SK extends "service_unavailable"
																			? 503
																			: SK extends "gateway_timeout"
																				? 504
																				: number

/** Extract the base path type from a Honey instance */
export type InferBasePath<T> = T extends { readonly $basePath: infer P } ? P : never

/** Merge two path segments — "/" is identity */
export type MergePath<A extends string, B extends string> = A extends "/"
	? B
	: B extends "/"
		? A
		: `${A}${B}`

/* ── Tap types ── */

/** Queued side-effect emitted by c.tap() inside a handler */
export type PendingTap = { key: string; payload: unknown }

/** Handler registered via app.tap(key, handler) — receives context + payload */
export type TapHandler<TEnv = unknown> = (
	ctx: TapContext<TEnv>,
	payload: unknown,
) => void | Promise<void>

/** Subset of HoneyContext exposed to tap handlers — no res, no recursive tap */
export type TapContext<TEnv = unknown> = {
	readonly background: (p: Promise<unknown>) => void
	readonly env: TEnv
	readonly headers: Record<string, string>
	readonly meta: Record<string, unknown>
	readonly params: Record<string, string>
	readonly path: string
	readonly req: Request
	readonly routePattern: string
	readonly search: Record<string, string>
}
