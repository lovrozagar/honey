/**
 * Interning for generated route-tree modules: route data (meta objects, route ids, error-key
 * lists) whose JSON is equal is declared once as a `const` and shared by name. Callers refuse
 * values JSON cannot carry first, so equal JSON always means equal values.
 */

/** The name prefix a caller forces on a value: `M` for meta, `P` for a route id. */
export type ForcedPrefix = "M" | "P"

/* shorter strings and numbers cost less inline than a name */
const STRING_MIN = 8
const NUMBER_MIN = 8

/** How deeply `value` nests: 0 for a primitive. */
function depthOf(value: unknown): number {
	if (value === null || typeof value !== "object") return 0
	const children = (Array.isArray(value) ? value : Object.values(value)).filter((child) => child !== undefined)
	return Math.max(0, ...children.map(depthOf)) + 1
}

/** Whether a primitive is worth naming: a long string or a long finite number. */
function worthNaming(value: unknown): boolean {
	if (typeof value === "string") return value.length >= STRING_MIN
	return typeof value === "number" && Number.isFinite(value) && String(value).length >= NUMBER_MIN
}

/** A key in an object literal; a quoted "__proto__" would set the prototype, a computed one defines a property. */
function keyName(key: string): string {
	return key === "__proto__" ? '["__proto__"]' : JSON.stringify(key)
}

/** Collects route data, decides what repeats, then prints each value: by name when shared, else in full. */
export class InternPool {
	readonly #counts = new Map<string, number>()
	/** each canonical key in first-seen order, and its position */
	readonly #order: string[] = []
	readonly #seenAt = new Map<string, number>()
	/** an object's canonical key, computed once; its children appear in it by their own short keys */
	readonly #objectKeys = new WeakMap<object, string>()
	/** a short key per distinct structure, so a parent's key never repeats a whole subtree */
	readonly #structures = new Map<string, string>()
	readonly #forced = new Map<string, ForcedPrefix>()
	readonly #ids = new Map<string, string>()
	readonly #values = new Map<string, unknown>()
	#sealed = false

	/** Count one appearance of `value` and of every long string, number and object inside it. */
	count(value: unknown): void {
		if (value === null || typeof value === "boolean" || value === undefined) return
		if (typeof value !== "object") {
			if (worthNaming(value)) this.#bump(value)
			return
		}
		this.#bump(value)
		for (const child of Array.isArray(value) ? value : Object.values(value)) if (child !== undefined) this.count(child)
	}

	/** Name `value` whatever its count, with `prefix` (the first one forced wins). */
	force(value: unknown, prefix: ForcedPrefix): void {
		if (value === null || value === undefined) return
		const key = this.#canonical(value)
		if (!this.#values.has(key)) this.#remember(key, value)
		if (!this.#forced.has(key)) this.#forced.set(key, prefix)
	}

	/** Fix the names: each value worth sharing, in first-seen order, numbered per prefix. Idempotent. */
	seal(): void {
		if (this.#sealed) return
		this.#sealed = true
		const counters = new Map<string, number>()
		for (const key of this.#order) {
			const value = this.#values.get(key)
			if (!this.#shared(key, value)) continue
			const prefix =
				this.#forced.get(key) ??
				(typeof value === "string" ? "T" : typeof value === "number" ? "U" : Array.isArray(value) ? "A" : "J")
			const n = counters.get(prefix) ?? 0
			counters.set(prefix, n + 1)
			this.#ids.set(key, `${prefix}${n}`)
		}
	}

	/** The name `value` is declared under, if it is shared. */
	id(value: unknown): string | undefined {
		return value === undefined ? undefined : this.#ids.get(this.#canonical(value))
	}

	/** `value` as an expression: its name when shared, else its literal with shared parts by name. */
	expr(value: unknown): string {
		return this.id(value) ?? this.#literal(value)
	}

	/** The `const` declarations, shallowest first, so each is declared before anything using it. */
	emitConstLines(): string[] {
		return [...this.#ids]
			.map(([key, id]) => ({ depth: depthOf(this.#values.get(key)), id, key, seen: this.#seenAt.get(key) as number }))
			.sort((a, b) => a.depth - b.depth || a.seen - b.seen)
			.map(({ id, key }) => `const ${id} = ${this.#literal(this.#values.get(key))}`)
	}

	#shared(key: string, value: unknown): boolean {
		if (this.#forced.has(key)) return true
		if ((this.#counts.get(key) as number) < 2) return false
		return typeof value === "object" ? !(Array.isArray(value) && value.length === 0) : true
	}

	#remember(key: string, value: unknown): void {
		this.#values.set(key, value)
		this.#seenAt.set(key, this.#order.length)
		this.#order.push(key)
	}

	#bump(value: unknown): void {
		const key = this.#canonical(value)
		const n = (this.#counts.get(key) ?? 0) + 1
		this.#counts.set(key, n)
		if (n === 1 && !this.#values.has(key)) this.#remember(key, value)
	}

	/** Equal JSON, equal key: an object's key names its children by their keys, so it is computed once per object. */
	#canonical(value: unknown): string {
		if (value === null || typeof value !== "object") return JSON.stringify(value)
		const memo = this.#objectKeys.get(value)
		if (memo !== undefined) return memo
		const key = (child: unknown) => (child === undefined ? "null" : this.#canonical(child))
		const structure = Array.isArray(value)
			? `[${value.map(key).join(",")}]`
			: `{${Object.entries(value)
					.filter(([, child]) => child !== undefined)
					.map(([name, child]) => `${JSON.stringify(name)}:${key(child)}`)
					.join(",")}}`
		const id = this.#structures.get(structure) ?? `#${this.#structures.size}`
		this.#structures.set(structure, id)
		this.#objectKeys.set(value, id)
		return id
	}

	#literal(value: unknown): string {
		if (value === undefined) return "undefined"
		if (value === null || typeof value !== "object") return JSON.stringify(value)
		if (Array.isArray(value)) return `[${value.map((child) => this.expr(child)).join(",")}]`
		const entries = Object.entries(value).filter(([, child]) => child !== undefined)
		return `{${entries.map(([key, child]) => `${keyName(key)}:${this.expr(child)}`).join(",")}}`
	}
}
