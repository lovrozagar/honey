import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"
import type { LoggerInstance } from "./logger.ts"
import { shellQuote } from "./request-to-curl.ts"

type BodyOmittedReason = "content-type" | "disabled" | "missing" | "read-error" | "too-large"

type CurlLogData = {
	bodyIncluded: boolean
	bodyOmittedReason: BodyOmittedReason | null
	curl: string
	duration: number
	method: string
	path: string
	requestId: string | null
	status: number
}

/** What `skip` sees: everything known before the curl command is built. */
type CurlSkipData = Pick<CurlLogData, "duration" | "method" | "path" | "requestId" | "status">

type CurlLoggerBodyOptions = {
	allowContentTypes?: string[]
	maxBytes?: number
}

type CurlLoggerOptions = {
	body?: boolean | CurlLoggerBodyOptions
	instance?: LoggerInstance
	log?: (data: CurlLogData) => void
	/**
	 * Return the value to log, or null to drop the header. Replaces the default,
	 * which masks `authorization`, `proxy-authorization`, `cookie`, `set-cookie`
	 * and API-key/token headers. Call `defaultRedactHeader` to keep it and add more.
	 */
	redactHeader?: (name: string, value: string) => string | null
	/** Same for query parameters. The default masks token-, key-, secret- and password-like names. */
	redactQueryParam?: (name: string, value: string) => string | null
	/** Runs before the curl command is built; returning true skips all of that work. */
	skip?: (data: CurlSkipData) => boolean
}

const DEFAULT_BODY_CONTENT_TYPES = ["application/json", "application/x-www-form-urlencoded", "application/xml", "text/"]

const DEFAULT_MAX_BODY_BYTES = 16_384

const REDACTED = "[REDACTED]"

const SENSITIVE_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"x-csrf-token",
	"x-xsrf-token",
])
const SENSITIVE_HEADER_RE = /(?:^|-)(?:token|secret|api-?key|password|session)(?:$|-)/i
const SENSITIVE_PARAM_RE =
	/(?:^|[_.-])(?:access_?token|refresh_?token|id_?token|token|secret|client_?secret|password|passwd|pwd|api_?key|apikey|key|sig|signature|auth|code|session|jwt)$/i

function defaultRedactHeader(name: string, value: string): string | null {
	const lower = name.toLowerCase()
	if (SENSITIVE_HEADERS.has(lower) || SENSITIVE_HEADER_RE.test(lower)) return REDACTED
	return value
}

function defaultRedactQueryParam(name: string, value: string): string | null {
	return SENSITIVE_PARAM_RE.test(name) ? REDACTED : value
}

function defaultLog(data: CurlLogData): void {
	console.log(data.curl)
}

function shouldIncludeBody(contentType: string | null, allowContentTypes: string[]): boolean {
	if (contentType === null || contentType.length === 0) return false
	const lower = contentType.toLowerCase()
	return allowContentTypes.some((allowed) => lower.startsWith(allowed.toLowerCase()))
}

function redactUrl(rawUrl: string, redactQueryParam: (name: string, value: string) => string | null): string {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		/* a malformed Host (Node builds the URL from it) must not fail the request */
		return rawUrl.split("?")[0] ?? rawUrl
	}
	if (url.search.length === 0) return url.toString()
	const params = new URLSearchParams()
	for (const [name, value] of url.searchParams) {
		const nextValue = redactQueryParam(name, value)
		if (nextValue !== null) params.append(name, nextValue)
	}
	url.search = params.toString()
	return url.toString()
}

type BodyResult = { body: string | null; omittedReason: BodyOmittedReason | null }

/**
 * A second, independent reader of the request body. On Node the request is
 * re-pointed at one branch of a tee (the same hook `bodyLimit` uses) rather
 * than `clone()`d, so later body readers keep working.
 */
function teeBody(request: Request): ReadableStream<Uint8Array> | null {
	const body = request.body
	if (body === null) return null
	const replaceBody = (request as unknown as Record<symbol, unknown>)[Symbol.for("honey.replaceBody")]
	if (typeof replaceBody === "function") {
		const [forRequest, forLog] = body.tee()
		;(replaceBody as (stream: ReadableStream<Uint8Array>) => void).call(request, forRequest)
		return forLog
	}
	return request.clone().body
}

/** Never rejects: a body that cannot be read is logged as omitted. */
async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<BodyResult> {
	try {
		if (request.body === null) return { body: null, omittedReason: "missing" }

		const contentLength = request.headers.get("content-length")
		if (contentLength !== null) {
			const parsedLength = Number.parseInt(contentLength, 10)
			if (!Number.isNaN(parsedLength) && parsedLength > maxBytes) {
				return { body: null, omittedReason: "too-large" }
			}
		}

		const stream = teeBody(request)
		if (stream === null) return { body: null, omittedReason: "missing" }

		const reader = stream.getReader()
		const chunks: Uint8Array[] = []
		let totalBytes = 0
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			totalBytes += value.byteLength
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => {})
				return { body: null, omittedReason: "too-large" }
			}
			chunks.push(value)
		}

		const bytes = new Uint8Array(totalBytes)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return { body: new TextDecoder().decode(bytes), omittedReason: null }
	} catch {
		return { body: null, omittedReason: "read-error" }
	}
}

type ResolvedOptions = {
	redactHeader: (name: string, value: string) => string | null
	redactQueryParam: (name: string, value: string) => string | null
}

function formatCurl(request: Request, body: BodyResult | null, opts: ResolvedOptions): string {
	const parts: string[] = ["curl", "-X", shellQuote(request.method)]
	for (const [name, value] of request.headers.entries()) {
		const redactedValue = opts.redactHeader(name, value)
		if (redactedValue === null) continue
		parts.push("-H", shellQuote(`${name}: ${redactedValue}`))
	}
	if (body !== null && body.body !== null) parts.push("--data-raw", shellQuote(body.body))
	parts.push(shellQuote(redactUrl(request.url, opts.redactQueryParam)))
	return parts.join(" ")
}

/** Start reading the body (if logged) now, before a handler consumes it. */
function startBodyRead(request: Request, body: CurlLoggerOptions["body"]): Promise<BodyResult> {
	if (body !== true && typeof body !== "object") {
		return Promise.resolve({ body: null, omittedReason: "disabled" })
	}
	const bodyOptions = typeof body === "object" ? body : {}
	const allowContentTypes = bodyOptions.allowContentTypes ?? DEFAULT_BODY_CONTENT_TYPES
	if (!shouldIncludeBody(request.headers.get("content-type"), allowContentTypes)) {
		return Promise.resolve({ body: null, omittedReason: request.body === null ? "missing" : "content-type" })
	}
	return readBodyWithinLimit(request, bodyOptions.maxBytes ?? DEFAULT_MAX_BODY_BYTES)
}

async function buildCurlLogData(
	request: Request,
	options?: Pick<CurlLoggerOptions, "body" | "redactHeader" | "redactQueryParam">,
): Promise<Pick<CurlLogData, "bodyIncluded" | "bodyOmittedReason" | "curl">> {
	const resolved: ResolvedOptions = {
		redactHeader: options?.redactHeader ?? defaultRedactHeader,
		redactQueryParam: options?.redactQueryParam ?? defaultRedactQueryParam,
	}
	const body = await startBodyRead(request, options?.body)
	return {
		bodyIncluded: body.body !== null,
		bodyOmittedReason: body.omittedReason,
		curl: formatCurl(request, body, resolved),
	}
}

function curlLogger(options?: CurlLoggerOptions): MiddlewareFn<{ path: string; req: Request }, {}> {
	const log = options?.log ?? defaultLog
	const skip = options?.skip
	const resolved: ResolvedOptions = {
		redactHeader: options?.redactHeader ?? defaultRedactHeader,
		redactQueryParam: options?.redactQueryParam ?? defaultRedactQueryParam,
	}

	return namedMiddleware("curlLogger", async (ctx, next) => {
		const start = performance.now()
		const request = ctx.req
		const method = request.method
		const path = ctx.path
		const rid = ((ctx as Record<string, unknown>)["requestId"] as string | null) ?? null
		/* the only work before `next()`: the body must be teed before a handler reads it */
		const bodyPromise = startBodyRead(request, options?.body)

		const response = await next()
		const skipData: CurlSkipData = {
			duration: performance.now() - start,
			method,
			path,
			requestId: rid,
			status: response.status,
		}

		/* a failing redact callback, skip or sink never turns the response into a 500 */
		try {
			if (skip?.(skipData)) return response
			const body = await bodyPromise
			const data: CurlLogData = {
				...skipData,
				bodyIncluded: body.body !== null,
				bodyOmittedReason: body.omittedReason,
				curl: formatCurl(request, body, resolved),
			}
			if (options?.instance) {
				options.instance.info({ ...data }, "request curl")
			} else {
				log(data)
			}
		} catch (err) {
			console.error("curlLogger: failed to log request", err)
		}

		return response
	})
}

export { buildCurlLogData, curlLogger, defaultRedactHeader, defaultRedactQueryParam }
export type { BodyOmittedReason, CurlLogData, CurlLoggerBodyOptions, CurlLoggerOptions, CurlSkipData }
