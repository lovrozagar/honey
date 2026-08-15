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

function createLogger(opts?: CreateLoggerOptions): LoggerInstance {
	const threshold = LEVELS[opts?.level ?? "info"]
	const write = opts?.write ?? ((line: string) => console.log(line))
	const base = opts?.base ?? {}

	function emit(level: number, first: Record<string, unknown> | string, second?: string): void {
		if (level < threshold) return
		const obj =
			typeof first === "string"
				? { ...base, level, msg: first, time: Date.now() }
				: { ...base, ...first, level, msg: second ?? "", time: Date.now() }
		write(JSON.stringify(obj))
	}

	const instance: LoggerInstance = {
		child(bindings: Record<string, unknown>): LoggerInstance {
			return createLogger({
				base: { ...base, ...bindings },
				level: opts?.level,
				write,
			})
		},
		debug: (first: Record<string, unknown> | string, second?: string) => emit(LEVELS.debug, first, second),
		error: (first: Record<string, unknown> | string, second?: string) => emit(LEVELS.error, first, second),
		fatal: (first: Record<string, unknown> | string, second?: string) => emit(LEVELS.fatal, first, second),
		info: (first: Record<string, unknown> | string, second?: string) => emit(LEVELS.info, first, second),
		level: opts?.level ?? "info",
		trace: (first: Record<string, unknown> | string, second?: string) => emit(LEVELS.trace, first, second),
		warn: (first: Record<string, unknown> | string, second?: string) => emit(LEVELS.warn, first, second),
	}

	return instance
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

		if (instance) {
			child.info(`--> ${method} ${path}`)
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

		if (skip?.(data)) {
			return response
		}

		if (instance) {
			child.info({ duration, status: response.status }, `<-- ${method} ${path}`)
		} else {
			log(data)
		}

		return response
	})
}

export { createLogger, logger }
export type { CreateLoggerOptions, LogData, LoggerInstance, LoggerOptions, LogLevel }
