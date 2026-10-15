import type { HoneyClient, InferRoutes } from "./app-types.ts"
import type { ClientConfig } from "./config.ts"
import { isClientError } from "./error.ts"
import { HTTPClient } from "./http.ts"
import type { RequestOptions } from "./request.ts"
import type { SSEEvent } from "./sse.ts"
import { createTypedWebSocket, type TypedWebSocket } from "./ws.ts"

const HTTP_METHODS: readonly string[] = ["delete", "get", "patch", "post", "put"]

/** What a path-addressed helper (`$url`, `$path`, `ws`) reads of its input. */
type PathInput = {
	params?: Record<string, string>
	protocols?: string | string[]
	reconnectToken?: string
	search?: Record<string, unknown>
}

function isAsyncIterable(value: unknown): value is AsyncIterable<SSEEvent> {
	return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}

/**
 * One call, one request, consumed either way:
 * - `await api.get(...)` sends it; an event-stream response resolves to an
 *   `AsyncIterable<SSEEvent>` (never buffered), anything else to the parsed body or result.
 * - `for await (... of api.get(...))` before the call has started sends it as a stream request
 *   (`accept: text/event-stream`, no timeout).
 * - iterating after awaiting reuses the same response instead of sending again.
 */
function lazyCall(
	http: HTTPClient,
	call: { method: string; opts: RequestOptions; path: string; shouldThrow: boolean },
) {
	const { method, opts, path, shouldThrow } = call
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

/** The helpers that sit beside the methods: `$isClientError`, `$url`, `$path` and `ws`. */
function helper(http: HTTPClient, prop: string): unknown {
	if (prop === "$isClientError") return isClientError
	if (prop === "$url") return (path: string, input?: PathInput) => http.buildUrl(path, input ?? {})
	if (prop === "$path") return (path: string, input?: PathInput) => http.buildPath(path, input ?? {})
	if (prop !== "ws") return undefined
	return (path: string, input?: PathInput): TypedWebSocket => {
		let url = http.buildWSUrl(path, { params: input?.params, search: input?.search })
		if (input?.reconnectToken)
			url += `${url.includes("?") ? "&" : "?"}reconnect_token=${encodeURIComponent(input.reconnectToken)}`
		return createTypedWebSocket(url, { protocols: input?.protocols })
	}
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
			if (prop === Symbol.toStringTag) return "HoneyClient"
			if (typeof prop === "symbol" || prop === "then") return undefined
			if (prop === "toString" || prop === "toJSON") return () => "[object HoneyClient]"
			if (!HTTP_METHODS.includes(prop)) return helper(http, prop)
			const shouldThrow = config.throwOnError === true
			return (path: string, input?: RequestOptions) =>
				lazyCall(http, { method: prop.toUpperCase(), opts: input ?? {}, path, shouldThrow })
		},
	})
}
