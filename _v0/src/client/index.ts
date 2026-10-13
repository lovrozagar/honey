import type { InferRoutes } from "../types.ts"
import { isClientError } from "./error.ts"
import type { ClientConfig } from "./http.ts"
import { HTTPClient } from "./http.ts"
import type { HoneyClient } from "./types.ts"
import type { TypedWebSocket } from "./ws.ts"
import { createTypedWebSocket } from "./ws.ts"

export type { ClientErrorInit } from "./error.ts"
export {
	BadGatewayError,
	BadRequestError,
	ClientError,
	ConflictError,
	ForbiddenError,
	GatewayTimeoutError,
	InternalServerError,
	isClientError,
	NotFoundError,
	RateLimitError,
	ServiceUnavailableError,
	UnauthorizedError,
	UnprocessableEntityError,
} from "./error.ts"
export { PathParamError } from "./path.ts"
export type { AuthExpiredContext, ClientConfig, RedirectPolicy, RequestOptions } from "./http.ts"
export { HTTPClient, newClientRequestId } from "./http.ts"
import type { SSEEvent } from "./sse.ts"

export type { SSEEvent } from "./sse.ts"
export { parseSSEStream } from "./sse.ts"
export type {
	ClientInput,
	ClientResult,
	ErrorEnvelope,
	ErrorsFor,
	HoneyClient,
	InputFor,
	IsSSE,
	OutputDefFor,
	OutputFor,
	PathsForMethod,
	ReturnFor,
} from "./types.ts"
export type { TypedWebSocket } from "./ws.ts"
export { createTypedWebSocket } from "./ws.ts"

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"])

function isAsyncIterable(value: unknown): value is AsyncIterable<SSEEvent> {
	return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}

export function createClient<T>(config: ClientConfig & { throwOnError: true }): HoneyClient<InferRoutes<T>, true>
export function createClient<T>(
	config: Omit<ClientConfig, "throwOnError"> & { throwOnError?: false },
): HoneyClient<InferRoutes<T>, false>
export function createClient<T, TThrow extends boolean>(
	config: ClientConfig & { throwOnError?: TThrow },
): HoneyClient<InferRoutes<T>, TThrow>
export function createClient<T, TThrow extends boolean = false>(
	config: ClientConfig & { throwOnError?: TThrow },
): HoneyClient<InferRoutes<T>, TThrow> {
	const http = new HTTPClient(config)

	return new Proxy({} as HoneyClient<InferRoutes<T>, TThrow>, {
		get(_target, prop: string | symbol) {
			/* not a thenable, and printable: `await client` and `String(client)` must not hit the method table */
			if (typeof prop === "symbol" || prop === "then") return undefined
			if (prop === "toString" || prop === "toJSON") return () => "[object HoneyClient]"
			if (prop === "$isClientError") return isClientError

			if (prop === "$url") {
				return (path: string, input?: { params?: Record<string, string>; search?: Record<string, unknown> }) =>
					http.buildUrl(path, input ?? {})
			}

			if (prop === "$path") {
				return (path: string, input?: { params?: Record<string, string>; search?: Record<string, unknown> }) =>
					http.buildPath(path, input ?? {})
			}

			if (prop === "ws") {
				return (
					path: string,
					input?: {
						params?: Record<string, string>
						protocols?: string | string[]
						reconnectToken?: string
						search?: Record<string, unknown>
					},
				): TypedWebSocket => {
					const opts = { params: input?.params, search: input?.search }
					let url = http.buildWSUrl(path, opts)
					if (input?.reconnectToken) {
						const sep = url.includes("?") ? "&" : "?"
						url = `${url}${sep}reconnect_token=${encodeURIComponent(input.reconnectToken)}`
					}
					return createTypedWebSocket(url, { protocols: input?.protocols })
				}
			}

			if (HTTP_METHODS.has(prop)) {
				return (path: string, input?: Record<string, unknown>) => {
					const method = prop.toUpperCase()
					const opts = input ?? {}
					const shouldThrow = config.throwOnError === true

					/**
					 * One call, one request, consumed either way:
					 * - `await api.get(...)` sends it; an event-stream response resolves to an
					 *   `AsyncIterable<SSEEvent>` (never buffered), anything else to the parsed body
					 *   or result tuple. Returning the call from an async function works the same.
					 * - `for await (... of api.get(...))` before the call has started sends it as a
					 *   stream request (`accept: text/event-stream`, no timeout).
					 * - iterating after awaiting reuses the same response instead of sending again.
					 */
					let mode: "auto" | "idle" | "sse" = "idle"
					let auto: Promise<unknown> | undefined
					const runAuto = (): Promise<unknown> => {
						auto ??= http.requestAuto(method, path, opts, shouldThrow)
						return auto
					}

					const lazy = new Promise((resolve, reject) => {
						queueMicrotask(() => {
							if (mode === "sse") return
							mode = "auto"
							runAuto().then(resolve, reject)
						})
					})
					Object.defineProperty(lazy, Symbol.asyncIterator, {
						value() {
							if (mode === "idle") {
								mode = "sse"
								return http.requestStream(method, path, opts)[Symbol.asyncIterator]()
							}
							return (async function* () {
								const result = await runAuto()
								if (isAsyncIterable(result)) {
									yield* result
									return
								}
								const error = (result as { error?: unknown } | null)?.error
								if (error) throw error instanceof Error ? error : new Error("Request failed")
								throw new TypeError(`${method} ${path} did not respond with an event stream`)
							})()
						},
					})
					return lazy
				}
			}

			return undefined
		},
	})
}
