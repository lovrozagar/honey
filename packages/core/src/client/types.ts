import type { FieldError, InferOutput, ParamsFromPath, StandardSchemaLike } from "../types.ts"
import type { SSEEvent } from "./sse.ts"
import type { TypedWebSocket } from "./ws.ts"

/** Extract paths that have a specific method registered */
export type PathsForMethod<TRoutes, M extends string> = {
	[P in keyof TRoutes & string]: M extends keyof TRoutes[P] ? P : never
}[keyof TRoutes & string]

/** Extract input type for a route */
export type InputFor<TRoutes, P extends string, M extends string> = P extends keyof TRoutes
	? M extends keyof TRoutes[P]
		? TRoutes[P][M] extends { input: infer I }
			? I
			: {}
		: {}
	: {}

/** Extract output schema definition for a route */
export type OutputDefFor<TRoutes, P extends string, M extends string> = P extends keyof TRoutes
	? M extends keyof TRoutes[P]
		? TRoutes[P][M] extends { output: infer O }
			? O
			: never
		: never
	: never

/** Check if output definition is empty (no .output() declared) */
type IsEmptyOutput<O> = keyof O extends never ? true : false

/** Content-type to return type mapping for non-JSON outputs */
type ContentTypeReturn<O> = O extends { "text/plain": unknown }
	? string
	: O extends { "text/html": unknown }
		? string
		: O extends { "text/csv": unknown }
			? string
			: O extends { "application/xml": unknown }
				? string
				: O extends { "application/octet-stream": unknown }
					? ArrayBuffer
					: null

/** Extract the resolved output type — infer from schema validators in the output definition */
export type OutputFor<TRoutes, P extends string, M extends string> =
	OutputDefFor<TRoutes, P, M> extends infer O
		? [O] extends [never]
			? null
			: IsEmptyOutput<O> extends true
				? null
				: O extends { "application/json": infer JsonMap }
					? JsonMap extends Record<string, StandardSchemaLike>
						? InferOutput<JsonMap[keyof JsonMap]>
						: null
					: ContentTypeReturn<O>
		: null

/** Check if a route returns SSE (text/event-stream in output) */
export type IsSSE<TRoutes, P extends string, M extends string> =
	OutputDefFor<TRoutes, P, M> extends infer O
		? O extends { "text/event-stream": unknown }
			? true
			: false
		: false

/** Extract errorsByStatus from route record if available */
type ErrorsByStatusFor<TRoutes, P extends string, M extends string> = P extends keyof TRoutes
	? M extends keyof TRoutes[P]
		? TRoutes[P][M] extends { errorsByStatus: infer S }
			? S
			: never
		: never
	: never

/** Default Honey error envelope — used when errorsByStatus lists `null` (standard errors) */
export type ErrorEnvelope<TStatus extends number = number, TKey extends string = string> = {
	error_key: TKey
	fields: Record<string, FieldError[]>
	message: string
	status: TStatus
	status_key: string
	success: false
}

/** `null` in a route's errorsByStatus means the default envelope, not a null body */
type ResolveErrorBody<S extends number, T> = T extends null ? ErrorEnvelope<S> : T

/** Object keys of `{ 400: ... }` are `400` or `"400"` depending on TS version */
type StatusCode<K> = K extends number ? K : K extends `${infer N extends number}` ? N : never

type HasStatusErrors<T> = [StatusCode<keyof T>] extends [never] ? false : true

type ErrorVariants<TErrorsByStatus> = {
	[K in keyof TErrorsByStatus]: StatusCode<K> extends never
		? never
		: {
				data: null
				error: ResolveErrorBody<StatusCode<K>, TErrorsByStatus[K]>
				response: Response
				status: StatusCode<K>
			}
}[keyof TErrorsByStatus]

/**
 * Result tuple for safe (non-throwing) mode — error is the raw parsed body, not ClientError.
 * When TErrorsByStatus is known, the typed branch covers every declared error status
 * (no unknown fallback) so `if (error)` / `if (!error)` narrow.
 */
export type ClientResult<TData, TErrorsByStatus = never> =
	| { data: TData; error: null; response: Response; status: number }
	| (HasStatusErrors<TErrorsByStatus> extends false
		? { data: null; error: unknown; response: Response; status: number }
		: ErrorVariants<TErrorsByStatus>)

/** Resolve return type based on transport + throw mode */
export type ReturnFor<TRoutes, P extends string, M extends string, TThrow extends boolean = true> =
	IsSSE<TRoutes, P, M> extends true
		? AsyncIterable<SSEEvent>
		: TThrow extends true
			? Promise<OutputFor<TRoutes, P, M>>
			: Promise<ClientResult<OutputFor<TRoutes, P, M>, ErrorsByStatusFor<TRoutes, P, M>>>

/** Build the client input type — merge route input with params from path */
export type ClientInput<TRoutes, P extends string, M extends string> = InputFor<TRoutes, P, M> &
	ParamsInput<P>

/** Extract params input if path has params */
type ParamsInput<P extends string> =
	ParamsFromPath<P> extends Record<string, string>
		? HasParams<P> extends true
			? { params: ParamsFromPath<P> }
			: {}
		: {}

/** Check if path has any param segments */
type HasParams<P extends string> = P extends `${string}:${string}` ? true : false

/** Extract error keys for a route */
export type ErrorsFor<TRoutes, P extends string, M extends string> = P extends keyof TRoutes
	? M extends keyof TRoutes[P]
		? TRoutes[P][M] extends { errors: infer E extends string }
			? E
			: never
		: never
	: never

/** The typed client interface — TThrow controls return type */
export type HoneyClient<TRoutes, TThrow extends boolean = false> = {
	$isClientError: (e: unknown) => e is import("./error.ts").ClientError

	$path<P extends keyof TRoutes & string>(
		path: P,
		input?: { params?: Record<string, string>; search?: Record<string, unknown> },
	): string

	$url<P extends keyof TRoutes & string>(
		path: P,
		input?: { params?: Record<string, string>; search?: Record<string, unknown> },
	): string

	delete<P extends PathsForMethod<TRoutes, "delete">>(
		path: P,
		...input: OptionalInput<ClientInput<TRoutes, P, "delete">>
	): ReturnFor<TRoutes, P, "delete", TThrow>

	get<P extends PathsForMethod<TRoutes, "get">>(
		path: P,
		...input: OptionalInput<ClientInput<TRoutes, P, "get">>
	): ReturnFor<TRoutes, P, "get", TThrow>

	patch<P extends PathsForMethod<TRoutes, "patch">>(
		path: P,
		...input: OptionalInput<ClientInput<TRoutes, P, "patch">>
	): ReturnFor<TRoutes, P, "patch", TThrow>

	post<P extends PathsForMethod<TRoutes, "post">>(
		path: P,
		...input: OptionalInput<ClientInput<TRoutes, P, "post">>
	): ReturnFor<TRoutes, P, "post", TThrow>

	put<P extends PathsForMethod<TRoutes, "put">>(
		path: P,
		...input: OptionalInput<ClientInput<TRoutes, P, "put">>
	): ReturnFor<TRoutes, P, "put", TThrow>

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

/** Make input optional when it's an empty object */
type OptionalInput<T> = keyof T extends never
	? [input?: T]
	: [RequiresAllOptional<T>] extends [true]
		? [input?: T]
		: [input: T]

/** Check if all keys in T are optional */
type RequiresAllOptional<T> = {
	[K in keyof T]-?: undefined extends T[K] ? true : false
}[keyof T] extends true
	? true
	: Partial<T> extends T
		? true
		: false
