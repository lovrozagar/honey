/**
 * Containment for user callbacks the framework calls outside a request's middleware chain
 * (WebSocket and realtime events, adapter hooks). A sync throw or a rejection never escapes
 * into the runtime, where it would be an uncaught exception or an unhandled rejection and,
 * on Node, end the process.
 */

/** The error side of a structured logger (`error(obj, msg)`), e.g. honey/logger. */
export type InvokeLogger = {
	error?: (obj: Record<string, unknown>, msg?: string) => void
}

export type InvokeOptions = {
	/** Where the callback's error goes. When it throws or rejects itself, that is logged and it is not called again for its own error. */
	onError?: ((err: unknown) => unknown) | null
	/** The app logger; `console.error` when absent. */
	log?: InvokeLogger | null
	/** A label for the log line (`"open"`, `"message"`, …). */
	phase: string
	/** Extra fields for the log line. */
	fields?: Record<string, unknown>
}

function logFailure(err: unknown, opts: InvokeOptions, phase: string): void {
	const fields = { ...opts.fields, err, phase }
	try {
		if (opts.log?.error) {
			opts.log.error(fields, "callback failed")
			return
		}
	} catch {
		/* a broken logger must not take the callback's place as the thing that escapes */
	}
	console.error("honey: callback failed", fields)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function"
}

/** Report `err` through `onError`, or log it. Never throws, never rejects. */
export function reportUserError(err: unknown, opts: InvokeOptions): void {
	const onError = opts.onError
	if (!onError) {
		logFailure(err, opts, opts.phase)
		return
	}
	try {
		const r = onError(err)
		if (isThenable(r)) r.then(undefined, (e: unknown) => logFailure(e, opts, "onError"))
	} catch (e) {
		logFailure(e, opts, "onError")
	}
}

/**
 * Call `fn` and resolve once it settles. Resolves `true` when it succeeded and `false` when it
 * threw or rejected (the error went to `onError` or the logger). Never rejects.
 */
export function invokeUser(fn: () => unknown, opts: InvokeOptions): Promise<boolean> {
	try {
		const r = fn()
		if (isThenable(r)) {
			return Promise.resolve(r).then(
				() => true,
				(e: unknown) => {
					reportUserError(e, opts)
					return false
				},
			)
		}
		return Promise.resolve(true)
	} catch (e) {
		reportUserError(e, opts)
		return Promise.resolve(false)
	}
}

/**
 * One ordered event queue: each task starts after the previous one settled, and a failing task
 * never stops the ones after it.
 */
export function createEventQueue(): { push(task: () => Promise<unknown>): Promise<void> } {
	let tail: Promise<void> = Promise.resolve()
	return {
		push(task) {
			const next = tail.then(task).then(
				() => undefined,
				() => undefined,
			)
			tail = next
			return next
		},
	}
}
