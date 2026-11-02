/**
 * Five-field cron expressions in UTC, in the one subset that means the same on Workers and in a
 * process: `*`, lists, ranges, steps, and month and weekday names. Anything the runtimes read
 * differently is refused: a numeric weekday (Workers numbers 1 as Sunday, POSIX 0), both day fields
 * at once (POSIX ORs them, others AND them), and the `L`, `W` and `#` forms and six-field forms that
 * only some schedulers take. A date that can never occur is refused too, so it cannot sit silent.
 */

/** The values each field of an expression allows. */
export type CronFields = {
	/** Days of the month, 1 to 31. */
	readonly day: ReadonlySet<number>
	/** Hours, 0 to 23. */
	readonly hour: ReadonlySet<number>
	/** Minutes, 0 to 59. */
	readonly minute: ReadonlySet<number>
	/** Months, 1 to 12. */
	readonly month: ReadonlySet<number>
	/** Weekdays, 0 for Sunday to 6 for Saturday. */
	readonly weekday: ReadonlySet<number>
}

type Spec = {
	readonly max: number
	readonly min: number
	readonly name: string
	/* set for a field that takes names; `namesOnly` refuses its numbers */
	readonly names?: readonly string[]
	readonly namesOnly?: boolean
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]

/* February counts its leap day: `0 0 29 2 *` is a real date, once every four years */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const MINUTE: Spec = { max: 59, min: 0, name: "minute" }
const HOUR: Spec = { max: 23, min: 0, name: "hour" }
const DAY: Spec = { max: 31, min: 1, name: "day of month" }
const MONTH: Spec = { max: 12, min: 1, name: "month", names: MONTHS }
const WEEKDAY: Spec = { max: 6, min: 0, name: "weekday", names: WEEKDAYS, namesOnly: true }

const refused = (expression: string, reason: string) => new Error(`cron: "${expression}" ${reason}`)

const valueOf = (text: string, spec: Spec, expression: string): number => {
	const named = spec.names?.indexOf(text.toUpperCase()) ?? -1
	if (named !== -1) return named + spec.min
	if (spec.namesOnly === true) {
		throw refused(expression, `needs a weekday name such as MON, not "${text}": runtimes number weekdays differently`)
	}
	const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
	if (value >= spec.min && value <= spec.max) return value
	throw refused(expression, `has "${text}" for its ${spec.name}, which takes ${spec.min} to ${spec.max}`)
}

const stepOf = (text: string | undefined, spec: Spec, expression: string): number => {
	if (text === undefined) return 1
	if (/^0*[1-9]\d*$/.test(text)) return Number(text)
	throw refused(expression, `has a step of "${text}" in its ${spec.name}, which must be a whole number above 0`)
}

const boundsOf = (range: string, hasStep: boolean, spec: Spec, expression: string): readonly [number, number] => {
	if (range === "*") {
		if (hasStep && spec.namesOnly === true) throw refused(expression, "steps a weekday from a runtime's own numbering")
		return [spec.min, spec.max]
	}
	const [from, to, ...rest] = range.split("-")
	if (rest.length > 0) throw refused(expression, `has "${range}" for its ${spec.name}`)
	const first = valueOf(from as string, spec, expression)
	if (to === undefined) {
		if (hasStep) throw refused(expression, `steps one value, "${range}", in its ${spec.name}`)
		return [first, first]
	}
	const last = valueOf(to, spec, expression)
	if (first > last) throw refused(expression, `has a reversed range, "${range}", in its ${spec.name}`)
	return [first, last]
}

const parseField = (text: string, spec: Spec, expression: string): ReadonlySet<number> => {
	const values = new Set<number>()
	for (const item of text.split(",")) {
		const [range, step, ...rest] = item.split("/")
		if (rest.length > 0) throw refused(expression, `has "${item}" for its ${spec.name}`)
		const [first, last] = boundsOf(range as string, step !== undefined, spec, expression)
		const by = stepOf(step, spec, expression)
		for (let value = first; value <= last; value += by) values.add(value)
	}
	return values
}

/** Parses `expression`, or throws an error naming it and what it cannot run. */
export function parseCron(expression: string): CronFields {
	const fields = expression.split(" ")
	if (fields.length !== 5) throw refused(expression, "needs five fields split by one space")
	const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string]
	if (day !== "*" && weekday !== "*") {
		throw refused(expression, "sets both the day of month and the weekday, which runtimes combine differently")
	}
	const parsed: CronFields = {
		day: parseField(day, DAY, expression),
		hour: parseField(hour, HOUR, expression),
		minute: parseField(minute, MINUTE, expression),
		month: parseField(month, MONTH, expression),
		weekday: parseField(weekday, WEEKDAY, expression),
	}
	const latest = Math.max(...[...parsed.month].map((m) => DAYS_IN_MONTH[m - 1] as number))
	if (Math.min(...parsed.day) > latest) throw refused(expression, "names a date that never occurs")
	return parsed
}

/** Whether `fields` select the UTC minute `at` falls in. */
export function cronFires(fields: CronFields, at: Date): boolean {
	return (
		fields.minute.has(at.getUTCMinutes()) &&
		fields.hour.has(at.getUTCHours()) &&
		fields.day.has(at.getUTCDate()) &&
		fields.month.has(at.getUTCMonth() + 1) &&
		fields.weekday.has(at.getUTCDay())
	)
}
