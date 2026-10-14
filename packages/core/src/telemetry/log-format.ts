/**
 * A log record as one line: JSON (pino's shape, for production and log shippers) or pretty (for a
 * developer's terminal). A value JSON cannot hold (a BigInt, a cycle) never fails the line.
 */

export type LogFormat = "json" | "pretty"

const NAMES: Readonly<Record<number, string>> = /* @__PURE__ */ Object.freeze({
	10: "TRACE",
	20: "DEBUG",
	30: "INFO",
	40: "WARN",
	50: "ERROR",
	60: "FATAL",
})

/** JSON.stringify that writes a BigInt as its digits and an object inside itself as "[Circular]". */
function stringify(value: unknown): string {
	/* the objects enclosing the one being written: only a true cycle is cut, a shared object is written each time */
	const ancestors: object[] = []
	return JSON.stringify(value, function (this: unknown, _key, item: unknown) {
		if (typeof item === "bigint") return item.toString()
		if (typeof item !== "object" || item === null) return item
		while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
		if (ancestors.includes(item)) return "[Circular]"
		ancestors.push(item)
		return item
	})
}

function clock(time: number): string {
	return new Date(time).toISOString().slice(11, 23)
}

function pretty(record: Record<string, unknown>): string {
	const { level, msg, time, ...fields } = record
	const head = `${clock(time as number)} ${(NAMES[level as number] ?? String(level)).padEnd(5)} ${String(msg)}`
	const err = fields.err as { stack?: unknown } | undefined
	const rest = Object.keys(fields).length > 0 ? ` ${stringify(fields)}` : ""
	return typeof err?.stack === "string" ? `${head}${rest}\n${err.stack}` : `${head}${rest}`
}

/** `record` as one line in `format`. */
export function formatLine(format: LogFormat, record: Record<string, unknown>): string {
	return format === "pretty" ? pretty(record) : stringify(record)
}
