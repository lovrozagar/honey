import type { MiddlewareFn } from "./middleware.ts"
import type { LoggerInstance } from "./logger.ts"

type BodyOmittedReason =
	| "content-type"
	| "disabled"
	| "missing"
	| "read-error"
	| "too-large"

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

type CurlLoggerBodyOptions = {
	allowContentTypes?: string[]
	maxBytes?: number
}

type CurlLoggerOptions = {
	body?: boolean | CurlLoggerBodyOptions
	instance?: LoggerInstance
	log?: (data: CurlLogData) => void
	redactHeader?: (name: string, value: string) => string | null
	redactQueryParam?: (name: string, value: string) => string | null
	skip?: (data: CurlLogData) => boolean
}

const DEFAULT_BODY_CONTENT_TYPES = [
	"application/json",
	"application/x-www-form-urlencoded",
	"application/xml",
	"text/",
]

const DEFAULT_MAX_BODY_BYTES = 16_384

function shellEscape(value: string): string {
	return value.replace(/'/g, "'\\''")
}

function defaultLog(data: CurlLogData): void {
	console.log(data.curl)
}

function shouldIncludeBody(contentType: string | null, allowContentTypes: string[]): boolean {
	if (contentType === null || contentType.length === 0) return false
	return allowContentTypes.some((allowed) => contentType.startsWith(allowed))
}

function redactUrl(url: URL, redactQueryParam?: (name: string, value: string) => string | null): string {
	if (redactQueryParam === undefined || url.search.length === 0) return url.toString()

	const redacted = new URL(url.toString())
	redacted.search = ""

	for (const [name, value] of url.searchParams.entries()) {
		const nextValue = redactQueryParam(name, value)
		if (nextValue === null) continue
		redacted.searchParams.append(name, nextValue)
	}

	return redacted.toString()
}

async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<{
	body: string | null
	omittedReason: BodyOmittedReason | null
}> {
	if (request.body === null) {
		return { body: null, omittedReason: "missing" }
	}

	const contentLength = request.headers.get("content-length")
	if (contentLength !== null) {
		const parsedLength = Number.parseInt(contentLength, 10)
		if (!Number.isNaN(parsedLength) && parsedLength > maxBytes) {
			return { body: null, omittedReason: "too-large" }
		}
	}

	const clone = request.clone()
	if (clone.body === null) {
		return { body: null, omittedReason: "missing" }
	}

	const reader = clone.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			totalBytes += value.byteLength
			if (totalBytes > maxBytes) {
				await reader.cancel()
				return { body: null, omittedReason: "too-large" }
			}
			chunks.push(value)
		}
	} catch {
		return { body: null, omittedReason: "read-error" }
	}

	const bytes = new Uint8Array(totalBytes)
	let offset = 0

	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}

	return {
		body: new TextDecoder().decode(bytes),
		omittedReason: null,
	}
}

async function buildCurlLogData(
	request: Request,
	options?: Pick<CurlLoggerOptions, "body" | "redactHeader" | "redactQueryParam">,
): Promise<Pick<CurlLogData, "bodyIncluded" | "bodyOmittedReason" | "curl">> {
	const parts: string[] = [`curl -X ${request.method}`]

	for (const [name, value] of request.headers.entries()) {
		const redactedValue = options?.redactHeader !== undefined
			? options.redactHeader(name, value)
			: value
		if (redactedValue === null) continue
		parts.push(`-H '${shellEscape(name)}: ${shellEscape(redactedValue)}'`)
	}

	let bodyIncluded = false
	let bodyOmittedReason: BodyOmittedReason | null = null

	if (options?.body === true || typeof options?.body === "object") {
		const bodyOptions = typeof options.body === "object" ? options.body : {}
		const allowContentTypes = bodyOptions.allowContentTypes ?? DEFAULT_BODY_CONTENT_TYPES
		const contentType = request.headers.get("content-type")

		if (shouldIncludeBody(contentType, allowContentTypes) === false) {
			bodyOmittedReason = request.body === null ? "missing" : "content-type"
		} else {
			const result = await readBodyWithinLimit(
				request,
				bodyOptions.maxBytes ?? DEFAULT_MAX_BODY_BYTES,
			)

			if (result.body === null) {
				bodyOmittedReason = result.omittedReason
			} else {
				bodyIncluded = true
				parts.push(`--data-raw '${shellEscape(result.body)}'`)
			}
		}
	} else {
		bodyOmittedReason = "disabled"
	}

	parts.push(`'${shellEscape(redactUrl(new URL(request.url), options?.redactQueryParam))}'`)

	return {
		bodyIncluded,
		bodyOmittedReason,
		curl: parts.join(" "),
	}
}

function curlLogger(
	options?: CurlLoggerOptions,
): MiddlewareFn<{ path: string, req: Request }, {}> {
	const log = options?.log ?? defaultLog
	const skip = options?.skip

	return async (ctx, next) => {
		const start = performance.now()
		const method = ctx.req.method
		const path = ctx.path
		const rid = (ctx as Record<string, unknown>)["requestId"] as string | null ?? null
		const curlDataPromise = buildCurlLogData(ctx.req, options)

		const response = await next()
		const duration = performance.now() - start
		const curlData = await curlDataPromise

		const data: CurlLogData = {
			...curlData,
			duration,
			method,
			path,
			requestId: rid,
			status: response.status,
		}

		if (skip?.(data)) {
			return response
		}

		if (options?.instance) {
			options.instance.info(
				{
					bodyIncluded: data.bodyIncluded,
					bodyOmittedReason: data.bodyOmittedReason,
					curl: data.curl,
					duration: data.duration,
					method: data.method,
					path: data.path,
					requestId: data.requestId,
					status: data.status,
				},
				"request curl",
			)
		} else {
			log(data)
		}

		return response
	}
}

export { buildCurlLogData, curlLogger }
export type {
	BodyOmittedReason,
	CurlLogData,
	CurlLoggerBodyOptions,
	CurlLoggerOptions,
}
