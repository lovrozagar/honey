/**
 * The one streaming primitive behind `ctx.res.sse()`, `stream()` and `generate()`.
 *
 * - The producer starts on the first read, so a body nobody reads (HEAD, a middleware that swaps
 *   the response, a client gone before the headers) never runs it.
 * - It ends exactly once: the producer finished, the reader cancelled (client disconnect), or the
 *   request signal aborted (`ctx.signal`). Cleanups registered with `onEnd` run there, once.
 * - A write resolves when the reader asks for more, so a producer that awaits its writes never
 *   queues more than one chunk past demand. A write after the end rejects, marked handled, so an
 *   unawaited one never surfaces as an unhandled rejection.
 * - A producer failure that is not the stream's own abort breaks the body, so the client sees an
 *   aborted transfer instead of a clean end, and goes to `report`.
 */

export type ProducerSink = {
	/** Aborts when the stream ends any way other than the producer finishing. */
	readonly signal: AbortSignal
	/** True once the stream ended. */
	readonly closed: boolean
	/** End the body cleanly. Idempotent. */
	close(): void
	/** End the body as broken. Idempotent. */
	error(error: unknown): void
	/** Run `fn` once when the stream ends, or now if it already has. */
	onEnd(fn: () => void): void
	/** Queue a chunk. Resolves when the reader is ready for more; rejects after the end. */
	write(chunk: Uint8Array): Promise<void>
}

export type ProducerOptions = {
	/** A producer failure that is not the stream's own abort. Wired to the logger at bit 07. */
	report?: (error: unknown) => void
	/** The request's signal (`ctx.signal`), read when the producer starts. */
	signal?: () => AbortSignal | undefined
}

type Generated = AsyncGenerator<string | Uint8Array, void, unknown> | Generator<string | Uint8Array, void, unknown>

class StreamEnded extends Error {
	override readonly name = "AbortError"
}

function swallow(): void {}

/** A rejection marked handled: awaiting it still throws, leaving it unawaited never surfaces. */
function handledRejection(reason: unknown): Promise<never> {
	const rejected = Promise.reject(reason)
	rejected.catch(swallow)
	return rejected
}

/** The reason the stream aborted with, or an AbortError thrown in answer to it. */
function isAbortOf(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
}

/** Listen for the request ending; the returned function stops listening. */
function onRequestAbort(request: AbortSignal, end: () => void): () => void {
	request.addEventListener("abort", end, { once: true })
	return () => request.removeEventListener("abort", end)
}

function closeQuietly(controller: ReadableStreamDefaultController<Uint8Array>): void {
	try {
		controller.close()
	} catch {
		/* the reader already cancelled */
	}
}

/** The state of one push-driven body: its end, the writers waiting on demand, its cleanups. */
class Producer implements ProducerSink {
	readonly #abort = new AbortController()
	#cleanups: (() => void)[] = []
	#controller!: ReadableStreamDefaultController<Uint8Array>
	#ended = false
	#waiting: PromiseWithResolvers<void>[] = []
	#detach: () => void = swallow

	get signal(): AbortSignal {
		return this.#abort.signal
	}

	get closed(): boolean {
		return this.#ended
	}

	attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
		this.#controller = controller
	}

	close(): void {
		if (this.#ended) return
		this.#ended = true
		closeQuietly(this.#controller)
		this.#release()
	}

	error(error: unknown): void {
		if (this.#ended) return
		this.#ended = true
		this.#controller.error(error)
		this.#release()
	}

	onEnd(fn: () => void): void {
		if (this.#ended) fn()
		else this.#cleanups.push(fn)
	}

	write(chunk: Uint8Array): Promise<void> {
		if (this.#ended) {
			return handledRejection(this.signal.aborted ? this.signal.reason : new StreamEnded("stream closed"))
		}
		/* the queue holds nothing ahead of demand (high-water mark 0): every write waits for the next read */
		this.#controller.enqueue(chunk)
		const waiter = Promise.withResolvers<void>()
		waiter.promise.catch(swallow)
		this.#waiting.push(waiter)
		return waiter.promise
	}

	/** The reader cancelled, or the request ended: abort the producer, then clean up. */
	cancel(reason: unknown): void {
		this.#ended = true
		this.#abort.abort(reason ?? new StreamEnded("stream cancelled"))
		const waiting = this.#waiting
		this.#waiting = []
		for (const waiter of waiting) waiter.reject(this.signal.reason)
		this.#release()
	}

	/** The reader asked for more: every waiting writer may go on. */
	demand(): void {
		if (this.#waiting.length === 0) return
		const waiting = this.#waiting
		this.#waiting = []
		for (const waiter of waiting) waiter.resolve()
	}

	run(start: (sink: ProducerSink) => void | Promise<void>, options: ProducerOptions | undefined): void {
		const request = options?.signal?.()
		if (request?.aborted === true) {
			/* the client left before the first read: end without running the producer */
			this.cancel(request.reason)
			closeQuietly(this.#controller)
			return
		}
		if (request !== undefined) {
			this.#detach = onRequestAbort(request, () => {
				this.cancel(request.reason)
				closeQuietly(this.#controller)
			})
		}
		let result: void | Promise<void>
		try {
			result = start(this)
		} catch (error) {
			result = Promise.reject(error)
		}
		Promise.resolve(result).then(
			() => this.close(),
			(error: unknown) => {
				if (isAbortOf(error, this.signal)) return
				options?.report?.(error)
				this.error(error)
			},
		)
	}

	#release(): void {
		this.demand()
		this.#detach()
		this.#detach = swallow
		const cleanups = this.#cleanups
		this.#cleanups = []
		for (const fn of cleanups) {
			try {
				fn()
			} catch {
				/* one cleanup failing must not keep the others from running */
			}
		}
	}
}

/**
 * A body driven by a push producer (`sse`, `stream`). `start` runs on the first read with a
 * sink; when its promise settles the body ends, cleanly or broken if it rejected.
 */
export function producerStream(
	start: (sink: ProducerSink) => void | Promise<void>,
	options?: ProducerOptions,
): ReadableStream<Uint8Array> {
	const producer = new Producer()
	let started = false
	return new ReadableStream<Uint8Array>(
		{
			cancel: (reason) => producer.cancel(reason),
			pull: () => {
				if (started) return producer.demand()
				started = true
				producer.run(start, options)
			},
			start: (controller) => producer.attach(controller),
		},
		{ highWaterMark: 0 },
	)
}

/** One generator-backed body: a value per read; cancel or the request ending runs its `finally`. */
class GeneratorPull {
	readonly #encoder = new TextEncoder()
	readonly #generator: Generated
	readonly #options: ProducerOptions | undefined
	#controller!: ReadableStreamDefaultController<Uint8Array>
	#ended = false
	#attached = false
	#detach: () => void = swallow

	constructor(generator: Generated, options: ProducerOptions | undefined) {
		this.#generator = generator
		this.#options = options
	}

	attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
		this.#controller = controller
	}

	/** End without another value: detach, then let the generator run its `finally`. */
	stop(): void {
		this.#end()
		/* `return()` on an async generator waits for a pending `next()`, then runs `finally` */
		Promise.resolve()
			.then(() => this.#generator.return(undefined))
			.catch((error: unknown) => this.#options?.report?.(error))
	}

	async pull(): Promise<void> {
		if (!this.#attached && !this.#listen()) {
			this.stop()
			return this.#controller.close()
		}
		let step: IteratorResult<string | Uint8Array, void>
		try {
			step = await this.#generator.next()
		} catch (error) {
			if (this.#ended) return
			this.#end()
			this.#options?.report?.(error)
			return this.#controller.error(error)
		}
		if (this.#ended) return
		if (step.done === true) {
			this.#end()
			return this.#controller.close()
		}
		this.#controller.enqueue(typeof step.value === "string" ? this.#encoder.encode(step.value) : step.value)
	}

	/** Follow the request signal from the first read; false when it already aborted. */
	#listen(): boolean {
		this.#attached = true
		const request = this.#options?.signal?.()
		if (request === undefined) return true
		if (request.aborted) return false
		this.#detach = onRequestAbort(request, () => {
			this.stop()
			closeQuietly(this.#controller)
		})
		return true
	}

	#end(): void {
		this.#ended = true
		this.#detach()
		this.#detach = swallow
	}
}

/**
 * A body pulled from a generator, one value per read. Cancel, or the request signal aborting,
 * calls `generator.return()` so its `finally` runs; a throw breaks the body.
 */
export function generatorStream(generator: Generated, options?: ProducerOptions): ReadableStream<Uint8Array> {
	const pull = new GeneratorPull(generator, options)
	return new ReadableStream<Uint8Array>(
		{
			cancel: () => pull.stop(),
			pull: () => pull.pull(),
			start: (controller) => pull.attach(controller),
		},
		{ highWaterMark: 0 },
	)
}
