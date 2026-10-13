import { namedMiddleware } from "./middleware.ts"
import { HoneyError } from "./error.ts"
import { parseMediaType } from "./media-type.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type BodyLimitOptions = {
	/**
	 * Per media-type size limits. A key matches when the request's media type
	 * (lowercased, parameters dropped) starts with it, so `"multipart/"` covers
	 * every multipart type. The longest matching key wins.
	 */
	limits?: Record<string, number>
	/** Default max body size in bytes — used when no content-type match or no limits map */
	maxSize: number
	/**
	 * Skip stream byte-counting when Content-Length header is present and within bounds.
	 * HTTP/1.1 and HTTP/2 framing guarantees body cannot exceed declared Content-Length
	 * regardless of TLS — the protocol enforces it at the transport level.
	 * When false, every request body is wrapped in a counting TransformStream even
	 * when Content-Length is present. Chunked requests (no Content-Length) are always
	 * stream-counted regardless of this setting.
	 * Default: false.
	 */
	trustContentLength?: boolean
}

export type { BodyLimitOptions }

/* After an overflow the rest of the upload is read and discarded so the client
 * sees the 413 instead of a reset, but only this much: past it the stream is
 * cancelled, so a client cannot hold the connection open with an endless body. */
const DRAIN_LIMIT = 1_048_576

/* the shared parser lowercases and drops parameters; a malformed type matches no key */
function mediaType(contentType: string | null): string | null {
	return parseMediaType(contentType)?.essence ?? null
}

function tooLarge(): HoneyError {
	return new HoneyError({ errorKey: EK.content_too_large, status: SK.content_too_large })
}

export function bodyLimit(opts: BodyLimitOptions): MiddlewareFn<{ req: Request }, {}> {
	const { limits, maxSize, trustContentLength } = opts
	const limitEntries =
		limits !== undefined
			? Object.entries(limits)
					.map(([key, limit]) => [key.trim().toLowerCase(), limit] as const)
					.sort((a, b) => b[0].length - a[0].length)
			: null

	const resolveMax = (req: Request): number => {
		if (limitEntries === null) return maxSize
		const type = mediaType(req.headers.get("content-type"))
		if (type === null) return maxSize
		for (const [key, limit] of limitEntries) {
			if (type.startsWith(key)) return limit
		}
		return maxSize
	}

	/* every method: a DELETE or PROPFIND with a body is as large as a POST */
	const mw: MiddlewareFn<{ req: Request }, {}> = (ctx, next) => {
		const req = ctx.req
		const contentLength = req.headers.get("content-length")
		const body = req.body
		if (body === null && contentLength === null) return next()

		const limit = resolveMax(req)

		/* fast path: Content-Length header present */
		if (contentLength !== null) {
			const len = Number.parseInt(contentLength, 10)
			if (!Number.isNaN(len) && len > limit) throw tooLarge()
			if (trustContentLength === true) return next()
		}

		/* slow path: stream-count when no Content-Length (chunked) or trustContentLength disabled.
		 * On overflow, error the downstream consumer then drain (do not cancel) the upstream —
		 * cancelling an undici FormData body mid-encode enqueues into a closed stream on Node 24. */
		if (body === null) return next()

		let totalBytes = 0
		let overflowed = false
		const reader = body.getReader()

		const drainUpstream = (): void => {
			void (async () => {
				let drained = 0
				try {
					while (true) {
						const r = await reader.read()
						if (r.done) break
						drained += r.value.byteLength
						if (drained > DRAIN_LIMIT) {
							await reader.cancel()
							break
						}
					}
				} catch {
					/* producer may already be done */
				}
			})()
		}

		const limited = new ReadableStream<Uint8Array>({
			cancel() {
				/* consumer aborted — still drain so undici FormData encoders can finish */
				drainUpstream()
			},
			async pull(controller) {
				if (overflowed) return
				let result: ReadableStreamReadResult<Uint8Array>
				try {
					result = await reader.read()
				} catch (err) {
					controller.error(err)
					return
				}
				if (result.done) {
					controller.close()
					return
				}
				totalBytes += result.value.byteLength
				if (totalBytes > limit) {
					overflowed = true
					controller.error(tooLarge())
					drainUpstream()
					return
				}
				controller.enqueue(result.value)
			},
		})

		const replaceBody = (req as unknown as Record<symbol, unknown>)[Symbol.for("honey.replaceBody")]
		if (typeof replaceBody === "function") {
			;(replaceBody as (stream: ReadableStream<Uint8Array>) => void).call(req, limited)
		} else {
			/* duplex: "half" required by Node/undici when body is a ReadableStream */
			const newReq = new Request(req, {
				body: limited,
				duplex: "half",
			} as RequestInit)
			Object.defineProperty(ctx, "req", { configurable: true, value: newReq })
		}

		return next()
	}

	return namedMiddleware("bodyLimit", mw)
}
