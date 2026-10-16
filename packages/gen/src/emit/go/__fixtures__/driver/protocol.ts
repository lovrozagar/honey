/**
 * The test driver's protocol beside its stdin envelope: the optional `script` a unit test adds to a
 * grid cell (decoded strictly by script.go), and the `trace` (trace.go, stream.go) printed beside
 * the observed when one is given. The conformance runner and the harness never send a script.
 */

/** A scripted WebSocket Send: a JSON value (decoded, so Send marshals it), text, or that many bytes `i & 0xff`. */
export type WsMessage = { readonly json: Json } | { readonly text: string } | { readonly bytes: number }

/** One call's script entry: how its ctx ends, a wait before it, what to set or check, and stream controls. */
export type CallScript = {
	/** cancel the call's ctx before the call, or that many ms into it */
	readonly cancel?: "before" | { readonly afterMs: number }
	/** a caller deadline on the call's ctx (context.WithTimeout) */
	readonly ctxTimeoutMs?: number
	/** errors.Is(err, sdk.<name>) for each name, into the trace's `sentinels` */
	readonly isErrors?: readonly ("ErrSSEEventTooLarge" | "ErrSSELineTooLong")[]
	/** errors.Is(err, sdk.ErrorKey(k)) for each k, into the trace's `keys` */
	readonly isKeys?: readonly string[]
	/** sets `<Op>Opts.IdempotencyKey` */
	readonly idempotencyKey?: string
	/** a binary body as a bare io.Reader: no length, no GetBody */
	readonly oneShotBody?: true
	/** sets `<Op>Opts.Protocols` (WebSocket, realtime) */
	readonly protocols?: readonly string[]
	/** sets the realtime `<Op>Opts.MaxReconnectAttempts` and `ReconnectDelayMs` */
	readonly realtime?: { readonly maxReconnectAttempts?: number; readonly reconnectDelayMs?: number }
	/** sleep before the call, outside its `elapsedMs` */
	readonly sleepMs?: number
	readonly ws?: {
		/** Close's code and reason, in place of 1000 and none */
		readonly close?: { readonly code: number; readonly reason: string }
		/** register a recording On handler for message, close and error */
		readonly on?: true
		/** SetReadLimit before the reads */
		readonly readLimit?: number
		/** sent after the grid's `send`, in order */
		readonly send?: readonly WsMessage[]
	}
}

/** The driver's optional `script` (G8), decoded strictly: what a unit test adds to a grid cell. */
export type Script = {
	readonly calls?: readonly (CallScript | null)[]
	readonly config?: {
		/** Config.AuthHeaderName and AuthHeaderPrefix as given */
		readonly authHeaderName?: string
		readonly authHeaderPrefix?: string
		/** Config.HTTPClient: a caller client counting its round trips and CheckRedirect calls */
		readonly httpClient?: true
		readonly invalidation?: {
			readonly maxSourcesPerTarget?: number
			readonly staleMaxEntries?: number
			readonly staleTimeMs: number
		}
		readonly maxResponseBytes?: number
	}
	/** one hook per entry, in order; an absent list installs one no-op recording hook */
	readonly hooks?: {
		readonly request?: readonly { readonly fail?: string; readonly setHeader?: readonly [string, string] }[]
		readonly response?: readonly { readonly body?: string; readonly fail?: string }[]
	}
	/** install OnLog */
	readonly log?: true
	/** OnAuthExpired: the i-th refresh returns tokens[i], and fails past the end */
	readonly onAuthExpired?: { readonly tokens: readonly string[] }
}

/** A JSON value. */
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

/** A call's Go error as the trace records it; `canceled`, `deadline` and `tooLarge` are errors.Is against context.Canceled, context.DeadlineExceeded and sdk.ErrResponseTooLarge. */
export type GoError = {
	readonly canceled: boolean
	/** `%T` of the error, then of each errors.Unwrap step; pin only the `*sdk.` entries */
	readonly chain: readonly string[]
	readonly deadline: boolean
	readonly keys?: Readonly<Record<string, boolean>>
	/** errors.As *sdk.PathParamError */
	readonly pathParam?: { readonly missing: boolean; readonly name: string; readonly value: string }
	/** errors.Is against each sentinel `isErrors` names */
	readonly sentinels?: Readonly<Record<string, boolean>>
	/** errors.As sdk.APIError → Status() */
	readonly status?: number
	readonly text: string
	readonly tooLarge: boolean
	readonly type: string
	/** the method's error value, a safe-mode SDKResult.Err, or one a stream delivered (yielded, read, on Errors()) */
	readonly via: "result" | "return" | "stream"
}

/** What a stream call recorded; each optional member is absent when empty. */
export type StreamTrace = {
	/** WebSocket: the close frame a Read ended on (no take, or before take was reached) */
	readonly closedBy?: { readonly code: number; readonly reason: string }
	/** WebSocket: Close's error text, when non-nil */
	readonly closeError?: string
	/** WebSocket with `ws.on`: every handler run in firing order, those the driver's own Close fires included */
	readonly handlers?: readonly { readonly data: string; readonly event: "close" | "error" | "message" }[]
	/** SSE with typed response headers: the `<Op>Headers` WithHeadersInto filled (as `headers` of a data Observed) */
	readonly headers?: Readonly<Record<string, string>>
	/** realtime, read after Close: the resume cursor, the transport that last opened, every Errors() value */
	readonly realtime?: {
		readonly cursor: { readonly lastEventId: string; readonly reconnectToken: string }
		readonly errors: readonly string[]
		readonly proven: "longpoll" | "sse" | "ws" | null
	}
	/** SSE: each observed event's Retry */
	readonly retry?: readonly number[]
	/** SSE: values the iterator yielded, errors included; WebSocket and realtime: frames read */
	readonly yields: number
}

/** One hook run: its phase, its index among that phase's hooks, the call it ran for and what it saw. */
export type HookTrace = {
	readonly call: number
	readonly index: number
	readonly invalidatedBy: readonly string[]
	readonly isRetry: boolean
	readonly isStale: boolean
	readonly method?: string
	readonly path?: string
	readonly phase: "request" | "response"
	readonly selector: string
	readonly status?: number
	readonly url?: string
}

/** One call: its time, its error when it has one, a safe-mode SDKResult the method returned without one, and a stream's trace. */
export type CallTrace = {
	readonly elapsedMs: number
	/** every non-nil error, ClientErrors included */
	readonly error?: GoError
	readonly result?: {
		readonly data: boolean
		readonly ok: boolean
		readonly response: boolean
		readonly status: number
	}
	readonly stream?: StreamTrace
}

/** One OnLog entry, its error as text. */
export type LogTrace = {
	readonly error?: string
	readonly event: string
	readonly level: string
	readonly operation: string
	readonly status?: number
}

/** What a scripted run recorded beside the observed. */
export type Trace = {
	/** OnAuthExpired calls */
	readonly authExpired: number
	readonly calls: readonly CallTrace[]
	readonly hooks: readonly HookTrace[]
	readonly log: readonly LogTrace[]
	/** the caller HTTPClient's counts, with `config.httpClient` */
	readonly transport?: { readonly checkRedirect: number; readonly roundTrips: number }
}
