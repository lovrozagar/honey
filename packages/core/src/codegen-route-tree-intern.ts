/**
 * Structural intern for generated route-tree modules.
 *
 * Handler objects stay unique (`.routeTree()` patches `fn`/`mw`/`iv`/`os` onto each
 * `H*`). Values they point at — JSON Schema subtrees, meta objects, selector strings,
 * error-key arrays — are shared by identity when their JSON is identical.
 */

export type ForcedPrefix = "I" | "M" | "O" | "P"

const STRING_MIN = 8
const NUMBER_MIN = 8

function canonical(v: unknown): string {
	if (v === undefined) return "__undefined__"
	return JSON.stringify(v) as string
}

function valueDepth(v: unknown): number {
	if (v === null || typeof v !== "object") return 0
	let max = 0
	if (Array.isArray(v)) {
		for (const x of v) {
			const d = valueDepth(x)
			if (d > max) max = d
		}
		return max + 1
	}
	for (const x of Object.values(v as Record<string, unknown>)) {
		if (x === undefined) continue
		const d = valueDepth(x)
		if (d > max) max = d
	}
	return max + 1
}

export class InternPool {
	private readonly counts = new Map<string, number>()
	private readonly firstSeen: string[] = []
	private readonly forced = new Set<string>()
	private readonly forcedPrefix = new Map<string, ForcedPrefix>()
	private readonly ids = new Map<string, string>()
	private readonly prefixCounters = new Map<string, number>()
	private readonly values = new Map<string, unknown>()
	private sealed = false

	count(v: unknown): void {
		if (v === null || v === undefined) return
		const t = typeof v
		if (t === "boolean") return
		if (t === "number") {
			if (Number.isFinite(v) && String(v).length >= NUMBER_MIN) this.bump(v)
			return
		}
		if (t === "string") {
			if ((v as string).length >= STRING_MIN) this.bump(v)
			return
		}
		if (t === "object") {
			this.bump(v)
			if (Array.isArray(v)) {
				for (const x of v) this.count(x)
				return
			}
			for (const x of Object.values(v as Record<string, unknown>)) {
				if (x !== undefined) this.count(x)
			}
		}
	}

	force(v: unknown, prefix: ForcedPrefix): void {
		if (v === null || v === undefined) return
		const c = canonical(v)
		if (!this.values.has(c)) {
			this.values.set(c, v)
			this.firstSeen.push(c)
			this.counts.set(c, this.counts.get(c) ?? 1)
		}
		this.forced.add(c)
		if (!this.forcedPrefix.has(c)) this.forcedPrefix.set(c, prefix)
	}

	seal(): void {
		if (this.sealed) return
		this.sealed = true
		for (const c of this.firstSeen) {
			const v = this.values.get(c)
			if (!this.shouldIntern(v)) continue
			const prefix = this.prefixFor(c, v)
			const n = this.prefixCounters.get(prefix) ?? 0
			this.prefixCounters.set(prefix, n + 1)
			this.ids.set(c, `${prefix}${n}`)
		}
	}

	id(v: unknown): string | undefined {
		if (v === undefined) return undefined
		return this.ids.get(canonical(v))
	}

	expr(v: unknown): string {
		if (v === undefined) return "undefined"
		const ref = this.ids.get(canonical(v))
		if (ref !== undefined) return ref
		return this.printExpanded(v)
	}

	emitConstLines(): string[] {
		const items: Array<{ c: string; depth: number; id: string; seen: number; v: unknown }> = []
		for (const [c, id] of this.ids) {
			const v = this.values.get(c)
			items.push({ c, depth: valueDepth(v), id, seen: this.firstSeen.indexOf(c), v })
		}
		items.sort((a, b) => a.depth - b.depth || a.seen - b.seen || a.id.localeCompare(b.id))
		return items.map((it) => {
			const kind = this.forcedPrefix.get(it.c)
			let rhs = this.printExpanded(it.v)
			if (kind === "I") rhs += ' as unknown as RouteHandler["iv"]'
			else if (kind === "O") rhs += ' as unknown as RouteHandler["os"]'
			return `const ${it.id} = ${rhs}`
		})
	}

	private shouldIntern(v: unknown): boolean {
		if (v === null || v === undefined) return false
		const c = canonical(v)
		if (this.forced.has(c)) return true
		const n = this.counts.get(c) ?? 0
		if (n < 2) return false
		const t = typeof v
		if (t === "string") return (v as string).length >= STRING_MIN
		if (t === "number") return Number.isFinite(v) && String(v).length >= NUMBER_MIN
		if (Array.isArray(v) && v.length === 0) return false
		return t === "object"
	}

	private prefixFor(c: string, v: unknown): string {
		const forced = this.forcedPrefix.get(c)
		if (forced !== undefined) return forced
		if (typeof v === "string") return "T"
		if (typeof v === "number") return "U"
		if (Array.isArray(v)) return "A"
		return "J"
	}

	private bump(v: unknown): void {
		const c = canonical(v)
		const n = (this.counts.get(c) ?? 0) + 1
		this.counts.set(c, n)
		if (n === 1) {
			this.values.set(c, v)
			this.firstSeen.push(c)
		}
	}

	private printExpanded(v: unknown): string {
		if (v === null) return "null"
		if (v === true) return "true"
		if (v === false) return "false"
		const t = typeof v
		if (t === "string") return JSON.stringify(v)
		if (t === "number") return String(v)
		if (Array.isArray(v)) return `[${v.map((x) => this.expr(x)).join(",")}]`
		if (t === "object") {
			const obj = v as Record<string, unknown>
			const keys = Object.keys(obj).filter((k) => obj[k] !== undefined)
			return `{${keys.map((k) => `${JSON.stringify(k)}:${this.expr(obj[k])}`).join(",")}}`
		}
		return JSON.stringify(v) ?? "undefined"
	}
}
