import type { InferRoutes } from "../types.ts"
import { isClientError } from "./error.ts"
import type { ClientConfig } from "./http.ts"
import { HTTPClient } from "./http.ts"
import type { HoneyClient } from "./types.ts"
import type { TypedWebSocket } from "./ws.ts"
import { createTypedWebSocket } from "./ws.ts"

export type { ClientErrorInit } from "./error.ts"
export { ClientError, isClientError } from "./error.ts"
export type { ClientConfig, RequestOptions } from "./http.ts"
export { HTTPClient } from "./http.ts"
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

export function createClient<T>(
	config: ClientConfig & { throwOnError: true },
): HoneyClient<InferRoutes<T>, true>
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
		get(_target, prop: string) {
			if (prop === "$isClientError") return isClientError

			if (prop === "$url") {
				return (
					path: string,
					input?: { params?: Record<string, string>; search?: Record<string, unknown> },
				) => http.buildUrl(path, input ?? {})
			}

			if (prop === "$path") {
				return (
					path: string,
					input?: { params?: Record<string, string>; search?: Record<string, unknown> },
				) => http.buildPath(path, input ?? {})
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
					 * Lazy dual-mode: both PromiseLike (REST) and AsyncIterable (SSE).
					 * - `await api.get(...)` → REST (request or requestSafe)
					 * - `for await (... of api.get(...))` → SSE (requestStream)
					 */
					let mode: "idle" | "rest" | "sse" = "idle"
					let restPromise: Promise<unknown> | undefined
					const lazyRest = (): Promise<unknown> => {
						if (!restPromise) {
							restPromise = shouldThrow
								? http.request(method, path, opts)
								: http.requestSafe(method, path, opts)
						}
						return restPromise
					}

					const lazy = new Promise((resolve, reject) => {
						queueMicrotask(() => {
							if (mode === "sse") return
							mode = "rest"
							lazyRest().then(resolve, reject)
						})
					})
					Object.defineProperty(lazy, Symbol.asyncIterator, {
						value() {
							mode = "sse"
							return http.requestStream(method, path, opts)[Symbol.asyncIterator]()
						},
					})
					return lazy
				}
			}

			return undefined
		},
	})
}
