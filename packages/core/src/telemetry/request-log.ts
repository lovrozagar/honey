/**
 * The request log (H17, off by default): one `info` line per request after its body ends, from the
 * field catalog only. A buffered body, a bodiless answer, a HEAD and a 101 are logged at once and
 * handed back untouched. A streamed body is read through a pass-through that pulls only when its
 * reader asks, so nothing is read ahead and nothing changes on the wire; it counts the bytes and
 * logs when the body ends, or `"aborted"` when the reader cancels first.
 */
import { isHoneyResponse, type RawBody, rawBodyOf } from "../response/builder.ts"
import type { FetchState } from "../routing/dispatch.ts"
import type { AppSettings } from "../routing/settings.ts"
import { detectRuntime } from "../runtime/detect-runtime.ts"
import { pathOf, type RequestLogEntry } from "./fields.ts"

/** One logged request: what came in, when, and the state routing records so the line can name the route. */
export type Seen = { readonly request: Request; readonly started: number; state: FetchState | null }

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()

function header(response: Response, name: string): string | undefined {
	if (!isHoneyResponse(response)) return response.headers.get(name) ?? undefined
	const value = response.plainHeaders[name]
	return value === undefined ? undefined : String(value)
}

function byteLength(raw: RawBody): number {
	return typeof raw === "string" ? encoder.encode(raw).byteLength : raw.byteLength
}

/** A media type's essence: `type/subtype`, lowercased, without parameters. */
function essenceOf(value: string | undefined): string {
	const text = value ?? ""
	const semi = text.indexOf(";")
	return (semi === -1 ? text : text.slice(0, semi)).trim().toLowerCase()
}

function kindOf(response: Response, raw: RawBody | null): string {
	if (response.status === 101) return "upgrade"
	const essence = essenceOf(header(response, "content-type"))
	if (essence === "text/event-stream") return "sse"
	if (raw === null) return response.body === null ? "empty" : "stream"
	if (essence === "application/json" || essence.endsWith("+json")) return "json"
	return essence.slice(0, essence.indexOf("/")) === "text" ? "text" : "binary"
}

/** The runtime `globals` belong to, or `unknown` for one serve() does not know. */
export function runtimeOf(globals: Parameters<typeof detectRuntime>[0] = globalThis): string {
	try {
		return detectRuntime(globals)
	} catch {
		/* not a runtime serve() knows: the line says so instead of failing the request */
		return "unknown"
	}
}

/** Write the line, unless `skip` says not to; a `skip` that throws is logged and the line still written. */
function write(s: AppSettings<unknown>, entry: RequestLogEntry): void {
	const skip = s.requestLog?.skip
	let skipped = false
	if (skip !== undefined) {
		try {
			skipped = skip(entry)
		} catch (error) {
			s.logger.error({ err: error }, "requestLog skip failed")
		}
	}
	if (!skipped) s.logger.info(entry as unknown as Record<string, unknown>, "request")
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
				let chunk: ReadableStreamReadResult<Uint8Array>
				try {
					chunk = await reader.read()
				} catch (error) {
					/* the body broke: the client got a cut stream, which the line records as aborted */
					settle(false)
					throw error
				}
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

/** Log the request `response` answers, after its body ends; what goes out is never changed. */
export function logRequest(s: AppSettings<unknown>, seen: Seen, response: Response): Response {
	const { request, started } = seen
	const raw = rawBodyOf(response)
	const entry: Mutable<RequestLogEntry> = {
		durationMs: 0,
		kind: kindOf(response, raw),
		method: request.method,
		path: pathOf(request.url),
		routeId: seen.state?.plan.route.id ?? "",
		runtime: runtimeOf(),
		status: response.status,
	}
	const requestId = header(response, "x-request-id")
	if (requestId !== undefined) entry.requestId = requestId
	const finish = (status: number | "aborted", bytes: number | undefined): void => {
		entry.durationMs = Math.round((performance.now() - started) * 1000) / 1000
		entry.status = status
		if (bytes !== undefined) entry.bytes = bytes
		write(s, entry)
	}
	const body = raw === null && response.status !== 101 && request.method !== "HEAD" ? response.body : null
	if (body === null) {
		finish(response.status, raw === null || request.method === "HEAD" ? undefined : byteLength(raw))
		return response
	}
	const stream = counted(body, (ended, bytes) => finish(ended ? response.status : "aborted", bytes))
	if (isHoneyResponse(response)) return response.derive({ stream }) as unknown as Response
	return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText })
}
