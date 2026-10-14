/**
 * `serverTiming()`: `ctx.timing.start(name, description?)` and `end(name)` time the work a request
 * does, and the answer carries them as `Server-Timing`, a `total` last. A timing left open closes at
 * the answer; an `end` with no `start` is ignored. Names become tokens and descriptions quoted
 * strings, so no value can break the header. A `Server-Timing` set below (a handler, an upstream) is
 * kept, with these added after it.
 */
import { withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type Timing = {
	end(name: string): void
	start(name: string, description?: string): void
}

type TimingEntry = {
	description: string | undefined
	end: number | undefined
	start: number
}

/* metric names are RFC 9110 tokens; anything else becomes `_` */
const NON_TOKEN = /[^!#$%&'*+.^`|~\w-]/g
/* descriptions are quoted strings: latin1 only, no controls, `\` and `"` escaped */
const NON_QUOTABLE = /[^\t\x20-\x7e\x80-\xff]/g

function tokenOf(name: string): string {
	return name.replace(NON_TOKEN, "_") || "_"
}

function quoted(description: string): string {
	return `"${description.replace(NON_QUOTABLE, "?").replace(/[\\"]/g, "\\$&")}"`
}

/** The header value: each timing, then the total since `started`, all closed at `now`. */
function metrics(entries: Map<string, TimingEntry>, started: number, now: number): string {
	const parts: string[] = []
	for (const [name, entry] of entries) {
		const desc = entry.description ? `;desc=${quoted(entry.description)}` : ""
		parts.push(`${tokenOf(name)}${desc};dur=${((entry.end ?? now) - entry.start).toFixed(2)}`)
	}
	parts.push(`total;dur=${(now - started).toFixed(2)}`)
	return parts.join(", ")
}

export function serverTiming(): MiddlewareFn<{}, { timing: Timing }> {
	return namedMiddleware("serverTiming", async (_ctx, next) => {
		const started = performance.now()
		const entries = new Map<string, TimingEntry>()
		const timing: Timing = {
			end(name) {
				const entry = entries.get(name)
				if (entry) entry.end = performance.now()
			},
			start(name, description) {
				entries.set(name, { description, end: undefined, start: performance.now() })
			},
		}
		const response = await next({ timing })
		const value = metrics(entries, started, performance.now())
		/* get-then-set, not append: append would build native Headers on the plain path */
		return withHeaders(response, (headers) => {
			const upstream = headers.get("server-timing")
			headers.set("server-timing", upstream ? `${upstream}, ${value}` : value)
		})
	})
}
