/**
 * The request log (H17, off by default): one `info` line per request after its body ends, from the
 * field catalog only, or `"aborted"` when the reader cancels first. The body observer
 * (span-lifecycle.ts) calls the line when the body ended.
 */
import { isHoneyResponse, type RawBody, rawBodyOf } from "../response/builder.ts"
import type { FetchState } from "../routing/dispatch.ts"
import type { AppSettings } from "../routing/settings.ts"
import { detectRuntime } from "../runtime/detect-runtime.ts"
import { pathOf, type RequestLogEntry } from "./fields.ts"
import type { RequestTrace } from "./request-trace.ts"
import type { BodyEnd } from "./span-lifecycle.ts"

/**
 * One observed request: what came in, when, the state routing records so the line can name the
 * route, and its spans when the app has telemetry.
 */
export type Seen = {
	readonly request: Request
	readonly started: number
	state: FetchState | null
	readonly trace: RequestTrace | undefined
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function header(response: Response, name: string): string | undefined {
	if (!isHoneyResponse(response)) return response.headers.get(name) ?? undefined
	const value = response.plainHeaders[name]
	return value === undefined ? undefined : String(value)
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

/**
 * The request log's line for the request `response` answers: what the body observer calls once the
 * body ended (`ended`) or was cancelled, with the bytes it carried.
 */
export function requestLine(s: AppSettings<unknown>, seen: Seen, response: Response): BodyEnd {
	const { request, started } = seen
	const entry: Mutable<RequestLogEntry> = {
		durationMs: 0,
		kind: kindOf(response, rawBodyOf(response)),
		method: request.method,
		path: pathOf(request.url),
		routeId: seen.state?.plan.route.id ?? "",
		runtime: runtimeOf(),
		status: response.status,
	}
	const requestId = header(response, "x-request-id")
	if (requestId !== undefined) entry.requestId = requestId
	return (ended, bytes) => {
		entry.durationMs = Math.round((performance.now() - started) * 1000) / 1000
		entry.status = ended ? response.status : "aborted"
		if (bytes !== undefined) entry.bytes = bytes
		write(s, entry)
	}
}
