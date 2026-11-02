/**
 * `otelAdapter(api, options)`: the Telemetry value `app.telemetry()` carries, over the app's own
 * OpenTelemetry API. Pass the `@opentelemetry/api` module itself; honey imports no OpenTelemetry
 * package, so there is one shared instance and nothing to load. Only `trace` and `context` are used:
 * honey parses `traceparent` itself (the trust gate validates what it continues), so no propagator
 * has to be registered. Every span's parent is passed explicitly; `run` makes the handler's span the
 * active one only so the app's own instrumentation nests under it.
 */
import type { InboundTrust } from "../middleware/request-id.ts"
import type { Attributes, Span, SpanOptions, Telemetry, TelemetryErrorReport, Tracer } from "./request-trace.ts"
import type { RemoteContext } from "./traceparent.ts"

/** OpenTelemetry's `TraceState`, as its spans carry one. */
type OtelTraceState = {
	/** The value stored under `key`, or `undefined`. */
	get(key: string): string | undefined
	/** The state as a `tracestate` header value. */
	serialize(): string
	/** A new state with `key` set and moved to the front. */
	set(key: string, value: string): OtelTraceState
	/** A new state without `key`. */
	unset(key: string): OtelTraceState
}

/** OpenTelemetry's `SpanContext`, the part the adapter reads and builds. */
type OtelSpanContext = {
	/** `true` for a span context that came from another process. */
	readonly isRemote?: boolean
	/** The span id: 16 lowercase hex characters. */
	readonly spanId: string
	/** The trace flags byte; the lowest-order flag marks the trace as sampled. */
	readonly traceFlags: number
	/** The trace id: 32 lowercase hex characters. */
	readonly traceId: string
	/** The `tracestate`, when the span context carries one. */
	readonly traceState?: OtelTraceState
}

/** OpenTelemetry's span options, the part the adapter passes to `startSpan`. */
type OtelSpanOptions = {
	/** Attributes set on the span when it starts. */
	readonly attributes?: Attributes
	/** OpenTelemetry's `SpanKind` number: 0 internal, 1 server, 2 client. */
	readonly kind?: number
	/** Spans this one is linked to without being their child. */
	readonly links?: {
		/** The linked span's context. */
		readonly context: OtelSpanContext
	}[]
}

/** The part of `@opentelemetry/api` the adapter uses: pass the module itself. */
export type OtelApi = {
	/** OpenTelemetry's context API. */
	readonly context: {
		/** The ambient context. */
		active(): unknown
		/** Runs `fn` with `context` as the ambient context. */
		with<T>(context: unknown, fn: () => T): T
	}
	/** OpenTelemetry's trace API. */
	readonly trace: {
		/** A copy of `context` with no active span. */
		deleteSpan(context: unknown): unknown
		/** The tracer named `name`. */
		getTracer(name: string): {
			/** Starts a span named `name` as a child of the active span in `context`; with none there, it starts a new trace. */
			startSpan(name: string, options?: OtelSpanOptions, context?: unknown): Span
		}
		/** A copy of `context` with `span` as its active span. */
		setSpan(context: unknown, span: Span): unknown
		/** A copy of `context` whose active span is the remote one `spanContext` describes, so a span started under it joins that trace. */
		setSpanContext(context: unknown, spanContext: OtelSpanContext): unknown
	}
}

/** Options for `otelAdapter`. */
export type OtelAdapterOptions = {
	/** fire-and-forget error reporting: never awaited, never shapes the answer */
	onError?: (report: TelemetryErrorReport) => unknown
	/** continue an inbound `traceparent` from this hop (else it is only linked); default `false` */
	trustInbound?: InboundTrust
}

/** OpenTelemetry's `SpanKind`. */
const KIND: Readonly<Record<SpanOptions["kind"], number>> = { client: 2, internal: 0, server: 1 }

/** W3C caps a tracestate at 32 members. */
const MAX_MEMBERS = 32

/** A W3C tracestate: ordered members, an edited key moved to the front, immutable. */
class TraceState implements OtelTraceState {
	readonly #members: readonly (readonly [string, string])[]

	constructor(members: readonly (readonly [string, string])[]) {
		this.#members = members
	}

	/** From a header `parseTracestate` already validated. */
	static parse(header: string): TraceState {
		return new TraceState(
			header.split(",").map((member) => {
				const eq = member.indexOf("=")
				return [member.slice(0, eq), member.slice(eq + 1)] as const
			}),
		)
	}

	get(key: string): string | undefined {
		return this.#members.find(([k]) => k === key)?.[1]
	}

	set(key: string, value: string): TraceState {
		return new TraceState([[key, value] as const, ...this.#members.filter(([k]) => k !== key)].slice(0, MAX_MEMBERS))
	}

	unset(key: string): TraceState {
		return new TraceState(this.#members.filter(([k]) => k !== key))
	}

	serialize(): string {
		return this.#members.map(([k, v]) => `${k}=${v}`).join(",")
	}
}

function remoteContext(remote: RemoteContext): OtelSpanContext {
	const context = { isRemote: true, spanId: remote.spanId, traceFlags: remote.flags, traceId: remote.traceId }
	return remote.state === undefined ? context : { ...context, traceState: TraceState.parse(remote.state) }
}

function isSpan(parent: RemoteContext | Span): parent is Span {
	return typeof (parent as Partial<Span>).spanContext === "function"
}

/** The `Telemetry` for `app.telemetry()`, built over the OpenTelemetry API module `api`. Its tracer is named `@lovrozagar/honey`. */
export function otelAdapter(api: OtelApi, options: OtelAdapterOptions = {}): Telemetry {
	const otel = api.trace.getTracer("@lovrozagar/honey")
	const tracer: Tracer = {
		run: (span, fn) => api.context.with(api.trace.setSpan(api.context.active(), span), fn),
		startSpan(name, { attributes, kind, links, parent }) {
			/* the parent is explicit: whatever span the ambient context holds is not it */
			const base = api.trace.deleteSpan(api.context.active())
			const context =
				parent === null
					? base
					: isSpan(parent)
						? api.trace.setSpan(base, parent)
						: api.trace.setSpanContext(base, remoteContext(parent))
			const linked = links.map((link) => ({ context: remoteContext(link) }))
			return otel.startSpan(name, { attributes, kind: KIND[kind], links: linked }, context)
		},
	}
	return Object.freeze({
		onError: options.onError ?? null,
		tracer: Object.freeze(tracer),
		trustInbound: options.trustInbound ?? false,
	})
}
