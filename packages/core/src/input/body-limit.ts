/**
 * `bodyLimit(options)`: a cap on the request body, in bytes. A declared Content-Length over the
 * cap answers 413 before anything is read; otherwise the body is counted as it is read, whatever
 * the length claims, and the read that passes the cap fails with 413. Every method that carries a
 * body is limited, extension methods too; a request with no body and no declared length is not.
 */
import { withBody } from "../adapters/fetch-request.ts"
import { EK, HoneyError } from "../errors/error.ts"
import { type MiddlewareFn, namedMiddleware } from "../middleware/middleware.ts"
import { replaceRequest } from "../context/context.ts"
import { parseMediaType } from "../response/media-type.ts"

export type BodyLimitOptions = {
	/**
	 * Limits by media type, read from the request's parsed media type: an essence key
	 * (`"application/json"`) takes that type alone, a family key ending in `/` (`"multipart/"`)
	 * every subtype of its type. An essence key wins over its family.
	 */
	limits?: Readonly<Record<string, number>>
	/** The cap for a body no `limits` key matches, in bytes. */
	maxSize: number
	/**
	 * Take a declared Content-Length within the cap at its word and count nothing. HTTP/1.1 and
	 * HTTP/2 framing keep a body to its declared length, but only where the transport enforces
	 * it; by default every byte is counted. A body with no declared length is always counted.
	 */
	trustContentLength?: boolean
}

/* after an overflow the rest is read and dropped, so the client sees the 413 rather than a reset,
 * but no further than this: past it the body is cancelled, so an endless one cannot hold the socket */
const DRAIN_LIMIT = 1_048_576

function tooLarge(): HoneyError {
	return new HoneyError({ errorKey: EK.content_too_large, status: "content_too_large" })
}

/** The cap for `contentType` under `limits`: its essence's key, else its family's; `maxSize` when none. */
function capFor(limits: Readonly<Record<string, number>>, maxSize: number, contentType: string | null): number {
	const mt = parseMediaType(contentType)
	if (mt === null) return maxSize
	return limits[mt.essence] ?? limits[`${mt.type}/`] ?? maxSize
}

/** A declared length, or `null` when it is absent or not a whole number of bytes. */
function declaredLength(header: string | null): number | null {
	if (header === null || !/^\d+$/.test(header.trim())) return null
	return Number(header)
}

/** Read and drop what is left after an overflow, up to DRAIN_LIMIT, then cancel the rest. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	let drained = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) return
			drained += value.byteLength
			if (drained > DRAIN_LIMIT) return void (await reader.cancel())
		}
	} catch {
		/* the body failed or was already done: nothing left to drop */
	}
}

/**
 * `body` counted against `cap`: the read that passes it errors with 413 and the rest is drained.
 * Drained, not cancelled, so a FormData body still being encoded (undici) is left to finish.
 */
function counted(body: ReadableStream<Uint8Array>, cap: number): ReadableStream<Uint8Array> {
	const reader = body.getReader()
	let received = 0
	return new ReadableStream<Uint8Array>({
		cancel() {
			void drain(reader)
		},
		async pull(controller) {
			let result: ReadableStreamReadResult<Uint8Array>
			try {
				result = await reader.read()
			} catch (error) {
				return controller.error(error)
			}
			if (result.done) return controller.close()
			received += result.value.byteLength
			if (received <= cap) return controller.enqueue(result.value)
			controller.error(tooLarge())
			void drain(reader)
		},
	})
}

/** Limit the request body to `options.maxSize` bytes, or to the `limits` entry for its media type. */
export function bodyLimit(options: BodyLimitOptions): MiddlewareFn<{ req: Request }, {}, "content_too_large"> {
	const { maxSize, trustContentLength = false } = options
	/* keys lowercased once, on a record with no prototype: a media type never finds a prototype member */
	const limits: Record<string, number> = Object.create(null)
	for (const [key, cap] of Object.entries(options.limits ?? {})) limits[key.trim().toLowerCase()] = cap
	const mw: MiddlewareFn<{ req: Request }, {}, "content_too_large"> = (ctx, next) => {
		const req = ctx.req
		const declared = declaredLength(req.headers.get("content-length"))
		const body = req.body
		if (body === null && declared === null) return next()
		const cap = capFor(limits, maxSize, req.headers.get("content-type"))
		if (declared !== null && declared > cap) throw tooLarge()
		if (body === null || (trustContentLength && declared !== null)) return next()
		replaceRequest(ctx, withBody(req, counted(body, cap)))
		return next()
	}
	return namedMiddleware("bodyLimit", mw)
}
