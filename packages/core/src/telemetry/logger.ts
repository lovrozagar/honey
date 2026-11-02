/**
 * The app logger (H17): pino-compatible levels and line shape, children that bind fields, and a
 * sink. Every server-side line honey writes goes through one; `app.logger(value)` replaces the
 * default, `app.logger(false)` silences it. Below the level nothing is built: no fields read, no
 * clock read. A plain module: importing it registers nothing (H23).
 */
import { HoneyError } from "../errors/error.ts"
import { formatLine, type LogFormat } from "./log-format.ts"

/** A log level, from `trace` (most verbose) to `fatal`; `silent` writes nothing. */
export type LogLevel = "debug" | "error" | "fatal" | "info" | "silent" | "trace" | "warn"

/** pino's numeric levels; `silent` is above every one. */
export const LEVELS: Readonly<Record<LogLevel, number>> = /* @__PURE__ */ Object.freeze({
	debug: 20,
	error: 50,
	fatal: 60,
	info: 30,
	silent: Number.POSITIVE_INFINITY,
	trace: 10,
	warn: 40,
})

/** A log method: call it with a message, or with fields and an optional message. */
type LogFn = {
	/** Writes a line with this message. */
	(msg: string): void
	/** Writes a line with `fields` merged in and an optional message; a top-level `Error` field is written with its name, message, stack and cause. */
	(fields: Record<string, unknown>, msg?: string): void
}

/** A leveled logger. A call below the logger's level does no work. */
export type Logger = {
	/** The level this logger writes at or above. */
	readonly level: LogLevel
	/** A logger that writes `bindings` into every line, over this one's. */
	child(bindings: Record<string, unknown>): Logger
	/** Writes at level `debug` (20). */
	debug: LogFn
	/** Writes at level `error` (50). */
	error: LogFn
	/** Writes at level `fatal` (60). */
	fatal: LogFn
	/** Writes at level `info` (30). */
	info: LogFn
	/** Writes at level `trace` (10). */
	trace: LogFn
	/** Writes at level `warn` (40). */
	warn: LogFn
}

/** Options for `createLogger`. */
export type CreateLoggerOptions = {
	/** Fields every line carries. */
	base?: Record<string, unknown>
	/** Default: `pretty` when NODE_ENV is development, else `json`. */
	format?: LogFormat
	/** Default: `debug` in development, `error` in test (an incident is never swallowed), else `info`. */
	level?: LogLevel
	/** Where a line goes. Default: the console on Workers, stdout on Node and Bun. */
	write?: (line: string) => void
}

type Sink = (line: string) => void

/** NODE_ENV where the runtime has a process environment; undefined where it has none (Workers). */
export function nodeEnv(): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV
}

/**
 * The default level and format for a NODE_ENV. Unset, unreadable or unknown takes production's:
 * forgetting NODE_ENV must never turn on debug output.
 */
export function defaultsFor(env: string | undefined): {
	/** `pretty` in development, else `json`. */
	format: LogFormat
	/** `debug` in development, `error` in test, else `info`. */
	level: LogLevel
} {
	if (env === "development") return { format: "pretty", level: "debug" }
	/* the runner sets NODE_ENV=test, not the author: a quiet test is worth having, a swallowed incident is not */
	if (env === "test") return { format: "json", level: "error" }
	return { format: "json", level: "info" }
}

/**
 * Whether this runtime is Workers, by the same mark `detectRuntime` reads (never by calling it: that one throws
 * where it cannot tell, and a logger must not throw as it is made).
 */
function onWorkers(): boolean {
	const agent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? ""
	return agent.startsWith("Cloudflare-Workers") || agent.startsWith("workerd")
}

function defaultSink(): Sink {
	/* the console is where a worker's logs go, and `nodejs_compat` gives it a process.stdout that they do not:
	   the sink follows the runtime, not whichever globals happen to exist (bit 22 a) */
	// oxlint-disable-next-line no-console
	if (onWorkers()) return (line) => console.log(line)
	const stdout = (globalThis as { process?: { stdout?: { write(text: string): unknown } } }).process?.stdout
	if (typeof stdout?.write === "function") return (line) => void stdout.write(`${line}\n`)
	/* a runtime with neither: the console is the one sink left */
	// oxlint-disable-next-line no-console
	return (line) => console.log(line)
}

/** `fields` with each Error written as its name, message, stack and cause instead of `{}`. */
function withErrors(fields: Record<string, unknown>): Record<string, unknown> {
	let out: Record<string, unknown> | null = null
	for (const key in fields) {
		const value = fields[key]
		if (value instanceof Error) {
			out ??= { ...fields }
			out[key] = HoneyError.serialize(value)
		}
	}
	return out ?? fields
}

/* methods live on the prototype: a per-request child must not allocate a closure per level */
class LoggerImpl implements Logger {
	readonly level: LogLevel
	readonly #base: Record<string, unknown>
	readonly #format: LogFormat
	readonly #threshold: number
	readonly #write: Sink

	constructor(level: LogLevel, format: LogFormat, write: Sink, base: Record<string, unknown>) {
		this.level = level
		this.#base = base
		this.#format = format
		this.#threshold = LEVELS[level]
		this.#write = write
	}

	child(bindings: Record<string, unknown>): Logger {
		return new LoggerImpl(this.level, this.#format, this.#write, { ...this.#base, ...bindings })
	}

	trace(first: Record<string, unknown> | string, msg?: string): void {
		this.#emit(10, first, msg)
	}

	debug(first: Record<string, unknown> | string, msg?: string): void {
		this.#emit(20, first, msg)
	}

	info(first: Record<string, unknown> | string, msg?: string): void {
		this.#emit(30, first, msg)
	}

	warn(first: Record<string, unknown> | string, msg?: string): void {
		this.#emit(40, first, msg)
	}

	error(first: Record<string, unknown> | string, msg?: string): void {
		this.#emit(50, first, msg)
	}

	fatal(first: Record<string, unknown> | string, msg?: string): void {
		this.#emit(60, first, msg)
	}

	#emit(level: number, first: Record<string, unknown> | string, msg: string | undefined): void {
		if (level < this.#threshold) return
		try {
			const record =
				typeof first === "string"
					? { ...this.#base, level, msg: first, time: Date.now() }
					: { ...this.#base, ...withErrors(first), level, msg: msg ?? "", time: Date.now() }
			this.#write(formatLine(this.#format, record))
		} catch {
			/* a failing sink or a field that cannot be read: the logger is the last reporter, nothing is left to tell */
		}
	}
}

/** A logger. Unset level and format follow NODE_ENV, read now (`defaultsFor`). */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
	const defaults = options.level === undefined || options.format === undefined ? defaultsFor(nodeEnv()) : null
	return new LoggerImpl(
		options.level ?? (defaults as { level: LogLevel }).level,
		options.format ?? (defaults as { format: LogFormat }).format,
		options.write ?? defaultSink(),
		options.base ?? {},
	)
}

function noop(): void {}

function silentChild(): Logger {
	return SILENT
}

/** The logger that writes nothing: what `app.logger(false)` sets. Its children are itself. */
export const SILENT: Logger = /* @__PURE__ */ Object.freeze({
	child: silentChild,
	debug: noop,
	error: noop,
	fatal: noop,
	info: noop,
	level: "silent",
	trace: noop,
	warn: noop,
})
