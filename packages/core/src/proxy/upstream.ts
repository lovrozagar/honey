/**
 * The call to the upstream: the body it is sent, the deadlines it is held to, and what its failures
 * mean to the client. A network failure the runtime reports is a 502 `bad_gateway`, a missed
 * deadline a 504 `gateway_timeout`; any other throw, a bug in `destination` included, stays what
 * it is (a 500). The URL is the router's normalized `ctx.path` plus the raw query: one leading
 * slash, `//` and `\` collapsed, encoded separators refused with a 400 before any handler runs, so
 * neither `base + url` nor `new URL(url, base)` can leave the upstream's origin (SSRF).
 */
import { HoneyError } from "../errors/error.ts"

/* bodies up to this size with a declared length are forwarded as bytes; larger or unsized ones stream */
const MAX_BUFFERED_BODY_BYTES = 1024 * 1024

/** Network-level codes runtimes put on errors when the upstream cannot be reached or drops. */
const NETWORK_CODES = /^(?:E[A-Z0-9_]+|Connection\w*|UND_ERR\w*|UNABLE_\w+|CERT_\w+|DEPTH_ZERO\w*)$/
const FETCH_FAILED = /^fetch failed/i
const CONNECTION_LOST = /network connection (?:was )?lost/i

/**
 * The body destination is handed. Bytes when small and sized: a streamed body the destination
 * never reads can hold a service binding open until it times out, and a body teed by `clone()`
 * has no known length. Bytes have neither problem.
 */
export async function forwardBody(request: Request): Promise<ArrayBuffer | ReadableStream<Uint8Array> | null> {
	const method = request.method
	/* fetch refuses a GET or HEAD body */
	if (request.body === null || method === "GET" || method === "HEAD") return null
	const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10)
	if (Number.isFinite(declared) && declared <= MAX_BUFFERED_BODY_BYTES) return request.arrayBuffer()
	return request.body
}

/**
 * Whether `error` means the upstream failed (502), as opposed to a bug in user code (500). Fetch
 * reports a network failure as a `TypeError`, as it does a typo, and runtimes tell them apart
 * differently: undici says "fetch failed", Bun puts a `code` on the error (`ConnectionRefused`,
 * `ENOTFOUND`), Workers say the network connection was lost. An invalid URL is the caller's bug.
 */
export function isUpstreamFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const code = (error as { code?: unknown }).code
	if (typeof code === "string") return !code.startsWith("ERR_INVALID") && NETWORK_CODES.test(code)
	return error instanceof TypeError && (FETCH_FAILED.test(error.message) || CONNECTION_LOST.test(error.message))
}

export function timeoutError(): DOMException {
	return new DOMException("upstream timed out", "TimeoutError")
}

/** A deadline option as milliseconds, or `undefined` for none (omitted or not positive). */
export function msOf<TCtx>(option: number | ((ctx: TCtx) => number) | undefined, ctx: TCtx, fallback?: number) {
	const ms = typeof option === "function" ? option(ctx) : (option ?? fallback)
	return ms !== undefined && ms > 0 ? ms : undefined
}

/** One call and its deadline: the upstream controller to abort, the client's signal to tell a disconnect apart. */
export type Call = {
	readonly client: AbortSignal
	readonly headerMs: number | undefined
	readonly upstream: AbortController
}

/** Await `answer` within the header deadline; map what it throws to what the client is told. */
export async function within(call: Call, answer: () => Promise<Response> | Response): Promise<Response> {
	let timedOut = false
	const timer =
		call.headerMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true
					call.upstream.abort(timeoutError())
				}, call.headerMs)
	try {
		return await answer()
	} catch (error) {
		/* ours, or the destination's own AbortSignal.timeout() */
		if (timedOut || (error instanceof DOMException && error.name === "TimeoutError")) {
			throw new HoneyError({ cause: error, errorKey: "gateway_timeout", status: "gateway_timeout" })
		}
		if (!call.client.aborted && isUpstreamFailure(error)) {
			throw new HoneyError({ cause: error, errorKey: "bad_gateway", status: "bad_gateway" })
		}
		throw error
	} finally {
		clearTimeout(timer)
	}
}

/**
 * `body`, erroring and calling `onIdle` (which aborts the upstream) when the upstream sends nothing
 * for `ms`. The clock runs only while a read waits: a client reading slowly is backpressure, not an
 * idle upstream.
 */
export function withIdleTimeout(
	body: ReadableStream<Uint8Array>,
	ms: number,
	onIdle: () => void,
): ReadableStream<Uint8Array> {
	const reader = body.getReader()
	return new ReadableStream<Uint8Array>({
		cancel: (reason) => reader.cancel(reason),
		async pull(controller) {
			let timer: ReturnType<typeof setTimeout> | undefined
			const idle = new Promise<"idle">((resolve) => {
				timer = setTimeout(() => resolve("idle"), ms)
			})
			try {
				const result = await Promise.race([reader.read(), idle])
				if (result === "idle") {
					onIdle()
					const error = timeoutError()
					reader.cancel(error).catch(() => {
						/* the upstream may not react to the abort (a binding, a stub): the body errors below either way */
					})
					controller.error(error)
				} else if (result.done) controller.close()
				else controller.enqueue(result.value)
			} catch (error) {
				controller.error(error)
			} finally {
				clearTimeout(timer)
			}
		},
	})
}
