/**
 * Containment for user callbacks the framework calls outside a request's middleware chain (ws and
 * realtime events, adapter hooks). A sync throw or a rejection never escapes into the runtime,
 * where it would be an uncaught exception or an unhandled rejection and, on Node, end the process.
 * The failure goes to the callback's `onError`, else to the logger; until bit 07 wires the app
 * logger, a failure with neither is contained and goes nowhere.
 */

/** The error side of a structured logger (`error(fields, msg)`). */
export type InvokeLogger = {
	error?: (fields: Record<string, unknown>, msg?: string) => void
}

export type InvokeOptions = {
	/** Where the callback's error goes. If it throws or rejects itself, that is logged and it is not called again. */
	onError?: ((error: unknown) => unknown) | null
	log?: InvokeLogger | null
	/** A label for the log line (`"websocket open"`, …). */
	phase: string
	/** Extra fields for the log line. */
	fields?: Record<string, unknown>
}

function logFailure(error: unknown, options: InvokeOptions, phase: string): void {
	try {
		options.log?.error?.({ ...options.fields, err: error, phase }, "callback failed")
	} catch {
		/* a broken logger must not become the thing that escapes */
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function"
}

/** Report `error` through `onError`, or log it. Never throws, never rejects. */
export function reportUserError(error: unknown, options: InvokeOptions): void {
	const onError = options.onError
	if (!onError) return logFailure(error, options, options.phase)
	try {
		const result = onError(error)
		if (isThenable(result)) result.then(undefined, (failure: unknown) => logFailure(failure, options, "onError"))
	} catch (failure) {
		logFailure(failure, options, "onError")
	}
}

/**
 * Call `fn`: `true` when it succeeded, `false` when it threw or rejected (reported). A callback that
 * answers at once is answered at once; one that returns a promise is answered by a promise. Never
 * throws, never rejects.
 */
export function invokeUser(fn: () => unknown, options: InvokeOptions): boolean | Promise<boolean> {
	try {
		const result = fn()
		if (!isThenable(result)) return true
		return Promise.resolve(result).then(
			() => true,
			(error: unknown) => {
				reportUserError(error, options)
				return false
			},
		)
	} catch (error) {
		reportUserError(error, options)
		return false
	}
}

const IDLE: Promise<void> = /* @__PURE__ */ Promise.resolve()

/**
 * One ordered lane: each task starts after the previous one settled; a failing task never stops the
 * rest. A task pushed while nothing is waiting runs at once, so a callback that answers at once costs
 * no turn of the queue; what it pushes while it runs waits until it settled.
 */
export function createEventQueue(): { push(task: () => unknown): Promise<void> } {
	let tail = IDLE
	let waiting = 0
	let running = false
	/* opens the gate pushes made during a running task wait behind; null until one is made */
	let open: (() => void) | null = null
	const settled = (): void => {
		waiting--
	}
	return {
		push(task) {
			if (running && open === null) tail = new Promise<void>((resolve) => (open = resolve))
			if (waiting > 0) {
				waiting++
				tail = tail.then(task).then(settled, settled)
				return tail
			}
			waiting++
			running = true
			let result: unknown
			try {
				result = task()
			} catch {
				/* lane tasks report their own failures (invokeUser); one that throws anyway must not stop the lane */
				result = undefined
			}
			running = false
			const gate = open
			open = null
			if (!isThenable(result)) {
				waiting--
				gate?.()
				return IDLE
			}
			const done = Promise.resolve(result).then(settled, settled)
			if (gate === null) tail = done
			else void done.then(gate)
			return done
		},
	}
}
