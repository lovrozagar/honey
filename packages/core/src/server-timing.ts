import type { MiddlewareFn } from "./middleware.ts"

export type Timing = {
	end(name: string): void
	start(name: string, description?: string): void
}

type TimingEntry = {
	description?: string
	end?: number
	start: number
}

/** Strip characters that would break Server-Timing header syntax */
const unsafeNameRe = /[;,="]/g
function sanitizeName(name: string): string {
	return name.replace(unsafeNameRe, "")
}

function escapeDescription(desc: string): string {
	return desc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
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

		response.headers.set("server-timing", parts.join(", "))

		return response
	}

	return mw
}
