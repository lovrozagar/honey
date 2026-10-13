import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"

/* ── log levels (pino-compatible numeric values) ── */

type LogLevel = "debug" | "error" | "fatal" | "info" | "trace" | "warn"

const LEVELS: Record<LogLevel, number> = {
	debug: 20,
	error: 50,
	fatal: 60,
	info: 30,
	trace: 10,
	warn: 40,
}

/* ── logger instance ── */

type LoggerInstance = {
	child(bindings: Record<string, unknown>): LoggerInstance
	debug(msg: string): void
	debug(obj: Record<string, unknown>, msg?: string): void
	error(msg: string): void
	error(obj: Record<string, unknown>, msg?: string): void
	fatal(msg: string): void
	fatal(obj: Record<string, unknown>, msg?: string): void
	info(msg: string): void
	info(obj: Record<string, unknown>, msg?: string): void
	level: LogLevel
	trace(msg: string): void
	trace(obj: Record<string, unknown>, msg?: string): void
	warn(msg: string): void
	warn(obj: Record<string, unknown>, msg?: string): void
}

type CreateLoggerOptions = {
	base?: Record<string, unknown>
	level?: LogLevel
	write?: (line: string) => void
}

/* Methods live on the prototype: `logger()` makes a child per request, and a
 * closure-per-level instance cost seven allocations each time. */
class Logger implements LoggerInstance {
	level: LogLevel
	#threshold: number
	#write: (line: string) => void
	#base: Record<string, unknown>

	constructor(level: LogLevel, write: (line: string) => void, base: Record<string, unknown>) {
		this.level = level
		this.#threshold = LEVELS[level]
		this.#write = write
		this.#base = base
	}

	child(bindings: Record<string, unknown>): LoggerInstance {
		return new Logger(this.level, this.#write, { ...this.#base, ...bindings })
	}

	trace(first: Record<string, unknown> | string, second?: string): void {
		this.#emit(LEVELS.trace, first, second)
	}

	debug(first: Record<string, unknown> | string, second?: string): void {
		this.#emit(LEVELS.debug, first, second)
	}

	info(first: Record<string, unknown> | string, second?: string): void {
		this.#emit(LEVELS.info, first, second)
	}

	warn(first: Record<string, unknown> | string, second?: string): void {
		this.#emit(LEVELS.warn, first, second)
	}

	error(first: Record<string, unknown> | string, second?: string): void {
		this.#emit(LEVELS.error, first, second)
	}

	fatal(first: Record<string, unknown> | string, second?: string): void {
		this.#emit(LEVELS.fatal, first, second)
	}

	#emit(level: number, first: Record<string, unknown> | string, second?: string): void {
		if (level < this.#threshold) return
		const obj =
			typeof first === "string"
				? { ...this.#base, level, msg: first, time: Date.now() }
				: { ...this.#base, ...first, level, msg: second ?? "", time: Date.now() }
		this.#write(JSON.stringify(obj))
	}
}

function createLogger(opts?: CreateLoggerOptions): LoggerInstance {
	return new Logger(opts?.level ?? "info", opts?.write ?? ((line: string) => console.log(line)), opts?.base ?? {})
}

/* ── request lifecycle middleware ── */

type LogData = {
	duration: number
	method: string
	path: string
	requestId: string | null
	status: number
}

type LoggerOptions = {
	instance?: LoggerInstance
	log?: (data: LogData) => void
	skip?: (data: LogData) => boolean
}

function defaultLog(data: LogData): void {
	const rid = data.requestId ? ` ${data.requestId}` : ""
	console.log(`${data.method} ${data.path} ${data.status} ${data.duration.toFixed(2)}ms${rid}`)
}

const noop = () => {}
const noopLogger: LoggerInstance = createLogger({ level: "fatal", write: noop })

function logger(options?: LoggerOptions): MiddlewareFn<{ path: string; req: Request }, { log: LoggerInstance }> {
	const log = options?.log ?? defaultLog
	const skip = options?.skip
	const instance = options?.instance

	return namedMiddleware("logger", async (ctx, next) => {
		const start = performance.now()
		const method = ctx.req.method
		const path = ctx.path
		const rid = ((ctx as Record<string, unknown>)["requestId"] as string | null) ?? null

		const child = instance
			? instance.child({
					method,
					path,
					...(rid ? { requestId: rid } : {}),
				})
			: noopLogger

		/* a failing sink never fails the request, on the way in or out */
		if (instance) {
			try {
				child.info(`--> ${method} ${path}`)
			} catch (err) {
				console.error("logger: failed to log request", err)
			}
		}

		const response = await next({ log: child })

		const duration = performance.now() - start
		const data: LogData = {
			duration,
			method,
			path,
			requestId: rid,
			status: response.status,
		}

		try {
			if (skip?.(data)) return response
			if (instance) {
				child.info({ duration, status: response.status }, `<-- ${method} ${path}`)
			} else {
				log(data)
			}
		} catch (err) {
			console.error("logger: failed to log request", err)
		}

		return response
	})
}

export { createLogger, logger }
export type { CreateLoggerOptions, LogData, LoggerInstance, LoggerOptions, LogLevel }
