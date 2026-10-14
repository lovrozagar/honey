/**
 * The app logger (H17): pino-compatible levels and line shape, children that bind fields, and a
 * sink. Every server-side line honey writes goes through one; `app.logger(value)` replaces the
 * default, `app.logger(false)` silences it. Below the level nothing is built: no fields read, no
 * clock read. A plain module: importing it registers nothing (H23).
 */
import { HoneyError } from "../errors/error.ts"
import { formatLine, type LogFormat } from "./log-format.ts"

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

type LogFn = {
	(msg: string): void
	(fields: Record<string, unknown>, msg?: string): void
}

export type Logger = {
	readonly level: LogLevel
	/** A logger that writes `bindings` into every line, over this one's. */
	child(bindings: Record<string, unknown>): Logger
	debug: LogFn
	error: LogFn
	fatal: LogFn
	info: LogFn
	trace: LogFn
	warn: LogFn
}

export type CreateLoggerOptions = {
	/** Fields every line carries. */
	base?: Record<string, unknown>
	/** Default: `pretty` when NODE_ENV is development, else `json`. */
	format?: LogFormat
	/** Default: `debug` in development, `silent` in test, else `info`. */
	level?: LogLevel
	/** Where a line goes. Default: stdout, or the console where there is none (Workers). */
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
export function defaultsFor(env: string | undefined): { format: LogFormat; level: LogLevel } {
	if (env === "development") return { format: "pretty", level: "debug" }
	if (env === "test") return { format: "json", level: "silent" }
	return { format: "json", level: "info" }
}

function defaultSink(): Sink {
	const stdout = (globalThis as { process?: { stdout?: { write(text: string): unknown } } }).process?.stdout
	if (typeof stdout?.write === "function") return (line) => void stdout.write(`${line}\n`)
	/* the default sink on a runtime without stdout (Workers): the console is where its logs go */
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
