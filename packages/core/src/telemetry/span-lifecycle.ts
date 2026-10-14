/**
 * A request's root span from start to end (H17, F8). It starts before routing, under or linked to
 * the inbound trace as the hop is trusted. The request is over when its answer's body ended, or
 * was cancelled first. A
 * buffered body, a bodiless answer, a HEAD and a 101 are over at once and handed back untouched. A
 * streamed body is read through one pass-through that pulls only when its reader asks, so nothing
 * is read ahead and nothing changes on the wire; it counts the bytes. Dispatch wraps the body once,
 * for the request log and the root span together, and only when one of them is on.
 */
import { ipOf, type PeerSource } from "../context/peer.ts"
import { HoneyError } from "../errors/error.ts"
import { isHoneyResponse, type RawBody, rawBodyOf } from "../response/builder.ts"
import type { AppSettings } from "../routing/settings.ts"
import { pathOf } from "./fields.ts"
import { requestLine, type Seen } from "./request-log.ts"
import { NO_LINKS, RequestTrace, type Span, type SpanOptions, type Telemetry } from "./request-trace.ts"
import { inboundTrace } from "./traceparent.ts"

const nothing = (): undefined => undefined

/** The root of a request whose tracer failed to start one: records nothing. */
const UNRECORDED: Span = /* @__PURE__ */ Object.freeze({
	addEvent: nothing,
	end: nothing,
	isRecording: () => false,
	setAttribute: nothing,
	setStatus: nothing,
	spanContext: () => ({ spanId: "0000000000000000", traceFlags: 0, traceId: "00000000000000000000000000000000" }),
	updateName: nothing,
})

/** The root span of `request`, under or linked to its inbound trace as the hop is trusted. */
export function startTrace(
	s: AppSettings<unknown>,
	telemetry: Telemetry,
	request: Request,
	env: unknown,
): RequestTrace {
	const started = performance.now()
	const peer: PeerSource = { env, req: request }
	const source = {
		get ip() {
			return ipOf(peer)
		},
		req: request,
	}
	const inbound = inboundTrace(source, telemetry.trustInbound, (error) =>
		s.logger.warn({ err: HoneyError.serialize(error) }, "telemetry trust check failed"),
	)
	const options: SpanOptions = {
		attributes: { "http.request.method": request.method, "url.path": pathOf(request.url) },
		kind: "server",
		links: inbound === null || inbound.continued ? NO_LINKS : [inbound.remote],
		parent: inbound?.continued === true ? inbound.remote : null,
	}
	let root = UNRECORDED
	try {
		root = telemetry.tracer.startSpan(request.method, options)
	} catch (error) {
		s.logger.warn({ err: HoneyError.serialize(error) }, "telemetry failed")
	}
	const state = inbound?.continued === true ? inbound.remote.state : undefined
	return new RequestTrace(s, telemetry.tracer, root, { started, state })
}

/** How a body ended: `ended` when it was read to its end (else cancelled or broken), and its bytes. */
export type BodyEnd = (ended: boolean, bytes: number | undefined) => void

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()

function byteLength(raw: RawBody): number {
	return typeof raw === "string" ? encoder.encode(raw).byteLength : raw.byteLength
}

/** `body` read only on its reader's demand, its bytes counted; `done` hears once how it ended. */
function counted(
	body: ReadableStream<Uint8Array>,
	done: (ended: boolean, bytes: number) => void,
): ReadableStream<Uint8Array> {
	const reader = body.getReader()
	let bytes = 0
	let settled = false
	const settle = (ended: boolean): void => {
		if (settled) return
		settled = true
		done(ended, bytes)
	}
	return new ReadableStream<Uint8Array>(
		{
			cancel(reason) {
				settle(false)
				return reader.cancel(reason)
			},
			async pull(controller) {
				const chunk = await reader.read().catch((error: unknown) => {
					/* the body broke: the client got a cut stream, which the line records as aborted */
					settle(false)
					throw error
				})
				if (chunk.done) {
					/* before close(): a cancel racing the end has already settled it as aborted */
					settle(true)
					controller.close()
					return
				}
				bytes += chunk.value.byteLength
				controller.enqueue(chunk.value)
			},
		},
		{ highWaterMark: 0 },
	)
}

/** `response`, its body observed: `done` hears once how it ended, at once when it is not a stream. */
export function observed(request: Request, response: Response, done: BodyEnd): Response {
	const raw = rawBodyOf(response)
	const body = raw === null && response.status !== 101 && request.method !== "HEAD" ? response.body : null
	if (body === null) {
		done(true, raw === null || request.method === "HEAD" ? undefined : byteLength(raw))
		return response
	}
	const stream = counted(body, done)
	if (isHoneyResponse(response)) return response.derive({ stream }) as unknown as Response
	return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText })
}

/** The answer to `seen`, observed for the request log and the root span, whichever are on. */
export function observe(s: AppSettings<unknown>, seen: Seen, response: Response): Response {
	const line = s.requestLog === null ? null : requestLine(s, seen, response)
	const trace = seen.trace
	return observed(seen.request, response, (ended, bytes) => {
		line?.(ended, bytes)
		trace?.end(response.status, ended, bytes)
	})
}
