/**
 * The executed-SDK test driver's protocol beside its stdin envelope, the JSON contract every target's
 * driver shares: the optional `script` a unit test adds to a grid cell (decoded strictly; Go:
 * emit/go/__fixtures__/driver/script.go), and the `trace` (Go: trace.go, stream.go there) printed
 * beside the observed when one is given. Unit tests and the harness send one; the conformance runner
 * never does. Members are documented in Go's terms, the first driver's. The Rust driver
 * (emit/rust/__fixtures__/driver/script.rs, trace.rs, stream.rs) reads the same script, refusing for
 * good what is Go's alone (`ctxTimeoutMs`, `isKeys`, `isErrors`, `ws.readLimit`), and records its
 * errors as `RustError`: its trace is `Trace<RustError>`. `protocols`, `realtime` and `ws` mean the
 * same to it, on the Opts fields and `TypedWebSocket` methods of those names. The Python driver
 * (emit/python/__fixtures__/driver/script.py, tracing.py, stream.py) reads it on `SDK` and `AsyncSDK` alike,
 * refuses the same Go-only members, adds `taskCancel` (an `AsyncSDK` task's), and records its errors as
 * `PythonError`: its trace is `Trace<PythonError>`. It drives streams on `AsyncSDK` alone, refusing a stream call
 * on `SDK` (which has none), `raw: true` on a stream, and the stream members Rust refuses, in the same words;
 * `protocols` and `realtime` are the method's `protocols`, `max_reconnect_attempts` and `reconnect_delay_ms`.
 * The C# driver (emit/csharp/__fixtures__/driver/) takes the same envelope on its one async client and records
 * its errors as `CsError`: its trace is `Trace<CsError>`. It reads the script (refusing `ctxTimeoutMs`, `isKeys`,
 * `isErrors` and `taskCancel` for good, and a multipart call), maps `cancel` to the method's `CancellationToken`,
 * and `httpClient` to `ClientConfig.Handler` (a caller chain). In phase d it drives SSE, WebSocket and realtime
 * calls (`events`, `frames`, `live`), refusing `raw: true` on a stream and `ws.readLimit` for good; `protocols` and
 * `realtime` are the method's `protocols`, `maxReconnectAttempts` and `reconnectDelay`; a cancel observes the
 * stream's quiet end and traces its OCE (`canceled: true`, `via: "stream"`); it never disposes a stream it
 * observed, and records `closeError` when `CloseAsync` throws.
 */

/** The Java driver's error record (java-error.ts), beside the others. */
export type { JavaError } from "./java-error.ts"

/** A scripted WebSocket Send: a JSON value (decoded, so Send marshals it), text, or that many bytes `i & 0xff`. */
export type WsMessage = { readonly json: Json } | { readonly text: string } | { readonly bytes: number }

/** One call's script entry: how its ctx ends, a wait before it, what to set or check, and stream controls. */
export type CallScript = {
	/** cancel the call's ctx before the call, or that many ms into it */
	readonly cancel?: "before" | { readonly afterMs: number }
	/** a caller deadline on the call's ctx (context.WithTimeout) */
	readonly ctxTimeoutMs?: number
	/** errors.Is(err, sdk.<name>) for each name, into the trace's `sentinels` (Go only: Rust refuses it) */
	readonly isErrors?: readonly ("ErrSSEEventTooLarge" | "ErrSSELineTooLong")[]
	/** errors.Is(err, sdk.ErrorKey(k)) for each k, into the trace's `keys` */
	readonly isKeys?: readonly string[]
	/** sets `<Op>Opts.IdempotencyKey` */
	readonly idempotencyKey?: string
	/** with a *sdk.ClientError, its typed Envelope into the trace's `envelope` */
	readonly envelope?: true
	/** a binary body as a bare io.Reader: no length, no GetBody */
	readonly oneShotBody?: true
	/** sets `<Op>Opts.Protocols` (WebSocket, realtime) */
	readonly protocols?: readonly string[]
	/** sets the realtime `<Op>Opts.MaxReconnectAttempts` and `ReconnectDelayMs` */
	readonly realtime?: { readonly maxReconnectAttempts?: number; readonly reconnectDelayMs?: number }
	/** sleep before the call, outside its `elapsedMs` */
	readonly sleepMs?: number
	/** Python only: the call's `asyncio` task is cancelled that many ms in (`AsyncSDK`); Go and Rust refuse it */
	readonly taskCancel?: { readonly afterMs: number }
	readonly ws?: {
		/** Close's code and reason, in place of 1000 and none */
		readonly close?: { readonly code: number; readonly reason: string }
		/** register a recording On handler for message, close and error */
		readonly on?: true
		/** SetReadLimit before the reads (Go only: a Rust or Python socket caps a message at 16 MiB, and refuses it) */
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
		/**
		 * Go: Config.HTTPClient, a caller client counting its round trips and CheckRedirect calls. Rust:
		 * `http_builder`, a caller builder with user agent `honey-driver` and `Policy::limited(10)` (reqwest has
		 * no round-trip hook, so no `transport` count; the user agent is what a hop shows). C#: `ClientConfig.Handler`,
		 * a caller link adding `User-Agent: honey-driver`, `X-Builder: b` and basic auth where the request has none,
		 * over a `SocketsHttpHandler` with redirects on (no `transport` count either)
		 */
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
	/** each OnLog entry's `durationMs` into the trace (needs `log`) */
	readonly logDurations?: true
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
	/** with `envelope`, a *sdk.ClientError's Envelope as JSON: its named members, empty ones omitted, never Extra */
	readonly envelope?: Json
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
	/** the method's error value, a Client.Safe() Result's Err, or one a stream delivered (yielded, read, on Errors()) */
	readonly via: "result" | "return" | "stream"
}

/** A call's Rust error as the trace records it (`sdk::Error`, read through its accessors). */
export type RustError = {
	readonly variant:
		| "Api"
		| "AuthExpired"
		| "Canceled"
		| "Closed"
		| "Config"
		| "Decode"
		| "Hook"
		| "PathParam"
		| "Timeout"
		| "Transport"
	/** `to_string()` */
	readonly text: string
	/** `format!("{e:?}")`, for the redaction legs */
	readonly debug: string
	/** the method's Err, a safe-mode `SdkResult.error`, or one a stream yielded (`next()`, `recv()`) or a send returned */
	readonly via: "result" | "return" | "stream"
	/** `std::error::Error::source()` is Some */
	readonly source: boolean
	/** `Error::status()` */
	readonly status?: number
	/** Api only: `ApiError::kind()`, its Debug name */
	readonly kind?: string
	/** Api only: `ApiError::key()` as the wire spells it; null without one */
	readonly key?: string | null
	/** Api only: `format!("{:?}", key())`: "Some(ItemNotFound)", "None" */
	readonly keyVariant?: string
	/** Api only: `ApiError::message()` */
	readonly message?: string
	/** Api with `envelope`: the envelope's members that are set (status, error_key, status_key, message, fields), and `extraKeys`, its extra keys sorted */
	readonly envelope?: Json
}

/** A call's Python error as the trace records it (the exception, read through its attributes). */
export type PythonError = {
	/** `type(e).__name__`: "NotFoundError", "HookError", "CancelledError", … */
	readonly type: string
	/** the class names of `type(e).__mro__` up to and including HoneyError; `[type]` for an exception outside the SDK */
	readonly chain: readonly string[]
	/** `str(e)` */
	readonly text: string
	/** `repr(e)`, for the redaction legs */
	readonly repr: string
	/** the method's raise, a safe-mode `SDKResult.error`, or one a stream raised */
	readonly via: "result" | "return" | "stream"
	/** `type(e.__cause__).__name__`; null without one */
	readonly cause: string | null
	/** `APIStatusError.status` */
	readonly status?: number
	/** APIStatusError only: `str(e.key)`; null without one */
	readonly key?: string | null
	/** APIStatusError only: `e.key.name` when `e.key` is an `ErrorKey` member; null otherwise */
	readonly keyMember?: string | null
	/** APIStatusError only: `e.message` */
	readonly message?: string
	/** APIStatusError with `envelope`: the envelope's members that are set (status, error_key, status_key, message, fields), and `extraKeys`, its extra keys sorted */
	readonly envelope?: Json
}

/** A call's C# error as the trace records it (the exception, read through its members). */
export type CsError = {
	/** `e.GetType().Name`: "NotFoundException", "ApiTimeoutException", "TaskCanceledException", … */
	readonly type: string
	/** the type names from `e.GetType()` through its base types up to and including HoneyException; `[type]` outside the SDK */
	readonly chain: readonly string[]
	/** `e.Message` */
	readonly text: string
	/** `e.ToString()`'s lines before the first stack frame (`   at `), for the redaction legs */
	readonly display: string
	/** the method's throw, a safe-mode `SdkResult.Error`, or one a stream threw */
	readonly via: "result" | "return" | "stream"
	/** `e.InnerException?.GetType().Name`; null without one */
	readonly inner: string | null
	/** `e is OperationCanceledException` (R4: the caller's token) */
	readonly canceled: boolean
	/** ApiStatusException only: `Status` */
	readonly status?: number
	/** ApiStatusException only: `Key`'s wire value; null without one */
	readonly key?: string | null
	/** ApiStatusException only: the name of the `ErrorKey` constant whose value equals `Key`; null when none does */
	readonly keyMember?: string | null
	/** ApiStatusException only: `Detail`, the envelope's message or the sanitized body */
	readonly message?: string
	/** ApiStatusException with `envelope`: its set members (status, error_key, status_key, message, fields), and `extraKeys`, its extra keys sorted */
	readonly envelope?: Json
}

/** What a stream call recorded; each optional member is absent when empty. */
export type StreamTrace = {
	/** WebSocket: the close frame a Read ended on (no take, or before take was reached) */
	readonly closedBy?: { readonly code: number; readonly reason: string }
	/** WebSocket (Rust: and realtime): Close's error text, when non-nil; never set by Python, whose `close()` does not raise */
	readonly closeError?: string
	/** WebSocket with `ws.on`: every handler run in firing order, those the driver's own Close fires included */
	readonly handlers?: readonly { readonly data: string; readonly event: "close" | "error" | "message" }[]
	/** SSE with typed response headers: the `<Op>Headers` WithHeadersInto filled (as `headers` of a data Observed) */
	readonly headers?: Readonly<Record<string, string>>
	/**
	 * realtime, read after Close: the resume cursor, the transport that last opened, every Errors() value.
	 * Rust: the cursor is `last_event_id()`/`reconnect_token()`, `None` as `""`; the errors are what `recv()` yielded.
	 * Python: the cursor is `conn.opts`, `None` as `""`, and `proven` is `proven_transport`'s value; the errors are
	 * what `recv()` raised
	 */
	readonly realtime?: {
		readonly cursor: { readonly lastEventId: string; readonly reconnectToken: string }
		readonly errors: readonly string[]
		readonly proven: "longpoll" | "sse" | "ws" | null
	}
	/** SSE: each observed event's Retry; Rust and Python record null for an event without one, Go never does */
	readonly retry?: readonly (number | null)[]
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

/** One call: its time, its error when it has one, a safe call's Result the method returned without one, and a stream's trace. */
export type CallTrace<E = GoError> = {
	readonly elapsedMs: number
	/** every non-nil error, ClientErrors included */
	readonly error?: E
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
	/** LogEntry.DurationMs, only under `logDurations` */
	readonly durationMs?: number
	readonly error?: string
	readonly event: string
	readonly level: string
	readonly operation: string
	readonly status?: number
}

/** What a scripted run recorded beside the observed: `E` is the target's error record. */
export type Trace<E = GoError> = {
	/** OnAuthExpired calls */
	readonly authExpired: number
	readonly calls: readonly CallTrace<E>[]
	readonly hooks: readonly HookTrace[]
	readonly log: readonly LogTrace[]
	/** the caller HTTPClient's counts, with `config.httpClient` */
	readonly transport?: { readonly checkRedirect: number; readonly roundTrips: number }
}
