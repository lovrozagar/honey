import { namedMiddleware } from "./middleware.ts"
import { HoneyError } from "./error.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type BodyLimitOptions = {
	/** Per content-type size limits (matched via startsWith against request Content-Type header) */
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

export function bodyLimit(opts: BodyLimitOptions): MiddlewareFn<{ req: Request }, {}> {
	const { limits, maxSize, trustContentLength } = opts
	const limitEntries = limits !== undefined ? Object.entries(limits) : null

	const mw: MiddlewareFn<{ req: Request }, {}> = (ctx, next) => {
		const req = ctx.req
		const method = req.method
		if (method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE") {
			return next()
		}

		/* resolve max size from content-type */
		let resolvedMax = maxSize
		if (limitEntries !== null) {
			const ct = req.headers.get("content-type")
			if (ct !== null) {
				for (const [key, limit] of limitEntries) {
					if (ct.startsWith(key)) {
						resolvedMax = limit
						break
					}
				}
			}
		}

		/* fast path: Content-Length header present */
		const contentLength = req.headers.get("content-length")
		if (contentLength !== null) {
			const len = Number.parseInt(contentLength, 10)
			if (!Number.isNaN(len) && len > resolvedMax) {
				throw new HoneyError({
					errorKey: EK.content_too_large,
					status: SK.content_too_large,
				})
			}
			if (trustContentLength === true) return next()
		}

		/* slow path: stream-count when no Content-Length (chunked) or trustContentLength disabled.
		 * On overflow, error the downstream consumer then drain (do not cancel) the upstream —
		 * cancelling an undici FormData body mid-encode enqueues into a closed stream on Node 24. */
		if (req.body !== null) {
			let totalBytes = 0
			let overflowed = false
			const limit = resolvedMax
			const reader = req.body.getReader()

			const drainUpstream = (): void => {
				void (async () => {
					try {
						while (true) {
							const r = await reader.read()
							if (r.done) break
						}
					} catch {
						/* producer may already be done */
					}
				})()
			}

			const limited = new ReadableStream<Uint8Array>({
				async cancel(reason) {
					/* consumer aborted — still drain so undici FormData encoders can finish */
					drainUpstream()
					void reason
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
						controller.error(
							new HoneyError({
								errorKey: EK.content_too_large,
								status: SK.content_too_large,
							}),
						)
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
		}

		return next()
	}

	return namedMiddleware("bodyLimit", mw)
}
