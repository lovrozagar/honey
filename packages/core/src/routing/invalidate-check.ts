/**
 * Codegen-time check: mutations that declare no `invalidate`.
 *
 * A correctness signal, not a documentation one: `x-invalidate` drives generated SDK behavior (the
 * Rust and Go clients expand it into an invalidation post-flight, the Python client reads it), so a
 * mutation with no `invalidate` produces clients that refresh nothing after the call.
 *
 * It warns and never blocks by default: plenty of mutations correctly invalidate nothing (login,
 * logout, webhook receipt) and plenty of honey users never generate an SDK. A rule that fails the
 * build teaches people to paste the shortest token that makes it pass. This module only decides;
 * the OpenAPI emitter throws or logs the report.
 */

/** How a missing `invalidate` is reported. Default `"warn"`. */
export type InvalidateCheckLevel = "error" | "off" | "warn"

export type InvalidateCheckConfig =
	| {
			/**
			 * Operation extension naming the entity an operation touches, e.g. `"x-entity"`. A mutation and
			 * a read carrying the same value is a sharper signal than path shape. honey does not own the
			 * key's name; the app says which one it uses.
			 */
			entityKey?: string
			level?: InvalidateCheckLevel
	  }
	| InvalidateCheckLevel

export type InvalidateCheckOperation = {
	/** lowercased HTTP method */
	method: string
	/** route meta as authored, to tell "absent" from a deliberate "nothing" */
	meta: Record<string, unknown> | null
	/** the emitted operation object */
	operation: Record<string, unknown>
	/** OpenAPI-style path */
	path: string
}

export type InvalidateFinding = {
	/** read operations that make this mutation look like an oversight */
	affects: string[]
	method: string
	path: string
}

const MUTATION_METHODS: readonly string[] = ["delete", "patch", "post", "put"]
const MAX_LISTED = 20

function resolveConfig(config: InvalidateCheckConfig | undefined): { entityKey?: string; level: InvalidateCheckLevel } {
	if (config === undefined) return { level: "warn" }
	if (typeof config === "string") return { level: config }
	return { entityKey: config.entityKey, level: config.level ?? "warn" }
}

/** The level an `invalidate` config reports at. */
export function invalidateLevel(config: InvalidateCheckConfig | undefined): InvalidateCheckLevel {
	return resolveConfig(config).level
}

/**
 * Did the author record a decision? `null` and `[]` both say "this mutation refreshes nothing";
 * absent says nothing at all, which is what this check looks for.
 */
function declaredNothing(meta: Record<string, unknown> | null): boolean {
	if (meta === null || !Object.hasOwn(meta, "invalidate")) return false
	const value = meta.invalidate
	return value === null || (Array.isArray(value) && value.length === 0)
}

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0

/** Declared in the meta, or emitted: a profile that leaves `x-invalidate` out must not make every mutation look undeclared. */
function alreadyInvalidates(entry: InvalidateCheckOperation): boolean {
	return nonEmpty(entry.meta?.invalidate) || nonEmpty(entry.operation["x-invalidate"])
}

/**
 * Paths a mutation plausibly affects: its own, and its collection when it targets an item.
 * `DELETE /tables/{id}` affects `GET /tables/{id}` and `GET /tables`.
 */
function pathFamily(path: string): string[] {
	const segments = path.split("/")
	const last = segments.at(-1) as string
	const item = last.startsWith("{") && last.endsWith("}") && segments.length > 2
	return item ? [path, segments.slice(0, -1).join("/")] : [path]
}

function entityOf(entry: InvalidateCheckOperation, entityKey: string | undefined): string | null {
	const entity = entityKey === undefined ? undefined : entry.operation[entityKey]
	return entity === undefined || entity === null ? null : JSON.stringify(entity)
}

function readIndex(operations: readonly InvalidateCheckOperation[], entityKey: string | undefined) {
	const paths = new Set<string>()
	const byEntity = new Map<string, string[]>()
	for (const entry of operations.filter((o) => o.method === "get")) {
		paths.add(entry.path)
		const entity = entityOf(entry, entityKey)
		if (entity !== null) byEntity.set(entity, [...(byEntity.get(entity) ?? []), `GET ${entry.path}`])
	}
	return { byEntity, paths }
}

/** Mutations with no `invalidate` that the document suggests should have one. */
export function findMissingInvalidate(
	operations: readonly InvalidateCheckOperation[],
	entityKey: string | undefined,
): InvalidateFinding[] {
	const reads = readIndex(operations, entityKey)
	const undeclared = operations.filter(
		(e) => MUTATION_METHODS.includes(e.method) && !alreadyInvalidates(e) && !declaredNothing(e.meta),
	)
	return undeclared.flatMap((entry) => {
		const entity = entityOf(entry, entityKey)
		/* the same entity read elsewhere is sharper than path shape; with no tagged reader, path shape still speaks */
		const byEntity = entity === null ? [] : (reads.byEntity.get(entity) ?? [])
		const affects =
			byEntity.length > 0
				? byEntity
				: pathFamily(entry.path)
						.filter((p) => reads.paths.has(p))
						.map((p) => `GET ${p}`)
		return affects.length === 0 ? [] : [{ affects, method: entry.method.toUpperCase(), path: entry.path }]
	})
}

/**
 * The report for mutations with no `invalidate`, or `null` when the check is off or finds nothing.
 * One summary, never one line per operation: a warning that fires 53 times gets filtered out of
 * the log; one that fires once and lists 10 gets read.
 */
export function missingInvalidateReport(
	operations: readonly InvalidateCheckOperation[],
	config: InvalidateCheckConfig | undefined,
): string | null {
	const { entityKey, level } = resolveConfig(config)
	if (level === "off") return null
	const findings = findMissingInvalidate(operations, entityKey)
	if (findings.length === 0) return null
	const width = Math.max(...findings.map((f) => f.method.length))
	const shown = findings
		.slice(0, MAX_LISTED)
		.map((f) => `  ${f.method.padEnd(width)} ${f.path} → ${f.affects.join(", ")}`)
	const more = findings.length > shown.length ? `\n  … and ${findings.length - shown.length} more` : ""
	return (
		`[honey:invalidate] ${findings.length} mutation(s) declare no \`invalidate\`, but the document has ` +
		"read routes they plausibly affect.\nGenerated SDK clients refresh nothing after these calls.\n" +
		`${shown.join("\n")}${more}\n` +
		"Declare the routes each one refreshes, or `invalidate: null` to record that it refreshes nothing."
	)
}

/**
 * `invalidate` selectors that name no route. A selector is `"<METHOD> <pattern>"`, exactly as the
 * generated `RouteSelector` union spells it; anything else invalidates nothing at runtime.
 */
export function findInvalidSelectors(
	operations: readonly InvalidateCheckOperation[],
	inventory: ReadonlySet<string>,
): Array<{ method: string; path: string; selector: unknown }> {
	const out: Array<{ method: string; path: string; selector: unknown }> = []
	const seen = new Set<string>()
	for (const entry of operations) {
		const declared = entry.meta?.invalidate
		if (!Array.isArray(declared)) continue
		for (const selector of declared) {
			const key = `${entry.method} ${entry.path} ${String(selector)}`
			if ((typeof selector === "string" && inventory.has(selector)) || seen.has(key)) continue
			seen.add(key)
			out.push({ method: entry.method.toUpperCase(), path: entry.path, selector })
		}
	}
	return out
}
