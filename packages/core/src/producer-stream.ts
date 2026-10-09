/**
 * The one streaming primitive behind `ctx.res.sse()`, `ctx.res.stream()` and `ctx.res.generate()`.
 *
 * - The producer starts on the first read, so a body nobody reads (HEAD, a middleware that
 *   swaps the response, a client that left before headers) never runs it.
 * - It ends exactly once: the producer finished, the consumer cancelled (client disconnect),
 *   or the request signal aborted (`ctx.signal`: disconnect, `timeout()`, shutdown). Timers and
 *   listeners it owns are released there.
 * - Writes are plain enqueues, never floating writer promises: a write after the end rejects
 *   with the abort reason and nothing is left unhandled.
 * - A producer error that is not the abort itself is reported and errors the stream, so the
 *   client sees a broken body instead of a clean end.
 */

/** Marks a response whose body is a stream Honey created; `bodyKind()` reads it. */
export const BODY_KIND = Symbol.for("honey.bodyKind")

export function tagStream<T extends Response>(response: T): T {
	Object.defineProperty(response, BODY_KIND, { value: "stream" })
	return response
}

export type ProducerSink = {
	/** Aborts when the stream ends for any reason other than the producer finishing. */
	readonly signal: AbortSignal
	/** True once the stream ended, closed by the producer or cancelled. */
	readonly closed: boolean
	/** End the body cleanly. Idempotent. */
	close(): void
	/** End the body as broken (the client sees an aborted transfer). Idempotent. */
	error(err: unknown): void
	/** Queue a chunk. Resolves when the consumer is ready for more; rejects after the end. */
	write(chunk: Uint8Array): Promise<void>
	/** Register cleanup that runs once when the stream ends. */
	onEnd(fn: () => void): void
}

export type ProducerOptions = {
	/** The request's signal (`ctx.signal`), read when the producer starts. */
	signal?: (() => AbortSignal | undefined) | undefined
	/** Called with a producer error that is not the stream's own abort. */
	report?: ((err: unknown) => void) | undefined
}

class StreamEnded extends Error {
	override readonly name = "AbortError"
	constructor(message: string) {
		super(message)
	}
}

function noop(): void {}

/** Attach a no-op handler so the promise never counts as unhandled; awaiting it still throws. */
function handled<T>(p: Promise<T>): Promise<T> {
	p.catch(noop)
	return p
}

/** True for the reason the stream aborted with, or an AbortError thrown in response to it. */
function isAbortOf(err: unknown, signal: AbortSignal): boolean {
	if (!signal.aborted) return false
	if (err === signal.reason) return true
	return err instanceof Error && err.name === "AbortError"
}

/**
 * A body driven by a push-style producer (`sse`, `stream`). `start` runs on the first read with
 * a sink; when its promise settles the body ends (cleanly, or errored if it rejected).
 */
export function producerStream(
	start: (sink: ProducerSink) => void | Promise<void>,
	opts?: ProducerOptions,
): ReadableStream<Uint8Array> {
	let controller!: ReadableStreamDefaultController<Uint8Array>
	let started = false
	let ended = false
	const ac = new AbortController()
	const cleanups: (() => void)[] = []
	/* writers waiting for the consumer to ask for more */
	let waiting: { reject: (e: unknown) => void; resolve: () => void }[] = []
	let detachRequest: (() => void) | null = null

	const release = (): void => {
		const ws = waiting
		waiting = []
		for (const w of ws) w.resolve()
		detachRequest?.()
		detachRequest = null
		for (const fn of cleanups.splice(0)) {
			try {
				fn()
			} catch {
				/* cleanup must not break the end of the stream */
			}
		}
	}

	/** End because the consumer or the request went away: abort the producer, then clean up. */
	const abort = (reason: unknown): void => {
		if (ended) return
		ended = true
		ac.abort(reason ?? new StreamEnded("stream cancelled"))
		const ws = waiting
		waiting = []
		for (const w of ws) w.reject(ac.signal.reason)
		release()
	}

	const sink: ProducerSink = {
		close() {
			if (ended) return
			ended = true
			try {
				controller.close()
			} catch {
				/* already closed by the consumer */
			}
			release()
		},
		get closed() {
			return ended
		},
		error(err) {
			if (ended) return
			ended = true
			try {
				controller.error(err)
			} catch {}
			release()
		},
		onEnd(fn) {
			if (ended) fn()
			else cleanups.push(fn)
		},
		signal: ac.signal,
		write(chunk) {
			if (ended) {
				/* marked handled: an unawaited write after the end must not crash the process,
				 * while an awaited one still throws and ends the producer's loop */
				return handled(Promise.reject(ac.signal.aborted ? ac.signal.reason : new StreamEnded("stream closed")))
			}
			controller.enqueue(chunk)
			if ((controller.desiredSize ?? 0) > 0) return Promise.resolve()
			return handled(
				new Promise<void>((resolve, reject) => {
					waiting.push({ reject, resolve })
				}),
			)
		},
	}

	const run = (): void => {
		started = true
		const request = opts?.signal?.()
		if (request !== undefined) {
			if (request.aborted) {
				/* the client left before the first read: end without running the producer */
				abort(request.reason)
				try {
					controller.close()
				} catch {}
				return
			}
			const onAbort = (): void => {
				abort(request.reason)
				try {
					controller.close()
				} catch {}
			}
			request.addEventListener("abort", onAbort, { once: true })
			detachRequest = () => request.removeEventListener("abort", onAbort)
		}
		let result: void | Promise<void>
		try {
			result = start(sink)
		} catch (err) {
			result = Promise.reject(err)
		}
		Promise.resolve(result).then(
			() => sink.close(),
			(err: unknown) => {
				if (isAbortOf(err, ac.signal)) return
				opts?.report?.(err)
				sink.error(err)
			},
		)
	}

	return new ReadableStream<Uint8Array>(
		{
			cancel(reason) {
				abort(reason)
			},
			pull() {
				if (!started) {
					run()
					return
				}
				const ws = waiting
				waiting = []
				for (const w of ws) w.resolve()
			},
			start(c) {
				controller = c
			},
		},
		{ highWaterMark: 0 },
	)
}

/**
 * A body pulled from a generator. Each read takes one value; cancel, or an aborted request
 * signal, calls `generator.return()` so its `finally` runs. A throw errors the body.
 */
export function generatorStream(
	generator: AsyncGenerator<string | Uint8Array, void, unknown> | Generator<string | Uint8Array, void, unknown>,
	opts?: ProducerOptions,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	let ended = false
	let detachRequest: (() => void) | null = null
	let controller!: ReadableStreamDefaultController<Uint8Array>

	const finish = (): void => {
		detachRequest?.()
		detachRequest = null
	}

	const stop = (): void => {
		if (ended) return
		ended = true
		finish()
		/* `return()` on an async generator waits for a pending `next()`, then runs `finally` */
		Promise.resolve()
			.then(() => generator.return(undefined))
			.catch((err: unknown) => opts?.report?.(err))
	}

	let attached = false
	const attach = (): boolean => {
		attached = true
		const request = opts?.signal?.()
		if (request === undefined) return true
		if (request.aborted) return false
		const onAbort = (): void => {
			stop()
			try {
				controller.close()
			} catch {}
		}
		request.addEventListener("abort", onAbort, { once: true })
		detachRequest = () => request.removeEventListener("abort", onAbort)
		return true
	}

	return new ReadableStream<Uint8Array>(
		{
			cancel() {
				stop()
			},
			async pull(c) {
				if (ended) return
				if (!attached && !attach()) {
					stop()
					c.close()
					return
				}
				let step: IteratorResult<string | Uint8Array, void>
				try {
					step = await generator.next()
				} catch (err) {
					if (ended) return
					ended = true
					finish()
					opts?.report?.(err)
					c.error(err)
					return
				}
				if (ended) return
				if (step.done === true) {
					ended = true
					finish()
					c.close()
					return
				}
				const value = step.value
				c.enqueue(typeof value === "string" ? encoder.encode(value) : value)
			},
			start(c) {
				controller = c
			},
		},
		{ highWaterMark: 0 },
	)
}
