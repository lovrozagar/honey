/**
 * When a request is over (H17, F8): when its answer's body ended, or was cancelled first. A
 * buffered body, a bodiless answer, a HEAD and a 101 are over at once and handed back untouched. A
 * streamed body is read through one pass-through that pulls only when its reader asks, so nothing
 * is read ahead and nothing changes on the wire; it counts the bytes. Dispatch wraps the body once,
 * for the request log and the root span together, and only when one of them is on.
 */
import { isHoneyResponse, type RawBody, rawBodyOf } from "../response/builder.ts"
import type { AppSettings } from "../routing/settings.ts"
import { requestLine, type Seen } from "./request-log.ts"

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
