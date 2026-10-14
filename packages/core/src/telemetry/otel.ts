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
	get(key: string): string | undefined
	serialize(): string
	set(key: string, value: string): OtelTraceState
	unset(key: string): OtelTraceState
}

type OtelSpanContext = {
	readonly isRemote?: boolean
	readonly spanId: string
	readonly traceFlags: number
	readonly traceId: string
	readonly traceState?: OtelTraceState
}

type OtelSpanOptions = {
	readonly attributes?: Attributes
	readonly kind?: number
	readonly links?: { readonly context: OtelSpanContext }[]
}

/** The part of `@opentelemetry/api` the adapter uses: pass the module itself. */
export type OtelApi = {
	readonly context: {
		active(): unknown
		with<T>(context: unknown, fn: () => T): T
	}
	readonly trace: {
		deleteSpan(context: unknown): unknown
		getTracer(name: string): { startSpan(name: string, options?: OtelSpanOptions, context?: unknown): Span }
		setSpan(context: unknown, span: Span): unknown
		setSpanContext(context: unknown, spanContext: OtelSpanContext): unknown
	}
}

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
