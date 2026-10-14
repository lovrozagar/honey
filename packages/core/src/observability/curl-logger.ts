/**
 * `curlLogger(options)`: log each request as a `curl` command, redacted, once its answer is known.
 * The line goes to the app's logger (`ctx.log.info`, so it carries the request's bindings and obeys
 * `app.logger(false)` and the level) unless `log` takes it. It is the one opt-in exception to "no
 * request detail in a log line" (H17): header values a credential, cookie or session would be in are
 * masked (`isSensitiveHeader`, the request log's own definition), token-like query parameters too,
 * and the body appears only with `body`, bounded and of a text type.
 *
 * The body is read from a `clone()` taken before the handler runs, so the handler still reads it
 * whole. `skip` runs before any formatting. A failing hook or sink is logged as "curlLogger failed"
 * and never turns the answer into a 500; nothing it starts can reject unobserved.
 */
import { HoneyError } from "../errors/error.ts"
import { type MiddlewareFn, namedMiddleware } from "../middleware/middleware.ts"
import { isSensitiveHeader } from "../telemetry/fields.ts"
import type { Logger } from "../telemetry/logger.ts"
import { shellQuote } from "./request-to-curl.ts"

export type BodyOmittedReason = "content-type" | "disabled" | "missing" | "read-error" | "too-large"

export type CurlLogData = {
	bodyIncluded: boolean
	bodyOmittedReason: BodyOmittedReason | null
	curl: string
	duration: number
	method: string
	path: string
	requestId: string | null
	status: number
}

/** What `skip` sees: everything known before the command is built. */
export type CurlSkipData = Pick<CurlLogData, "duration" | "method" | "path" | "requestId" | "status">

export type CurlLoggerBodyOptions = {
	/** Content types whose body is logged: an entry ending in `/` takes the whole family. */
	allowContentTypes?: readonly string[]
	/** Default 16 KiB; a longer body is left out, read no further than this. */
	maxBytes?: number
}

type Redact = (name: string, value: string) => string | null

export type CurlLoggerOptions = {
	body?: boolean | CurlLoggerBodyOptions
	/** Take each record instead of the app's logger. */
	log?: ((data: CurlLogData) => void) | undefined
	/** The value to log for a header, or `null` to leave it out. Default `defaultRedactHeader`. */
	redactHeader?: Redact
	/** The same for a query parameter. Default `defaultRedactQueryParam`. */
	redactQueryParam?: Redact
	/** Return true to log nothing for this request; runs before any formatting. */
	skip?: (data: CurlSkipData) => boolean
}

const DEFAULT_BODY_TYPES: readonly string[] = /* @__PURE__ */ Object.freeze([
	"application/json",
	"application/x-www-form-urlencoded",
	"application/xml",
	"text/",
])
const DEFAULT_MAX_BODY_BYTES = 16_384
const REDACTED = "[REDACTED]"
const SENSITIVE_PARAM =
	/(?:^|[_.-])(?:access_?token|refresh_?token|id_?token|token|secret|client_?secret|password|passwd|pwd|api_?key|apikey|key|sig|signature|auth|code|session|jwt)$/i

/** The request log's own sensitive headers, masked. */
export function defaultRedactHeader(name: string, value: string): string | null {
	return isSensitiveHeader(name) ? REDACTED : value
}

/** Token-, key-, secret- and password-like query parameters, masked. */
export function defaultRedactQueryParam(name: string, value: string): string | null {
	return SENSITIVE_PARAM.test(name) ? REDACTED : value
}

function essenceOf(contentType: string): string {
	const semi = contentType.indexOf(";")
	return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
}

function typeAllowed(contentType: string | null, allowed: readonly string[]): boolean {
	if (contentType === null) return false
	const essence = essenceOf(contentType)
	/* the top-level type alone, for a family entry such as `text/` */
	const family = essence.slice(0, essence.indexOf("/") + 1)
	return allowed.some((type) => (type.endsWith("/") ? family : essence) === type.toLowerCase())
}

function redactUrl(raw: string, redact: Redact): string {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		/* the answer, not a failure: a URL that does not parse (a malformed Host on Node) is logged without its query */
		return raw.split("?")[0] as string
	}
	if (url.search === "") return url.href
	const params = new URLSearchParams()
	for (const [name, value] of url.searchParams) {
		const kept = redact(name, value)
		if (kept !== null) params.append(name, kept)
	}
	url.search = params.toString()
	return url.href
}

type BodyResult = { readonly body: string | null; readonly omittedReason: BodyOmittedReason | null }

const omitted = (omittedReason: BodyOmittedReason): BodyResult => ({ body: null, omittedReason })

/** Read at most `maxBytes` of `stream`; never rejects. */
async function drain(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BodyResult> {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (total > maxBytes) {
				reader.cancel().catch(() => {
					/* the log copy only: the request's own body is untouched, and the body is omitted below */
				})
				return omitted("too-large")
			}
			chunks.push(value)
		}
	} catch {
		/* the answer, not a failure: a body that cannot be read is logged as omitted */
		return omitted("read-error")
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { body: new TextDecoder().decode(bytes), omittedReason: null }
}

/** Start reading the body to log now, from a clone taken before any handler reads the request. */
function startBodyRead(request: Request, option: CurlLoggerOptions["body"]): Promise<BodyResult> {
	if (option !== true && (typeof option !== "object" || option === null)) return Promise.resolve(omitted("disabled"))
	const { allowContentTypes = DEFAULT_BODY_TYPES, maxBytes = DEFAULT_MAX_BODY_BYTES } = option === true ? {} : option
	if (request.body === null) return Promise.resolve(omitted("missing"))
	if (!typeAllowed(request.headers.get("content-type"), allowContentTypes))
		return Promise.resolve(omitted("content-type"))
	const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10)
	if (declared > maxBytes) return Promise.resolve(omitted("too-large"))
	return drain(request.clone().body as ReadableStream<Uint8Array>, maxBytes)
}

type Redactors = { readonly redactHeader: Redact; readonly redactQueryParam: Redact }

function formatCurl(request: Request, body: BodyResult, redact: Redactors): string {
	const parts = ["curl", "-X", shellQuote(request.method)]
	for (const [name, value] of request.headers) {
		const shown = redact.redactHeader(name, value)
		if (shown !== null) parts.push("-H", shellQuote(`${name}: ${shown}`))
	}
	if (body.body !== null) parts.push("--data-raw", shellQuote(body.body))
	parts.push(shellQuote(redactUrl(request.url, redact.redactQueryParam)))
	return parts.join(" ")
}

function redactorsOf(options: CurlLoggerOptions): Redactors {
	return {
		redactHeader: options.redactHeader ?? defaultRedactHeader,
		redactQueryParam: options.redactQueryParam ?? defaultRedactQueryParam,
	}
}

/** The command and the body's fate for one request, outside the middleware. */
export async function buildCurlLogData(
	request: Request,
	options: Pick<CurlLoggerOptions, "body" | "redactHeader" | "redactQueryParam"> = {},
): Promise<Pick<CurlLogData, "bodyIncluded" | "bodyOmittedReason" | "curl">> {
	const body = await startBodyRead(request, options.body)
	return {
		bodyIncluded: body.body !== null,
		bodyOmittedReason: body.omittedReason,
		curl: formatCurl(request, body, redactorsOf(options)),
	}
}

type CurlCtx = { readonly log: Logger; readonly path: string; readonly req: Request }

export function curlLogger(options: CurlLoggerOptions = {}): MiddlewareFn<CurlCtx> {
	const redact = redactorsOf(options)
	return namedMiddleware("curlLogger", async (ctx, next) => {
		const started = performance.now()
		const request = ctx.req
		/* the only work before next(): the clone must be taken before a handler reads the body */
		const body = startBodyRead(request, options.body)
		const response = await next()
		const seen: CurlSkipData = {
			duration: performance.now() - started,
			method: request.method,
			path: ctx.path,
			requestId: (ctx as { requestId?: string }).requestId ?? null,
			status: response.status,
		}
		try {
			if (options.skip?.(seen)) return response
			const read = await body
			const data: CurlLogData = {
				...seen,
				bodyIncluded: read.body !== null,
				bodyOmittedReason: read.omittedReason,
				curl: formatCurl(request, read, redact),
			}
			if (options.log) options.log(data)
			else ctx.log.info({ ...data }, "request curl")
		} catch (failure) {
			ctx.log.error({ err: HoneyError.serialize(failure) }, "curlLogger failed")
		}
		return response
	})
}
