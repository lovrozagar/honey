import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { withHeaders } from "./with-headers.ts"

export type Timing = {
	end(name: string): void
	start(name: string, description?: string): void
}

type TimingEntry = {
	description?: string
	end?: number
	start: number
}

/* metric names are RFC 9110 tokens; anything else becomes `_` */
const nonTokenRe = /[^!#$%&'*+.^`|~\w-]/g
function sanitizeName(name: string): string {
	const token = name.replace(nonTokenRe, "_")
	return token.length > 0 ? token : "_"
}

/* descriptions are quoted-strings: latin1 only, no controls, `\` and `"` escaped */
const nonQuotableRe = /[^\t\x20-\x7e\x80-\xff]/g
function escapeDescription(desc: string): string {
	return desc.replace(nonQuotableRe, "?").replace(/[\\"]/g, "\\$&")
}

export function serverTiming(): MiddlewareFn<{}, { timing: Timing }> {
	const mw: MiddlewareFn<{}, { timing: Timing }> = async (_ctx, next) => {
		const requestStart = performance.now()
		const entries = new Map<string, TimingEntry>()

		const timing: Timing = {
			end(name: string) {
				const entry = entries.get(name)
				if (entry) {
					entry.end = performance.now()
				}
			},
			start(name: string, description?: string) {
				entries.set(name, { description, start: performance.now() })
			},
		}

		const response = await next({ timing })

		/* auto-close any unclosed timings */
		const now = performance.now()
		const parts: string[] = []
		for (const [name, entry] of entries) {
			const dur = ((entry.end ?? now) - entry.start).toFixed(2)
			let part = sanitizeName(name)
			if (entry.description) {
				part += `;desc="${escapeDescription(entry.description)}"`
			}
			part += `;dur=${dur}`
			parts.push(part)
		}

		/* always include total request duration */
		const totalDur = (performance.now() - requestStart).toFixed(2)
		parts.push(`total;dur=${totalDur}`)

		/* append: an upstream or handler Server-Timing is kept */
		const value = parts.join(", ")
		return withHeaders(response, (headers) => headers.append("server-timing", value))
	}

	return namedMiddleware("serverTiming", mw)
}
