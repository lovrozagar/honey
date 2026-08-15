import type { HoneyError } from "../error.ts"

type Span = {
	addEvent(name: string, attributes?: Record<string, unknown>): void
	end(): void
	setAttribute(key: string, value: unknown): void
}

type Tracer = {
	startSpan(name: string): Span
}

type TelemetryAdapter = {
	onError?(ctx: { duration: number; error: HoneyError; method: string; path: string }): void
	onHandler?(ctx: { duration: number; method: string; path: string; status: number }): void
	onMethodNotAllowed?(ctx: { allowed: string[]; method: string; path: string; req: Request }): void
	onMiddleware?(ctx: { duration: number; error?: unknown; name: string }): void
	onNotFound?(ctx: { method: string; path: string; req: Request }): void
	onRequest?(ctx: { env: unknown; req: Request }): void
	onResponse?(ctx: { duration: number; req: Request; status: number }): void
	onRoute?(ctx: { method: string; params: Record<string, string>; path: string; req: Request }): void
}

export function otelAdapter(options: { tracer: Tracer }): TelemetryAdapter {
	const spans = new WeakMap<Request, Span>()

	return {
		onError(ctx) {
			try {
				/*
				 * onError doesn't receive req — error details are best captured
				 * via a standalone span. Per-request root span is in onResponse.
				 */
				const span = options.tracer.startSpan("http.error")
				span.setAttribute("error.key", ctx.error.errorKey)
				span.setAttribute("error.status", ctx.error.status)
				span.setAttribute("http.duration_ms", ctx.duration)
				span.end()
			} catch {
				/* swallow */
			}
		},

		onHandler(ctx) {
			try {
				const span = options.tracer.startSpan("http.handler")
				span.setAttribute("http.method", ctx.method)
				span.setAttribute("http.route", ctx.path)
				span.setAttribute("http.status_code", ctx.status)
				span.setAttribute("http.duration_ms", ctx.duration)
				span.end()
			} catch {
				/* swallow */
			}
		},

		onMethodNotAllowed(ctx) {
			try {
				const span = spans.get(ctx.req)
				if (span) {
					span.addEvent("method_not_allowed", {
						"http.allowed_methods": ctx.allowed.join(", "),
						"http.method": ctx.method,
						"http.route": ctx.path,
					})
				}
			} catch {
				/* swallow */
			}
		},

		onMiddleware(ctx) {
			try {
				const span = options.tracer.startSpan(`middleware.${ctx.name}`)
				span.setAttribute("middleware.name", ctx.name)
				span.setAttribute("middleware.duration_ms", ctx.duration)
				if (ctx.error) span.addEvent("error")
				span.end()
			} catch {
				/* swallow */
			}
		},

		onNotFound(ctx) {
			try {
				const span = spans.get(ctx.req)
				if (span) {
					span.addEvent("not_found", {
						"http.method": ctx.method,
						"http.path": ctx.path,
					})
				}
			} catch {
				/* swallow */
			}
		},

		onRequest(ctx) {
			try {
				const span = options.tracer.startSpan("http.request")
				span.setAttribute("http.url", ctx.req.url)
				spans.set(ctx.req, span)
			} catch {
				/* swallow */
			}
		},

		onResponse(ctx) {
			try {
				const span = spans.get(ctx.req)
				if (span) {
					span.setAttribute("http.status_code", ctx.status)
					span.setAttribute("http.duration_ms", ctx.duration)
					span.end()
					spans.delete(ctx.req)
				}
			} catch {
				/* swallow */
			}
		},

		onRoute(ctx) {
			try {
				const span = spans.get(ctx.req)
				if (span) {
					span.setAttribute("http.method", ctx.method)
					span.setAttribute("http.route", ctx.path)
				}
			} catch {
				/* swallow */
			}
		},
	}
}
