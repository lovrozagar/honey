/**
 * The app-typed client's types. They read the app's `$routes` phantom structurally, so the
 * emitted client imports nothing from honey (D3): `InferRoutes`, the path params and a schema's
 * output type are spelled here as honey spells them.
 */
import type { ClientError } from "./error.ts"
import type { Result, StatusOf } from "./response.ts"
import type { SSEEvent } from "./sse.ts"
import type { TypedWebSocket } from "./ws.ts"

/** An app's routes: the `$routes` phantom its type carries. */
export type InferRoutes<T> = T extends { readonly $routes: infer R } ? R : never

/** One problem with one input field, as the error envelope lists it. */
export type FieldError = { error_key: string; message: string; path: string }

/** The type a Standard schema produces once it validated a value. */
type SchemaOutput<T> = T extends { readonly "~standard": { readonly types?: infer TTypes } }
	? NonNullable<TTypes> extends { readonly output: infer O }
		? O
		: unknown
	: unknown

type ParamKey<T extends string> = T extends `${infer Name}?` ? Name : T

/** A route pattern's param names: `:name` (optional or not), a named wildcard, an unnamed one as `*`. */
type ParamKeys<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
	? ParamKey<Param> | ParamKeys<`/${Rest}`>
	: Path extends `${string}:${infer Param}`
		? ParamKey<Param>
		: Path extends `${string}*${infer Name}`
			? Name extends ""
				? "*"
				: Name
			: never

/** Paths that register `M`. */
export type PathsForMethod<TRoutes, M extends string> = {
	[P in keyof TRoutes & string]: M extends keyof TRoutes[P] ? P : never
}[keyof TRoutes & string]

/** One route's record, when the app has it. */
type RouteOf<TRoutes, P extends string, M extends string> = P extends keyof TRoutes
	? M extends keyof TRoutes[P]
		? TRoutes[P][M]
		: never
	: never

/** What a call sends: the route's `request` (each source's schema input, `readableStream()` unwrapped). */
export type InputFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { request: infer I } ? ([I] extends [never] ? {} : I) : {}

export type OutputDefFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { output: infer O } ? O : never

/** Statuses whose answer never carries a body (204, 205, 304): the client reads each as null. */
type NullBodyStatus = "no_content" | "not_modified" | "reset_content"

/** The statuses a declaration names under each key (a media type, `headers`, `redirect`). */
type StatusesOf<O> = { [K in keyof O]: keyof NonNullable<O[K]> }[keyof O]

/** Media type `CT`'s statuses that carry a body. */
type BodyStatuses<O, CT extends string> = CT extends keyof O ? Exclude<keyof O[CT], NullBodyStatus> : never

/** Whether media type `CT` declares a status that carries a body. */
type Answers<O, CT extends string> = [BodyStatuses<O, CT>] extends [never] ? false : true

/**
 * A body's value: JSON by its schemas, text types as text, octet-stream as bytes (A1); `unknown`
 * when a status carries a body no media type here types; `never` when none carries one.
 */
type BodyValue<O> =
	Answers<O, "application/json"> extends true
		? O extends { "application/json": infer JsonMap }
			? SchemaOutput<JsonMap[BodyStatuses<O, "application/json"> & keyof JsonMap]>
			: never
		: true extends
					| Answers<O, "text/plain">
					| Answers<O, "text/html">
					| Answers<O, "text/csv">
					| Answers<O, "application/xml">
			? string
			: Answers<O, "application/octet-stream"> extends true
				? Uint8Array<ArrayBuffer>
				: [Exclude<StatusesOf<O>, NullBodyStatus>] extends [never]
					? never
					: unknown

/** What a declaration answers with: its body's value, `null` for each declared no-content status. */
type DeclaredValue<O> = BodyValue<O> | ([Extract<StatusesOf<O>, NullBodyStatus>] extends [never] ? never : null)

/**
 * The value a route answers with, `unknown` when it declares no status: undeclared is not empty,
 * the handler's body comes back.
 */
export type OutputFor<TRoutes, P extends string, M extends string> =
	OutputDefFor<TRoutes, P, M> extends infer O
		? [O] extends [never]
			? unknown
			: [DeclaredValue<O>] extends [never]
				? unknown
				: DeclaredValue<O>
		: unknown

/** Whether a route answers an event stream. */
export type IsSSE<TRoutes, P extends string, M extends string> =
	OutputDefFor<TRoutes, P, M> extends infer O ? (O extends { "text/event-stream": unknown } ? true : false) : false

type ErrorsByStatusFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { errorsByStatus: infer S } ? S : never

/** honey's error envelope, as a route without a schema of its own answers an error. */
export type ErrorEnvelope<TStatus extends number = number, TKey extends string = string> = {
	error_key: TKey
	fields: Record<string, FieldError[]>
	message: string
	status: TStatus
	status_key: string
	success: false
}

/** `null` in a route's errorsByStatus means the default envelope, not a null body. */
type ResolveErrorBody<S extends number, T> = T extends null ? ErrorEnvelope<S> : T

/** Each declared status's error body, honey's envelope where the route names none. */
type ErrorBodies<S> = { [K in keyof S]: ResolveErrorBody<StatusOf<K>, S[K]> }

/** What a call resolves to, by transport. */
export type ReturnFor<TRoutes, P extends string, M extends string> =
	IsSSE<TRoutes, P, M> extends true ? AsyncIterable<SSEEvent> : Promise<OutputFor<TRoutes, P, M>>

/** What a safe call resolves to: its value, an event stream opened, or the answer's error; never a thrown answer. */
export type SafeReturnFor<TRoutes, P extends string, M extends string> = Promise<
	Result<
		IsSSE<TRoutes, P, M> extends true ? AsyncIterable<SSEEvent> : OutputFor<TRoutes, P, M>,
		ErrorBodies<ErrorsByStatusFor<TRoutes, P, M>>
	>
>

/** A path's params, required whenever the pattern names one. */
type ParamsInput<P extends string> = [ParamKeys<P>] extends [never] ? {} : { params: { [K in ParamKeys<P>]: string } }

/** The call input: the route's declared input with the path's params. */
export type ClientInput<TRoutes, P extends string, M extends string> = InputFor<TRoutes, P, M> & ParamsInput<P>

export type ErrorsFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { errors: infer E extends string } ? E : never

type RequiresAllOptional<T> = {
	[K in keyof T]-?: undefined extends T[K] ? true : false
}[keyof T] extends true
	? true
	: Partial<T> extends T
		? true
		: false

/** The input is optional when it is empty or every key is optional. */
type OptionalInput<T> = keyof T extends never
	? [input?: T]
	: [RequiresAllOptional<T>] extends [true]
		? [input?: T]
		: [input: T]

type Method<TRoutes, M extends string> = <P extends PathsForMethod<TRoutes, M>>(
	path: P,
	...input: OptionalInput<ClientInput<TRoutes, P, M>>
) => ReturnFor<TRoutes, P, M>

type SafeMethod<TRoutes, M extends string> = <P extends PathsForMethod<TRoutes, M>>(
	path: P,
	...input: OptionalInput<ClientInput<TRoutes, P, M>>
) => SafeReturnFor<TRoutes, P, M>

type PathHelper<TRoutes> = <P extends keyof TRoutes & string>(
	path: P,
	input?: { params?: Record<string, string>; search?: Record<string, unknown> },
) => string

/** The typed client: each call resolves to its value and throws an error status; `safe`'s answer a Result. */
export type HoneyClient<TRoutes> = {
	$isClientError: (e: unknown) => e is ClientError
	$path: PathHelper<TRoutes>
	$url: PathHelper<TRoutes>
	delete: Method<TRoutes, "delete">
	get: Method<TRoutes, "get">
	patch: Method<TRoutes, "patch">
	post: Method<TRoutes, "post">
	put: Method<TRoutes, "put">
	/** the same calls, each answering a Result instead of throwing an API answer (bit 21 i) */
	safe: { [M in "delete" | "get" | "patch" | "post" | "put"]: SafeMethod<TRoutes, M> }
	ws(
		path: string,
		input?: {
			params?: Record<string, string>
			protocols?: string | string[]
			reconnectToken?: string
			search?: Record<string, unknown>
		},
	): TypedWebSocket
}
