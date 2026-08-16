/**
 * Codegen-time check: mutations that declare no `invalidate`.
 *
 * This is a correctness signal, not a documentation one. `x-invalidate` drives generated SDK
 * behavior — the Rust and Go clients expand it into an invalidation post-flight and the Python
 * client reads it — so a mutation with no `invalidate` produces clients that refresh nothing
 * after the call. Create a row and the caller's cached collection still shows the old list.
 * Silent, and one per undeclared mutation.
 *
 * It warns and never blocks by default, because plenty of mutations correctly invalidate
 * nothing (login, logout, webhook receipt, a fire-and-forget job) and plenty of honey users
 * never generate an SDK. A rule that fails the build teaches people to paste the shortest token
 * that makes it pass, and then the annotation means "shut up" instead of "I considered this".
 */

/** How a missing `invalidate` is reported. Default `"warn"` */
export type InvalidateCheckLevel = "error" | "off" | "warn"

export type InvalidateCheckConfig =
	| {
			/**
			 * Operation extension identifying the entity an operation touches — e.g. `"x-entity"`
			 * if the app's metaSpec maps a publisher descriptor onto that key. When both a mutation
			 * and a read carry the same value under this key, that is a sharper signal than path
			 * shape. honey does not own the key's name; the app says which one it uses.
			 */
			entityKey?: string
			level?: InvalidateCheckLevel
	  }
	| InvalidateCheckLevel

export type InvalidateCheckOperation = {
	/** Lowercased HTTP method */
	method: string
	/** Route meta as authored, needed to tell "absent" from a deliberate "nothing" */
	meta: Record<string, unknown> | null
	/** The emitted operation object */
	operation: Record<string, unknown>
	/** OpenAPI-style path */
	path: string
}

const MUTATION_METHODS = new Set(["delete", "patch", "post", "put"])
const MAX_LISTED = 20

function resolveConfig(config: InvalidateCheckConfig | undefined): { entityKey?: string; level: InvalidateCheckLevel } {
	if (config === undefined) return { level: "warn" }
	if (typeof config === "string") return { level: config }
	return { entityKey: config.entityKey, level: config.level ?? "warn" }
}

/**
 * Did the author record a decision? `null` and `[]` both say "this mutation refreshes nothing",
 * which is a statement; absent says nothing at all, which is what this check is looking for.
 *
 * Neither reaches the document — `x-invalidate` is emitted only for a non-empty array — so this
 * costs a consumer nothing and changes no output.
 */
function declaredNothing(meta: Record<string, unknown> | null): boolean {
	if (!meta || !Object.hasOwn(meta, "invalidate")) return false
	const value = meta.invalidate
	return value === null || (Array.isArray(value) && value.length === 0)
}

function alreadyInvalidates(operation: Record<string, unknown>): boolean {
	const emitted = operation["x-invalidate"]
	return Array.isArray(emitted) && emitted.length > 0
}

/**
 * Paths a mutation plausibly affects: its own, and its collection when the mutation targets an
 * item. `DELETE /tables/{id}` affects `GET /tables/{id}` and `GET /tables`; `POST /auth/logout`
 * affects neither `GET /auth/logout` nor `GET /auth`, and so is never mentioned.
 */
function pathFamily(path: string): string[] {
	const family = [path]
	const segments = path.split("/")
	const last = segments[segments.length - 1]
	if (last !== undefined && last.startsWith("{") && last.endsWith("}") && segments.length > 2) {
		family.push(segments.slice(0, -1).join("/"))
	}
	return family
}

export type InvalidateFinding = {
	/** Read operations that make this mutation look like an oversight */
	affects: string[]
	method: string
	path: string
}

/** Mutations with no `invalidate` that the document suggests should have one. */
export function findMissingInvalidate(
	operations: readonly InvalidateCheckOperation[],
	entityKey: string | undefined,
): InvalidateFinding[] {
	const readPaths = new Set<string>()
	const readsByEntity = new Map<string, string[]>()

	for (const entry of operations) {
		if (entry.method !== "get") continue
		readPaths.add(entry.path)
		if (entityKey === undefined) continue
		const entity = entry.operation[entityKey]
		if (entity === undefined || entity === null) continue
		const id = JSON.stringify(entity)
		const list = readsByEntity.get(id)
		if (list) list.push(`GET ${entry.path}`)
		else readsByEntity.set(id, [`GET ${entry.path}`])
	}

	const findings: InvalidateFinding[] = []
	for (const entry of operations) {
		if (!MUTATION_METHODS.has(entry.method)) continue
		if (alreadyInvalidates(entry.operation)) continue
		if (declaredNothing(entry.meta)) continue

		let affects: string[] = []
		const entity = entityKey === undefined ? undefined : entry.operation[entityKey]
		if (entity !== undefined && entity !== null) {
			/* sharper than path shape: the same entity is read somewhere else in the document */
			affects = readsByEntity.get(JSON.stringify(entity)) ?? []
		} else {
			affects = pathFamily(entry.path)
				.filter((candidate) => readPaths.has(candidate))
				.map((candidate) => `GET ${candidate}`)
		}

		if (affects.length > 0) {
			findings.push({ affects, method: entry.method.toUpperCase(), path: entry.path })
		}
	}
	return findings
}

function formatReport(findings: readonly InvalidateFinding[]): string {
	const width = Math.max(...findings.map((f) => f.method.length))
	const shown = findings
		.slice(0, MAX_LISTED)
		.map((f) => `  ${f.method.padEnd(width)} ${f.path} → ${f.affects.join(", ")}`)
	const more = findings.length > shown.length ? `\n  … and ${findings.length - shown.length} more` : ""
	return (
		`[honey:invalidate] ${findings.length} mutation(s) declare no \`invalidate\`, but the document has ` +
		`read routes they plausibly affect.\nGenerated SDK clients refresh nothing after these calls.\n` +
		`${shown.join("\n")}${more}\n` +
		"Declare the routes each one refreshes, or `invalidate: null` to record that it refreshes nothing."
	)
}

/**
 * Report mutations with no `invalidate`. One summary, never one line per operation — a warning
 * that fires 53 times gets filtered out of the log; one that fires once and lists 10 gets read.
 */
export function reportMissingInvalidate(
	operations: readonly InvalidateCheckOperation[],
	config: InvalidateCheckConfig | undefined,
): void {
	const { entityKey, level } = resolveConfig(config)
	if (level === "off") return

	const findings = findMissingInvalidate(operations, entityKey)
	if (findings.length === 0) return

	const report = formatReport(findings)
	if (level === "error") throw new Error(report)
	console.warn(report)
}
