/**
 * The core tracing seam (H17, G1). With `app.telemetry(value)` set, each request gets a SERVER root
 * span started before routing and renamed `{method} {route}` once routed, its parent the inbound
 * trace when the hop is trusted (else only linked). Every middleware and the handler run in an
 * onion of child spans under it: the parent is the span the request is in now (`current`, saved and
 * restored around each), passed explicitly, never through an ambient context, so it holds on
 * Workers. An error that surfaced gets an `http.error` span under the span it came from (the
 * boundary records it, errors/on-error.ts). Spans carry no message, stack, query or input.
 * A tracer that throws is a warn and never touches the answer; a root that does not record builds
 * nothing below it.
 */
import type { RouteInfo } from "../context/context.ts"
import { HoneyError } from "../errors/error.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import type { InboundTrust } from "../middleware/request-id.ts"
import type { AppSettings } from "../routing/settings.ts"
import { formatTraceparent, type RemoteContext, type TraceIds } from "./traceparent.ts"

export type AttributeValue = boolean | number | string
export type Attributes = Readonly<Record<string, AttributeValue>>

/** A span as honey uses one: the part of an OpenTelemetry span it calls, so an OTel span is one as it is. */
export type Span = {
	addEvent(name: string, attributes?: Attributes): unknown
	end(): void
	isRecording(): boolean
	setAttribute(key: string, value: AttributeValue): unknown
	setStatus(status: { code: number; message?: string }): unknown
	spanContext(): { readonly spanId: string; readonly traceFlags: number; readonly traceId: string }
	updateName(name: string): unknown
}

export type SpanOptions = {
	readonly attributes: Attributes
	readonly kind: "client" | "internal" | "server"
	readonly links: readonly RemoteContext[]
	/** explicit: the span it runs under, a remote one, or `null` for a new trace */
	readonly parent: RemoteContext | Span | null
}

export type Tracer = {
	startSpan(name: string, options: SpanOptions): Span
	/** run `fn` with `span` as the ambient active span, so the app's own instrumentation nests under it */
	run?<T>(span: Span, fn: () => T): T
}

/** What `telemetry.onError` hears about a thrown error, once its answer is decided. */
export type TelemetryErrorReport = {
	/** the unknown 5xx's digest, as the client and the operator line have it */
	readonly digest?: string
	readonly durationMs: number
	/** what was thrown */
	readonly error: unknown
	/** what it answered as */
	readonly honeyError: HoneyError
	readonly method: string
	/** without the query */
	readonly path: string
	readonly routeId: string
	readonly spanId?: string
	readonly traceId?: string
}

/** What `app.telemetry(value)` carries: `otelAdapter(api, options)` builds one. */
export type Telemetry = {
	/** fire-and-forget error reporting: never awaited, never shapes the answer */
	readonly onError: ((report: TelemetryErrorReport) => unknown) | null
	readonly tracer: Tracer
	/** whether an inbound `traceparent` is continued (else only linked); default `false` */
	readonly trustInbound: InboundTrust
}

/** OpenTelemetry's `SpanStatusCode.ERROR`. */
const ERROR = 2
export const NO_LINKS: readonly RemoteContext[] = /* @__PURE__ */ Object.freeze([])

/** What was thrown, by its class alone: never its message. */
function typeOf(thrown: unknown): string {
	return thrown instanceof Error ? thrown.constructor.name || thrown.name : typeof thrown
}

/** An outbound call's trace: the headers that carry it, and its span's end. */
export type Outbound = {
	/** `null` when the request has no trace ids to pass on */
	readonly traceparent: string | null
	/** the tracestate of a trace continued from a trusted hop */
	readonly tracestate: string | undefined
	/** make the call inside the span, ending it with the answer's status or the failure */
	send(call: () => Promise<Response> | Response): Promise<Response>
}

/** A span's ids, or `null` for the all-zero ids of one that has none. */
function idsOf(span: Span): TraceIds | null {
	const { spanId, traceFlags, traceId } = span.spanContext()
	return /^0+$/.test(traceId) ? null : { flags: traceFlags, spanId, traceId }
}

/** One request's spans: the root, and where in the onion the request is now. */
export class RequestTrace {
	readonly #s: AppSettings<unknown>
	readonly #tracer: Tracer
	/** the span the request is in now: what the next span runs under */
	#current: Span
	/** the span an error last left, until its http.error is recorded */
	#failed: Span | null = null
	readonly recording: boolean
	readonly root: Span
	readonly started: number
	/** the tracestate of a trace continued from a trusted hop */
	readonly #state: string | undefined

	/** `started` is when the request came in; `state` the tracestate of a continued trace */
	constructor(
		s: AppSettings<unknown>,
		tracer: Tracer,
		root: Span,
		{ started, state }: { readonly started: number; readonly state: string | undefined },
	) {
		this.#s = s
		this.#tracer = tracer
		this.root = root
		this.#current = root
		this.started = started
		this.#state = state
		this.recording = this.#safe(() => root.isRecording(), false)
	}

	/** Call the tracer; when it throws, warn and go on without it. */
	#safe<T>(call: () => T, fallback: T): T {
		try {
			return call()
		} catch (error) {
			this.#s.logger.warn({ err: HoneyError.serialize(error) }, "telemetry failed")
			return fallback
		}
	}

	/** The root's trace and span ids, or `null` when it has none. */
	ids(): { spanId: string; traceId: string } | null {
		const ids = this.#safe(() => idsOf(this.root), null)
		return ids === null ? null : { spanId: ids.spanId, traceId: ids.traceId }
	}

	/** An attribute on the root (`honey.request_id`), when it records. */
	annotate(key: string, value: AttributeValue): void {
		if (this.recording) this.#safe(() => this.root.setAttribute(key, value), undefined)
	}

	/**
	 * A CLIENT span for an outbound call under the current span, and the headers that carry it on.
	 * A root that does not record starts none and passes its own ids on, so the next hop drops too.
	 */
	outbound(name: string, method: string): Outbound {
		const parent = this.#current
		const options: SpanOptions = {
			attributes: { "http.request.method": method },
			kind: "client",
			links: NO_LINKS,
			parent,
		}
		const span = this.recording ? this.#safe(() => this.#tracer.startSpan(name, options), null) : null
		const ids = this.#safe(() => idsOf(span ?? this.root), null)
		const settle = (status: number | null, thrown: unknown) =>
			this.#safe(() => {
				if (span === null) return
				if (status === null) {
					span.setStatus({ code: ERROR })
					span.setAttribute("exception.type", typeOf(thrown))
				} else span.setAttribute("http.response.status_code", status)
				span.end()
			}, undefined)
		return {
			async send(call) {
				let response: Response
				try {
					response = await call()
				} catch (thrown) {
					settle(null, thrown)
					throw thrown
				}
				settle(response.status, undefined)
				return response
			},
			traceparent: ids === null ? null : formatTraceparent(ids),
			tracestate: this.#state,
		}
	}

	/** Name the root after the route it runs; a request no route serves keeps the method alone. */
	routed(route: RouteInfo, method: string): void {
		if (!this.recording || route.id === "") return
		this.#safe(() => {
			this.root.updateName(`${method} ${route.pattern}`)
			this.root.setAttribute("http.route", route.pattern)
			this.root.setAttribute("honey.route_id", route.id)
		}, undefined)
	}

	event(name: string, attributes?: Attributes): void {
		if (this.recording) this.#safe(() => this.root.addEvent(name, attributes), undefined)
	}

	/** Run `fn` inside a new span under the current one, which ends when `fn` settles. */
	within(name: string, fn: (span: Span | null) => MaybePromise<Response>): MaybePromise<Response> {
		if (!this.recording) return fn(null)
		const parent = this.#current
		const span = this.#safe(
			() => this.#tracer.startSpan(name, { attributes: {}, kind: "internal", links: NO_LINKS, parent }),
			null,
		)
		if (span === null) return fn(null)
		this.#current = span
		let out: MaybePromise<Response>
		try {
			out = fn(span)
		} catch (thrown) {
			this.#close(span, parent, true, thrown)
			throw thrown
		}
		if (!(out instanceof Promise)) {
			this.#close(span, parent, false, undefined)
			return out
		}
		return out.then(
			(res) => {
				this.#close(span, parent, false, undefined)
				return res
			},
			(thrown: unknown) => {
				this.#close(span, parent, true, thrown)
				throw thrown
			},
		)
	}

	#close(span: Span, parent: Span, failed: boolean, thrown: unknown): void {
		this.#current = parent
		this.#safe(() => {
			if (failed) {
				this.#failed = span
				span.setStatus({ code: ERROR })
				span.setAttribute("exception.type", typeOf(thrown))
			}
			span.end()
		}, undefined)
	}

	/** `fn` with `span` active for the app's own instrumentation, when the tracer can do that. */
	run(span: Span | null, fn: () => MaybePromise<Response>): MaybePromise<Response> {
		const tracer = this.#tracer
		return span === null || tracer.run === undefined ? fn() : tracer.run(span, fn)
	}

	/** An `http.error` span under the span the error left, ended at once. */
	error(error: HoneyError, thrown: unknown, digest: string | undefined): void {
		if (!this.recording) return
		const parent = this.#failed ?? this.#current
		this.#failed = null
		const attributes: Record<string, AttributeValue> = {
			"exception.type": typeOf(thrown),
			"honey.error_key": error.errorKey,
			"http.response.status_code": error.status,
		}
		if (digest !== undefined) attributes["honey.digest"] = digest
		this.#safe(
			() => this.#tracer.startSpan("http.error", { attributes, kind: "internal", links: NO_LINKS, parent }).end(),
			undefined,
		)
	}

	/** End the root once the answer's body ended (`ended`) or was cancelled. */
	end(status: number, ended: boolean, bytes: number | undefined): void {
		this.#safe(() => {
			if (this.recording) {
				this.root.setAttribute("http.response.status_code", status)
				if (bytes !== undefined) this.root.setAttribute("http.response.body.size", bytes)
				if (!ended) this.root.setAttribute("honey.outcome", "aborted")
				if (status >= 500) this.root.setStatus({ code: ERROR })
			}
			this.root.end()
		}, undefined)
	}

	/** The request itself threw (no answer at all): the root ends failed. */
	fail(thrown: unknown): void {
		this.#safe(() => {
			if (this.recording) {
				this.root.setStatus({ code: ERROR })
				this.root.setAttribute("exception.type", typeOf(thrown))
			}
			this.root.end()
		}, undefined)
	}
}
