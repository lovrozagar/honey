/**
 * The metaSpec checks: the diagnostics a policy run collects (never printed: the caller throws
 * the errors and reports the warnings), the gate on what a policy may write, the check of each
 * produced value, and reading a descriptor off a route's JSON Schema.
 */
import type { JsonSchema } from "../schema/to-json-schema.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import type { MetaSpecSchemaSearch, MetaSpecSchemaSource, MetaSpecVersionGuard } from "./meta-spec.ts"

export type MetaSpecDiagnosticCode =
	| "AMBIGUOUS_SCHEMA_KEY"
	| "ASYNC_VALIDATION"
	| "DESCRIPTOR_MISMATCH"
	| "DUPLICATE_OPERATION_ID"
	| "DUPLICATE_TARGET"
	| "INVALID_SELECTOR"
	| "INVALID_VALUE"
	| "MAP_THREW"
	| "MISSING_ENTRY"
	| "RESERVED_FIELD"
	| "SCHEMA_DEGRADED"
	| "SCHEMA_FAILED"
	| "SUBAPP_ENTRY_CONFLICT"
	| "UNKNOWN_FIELD"
	| "UNKNOWN_PROFILE"
	| "UNKNOWN_SECURITY_SCHEME"
	| "UNSUPPORTED_VERSION"
	| "WS_SHADOWED"

export type MetaSpecDiagnostic = {
	readonly code: MetaSpecDiagnosticCode
	readonly level: "error" | "warn"
	readonly message: string
}

/** How many errors an aggregate error lists before it only counts. */
const LISTED = 20

/** What one policy run found: each code and message once, in order. */
export class MetaSpecDiagnostics {
	readonly list: MetaSpecDiagnostic[] = []
	/** meta keys already reported as unmapped: once, not once per route */
	readonly reportedMissing = new Set<string>()
	readonly #seen = new Set<string>()

	add(code: MetaSpecDiagnosticCode, level: "error" | "warn", message: string): void {
		const key = `${code}\u0000${message}`
		if (this.#seen.has(key)) return
		this.#seen.add(key)
		this.list.push({ code, level, message })
	}

	/** Throws one error naming every policy error; with none, the warnings for the caller to report. */
	throwIfErrors(): readonly MetaSpecDiagnostic[] {
		const errors = this.list.filter(({ level }) => level === "error")
		if (errors.length === 0) return this.list
		const shown = errors.slice(0, LISTED).map(({ code, message }) => `  - ${code}: ${message}`)
		const more = errors.length > LISTED ? `\n  … and ${errors.length - LISTED} more` : ""
		throw new Error(`[honey:metaSpec] ${errors.length} policy error(s):\n${shown.join("\n")}${more}`)
	}
}

/** Standard operation fields a policy may write. */
const STANDARD: readonly string[] = [
	"deprecated",
	"description",
	"externalDocs",
	"operationId",
	"security",
	"servers",
	"summary",
	"tags",
]

/** Fields the route's schemas and error keys own: a policy writing them would contradict the route. */
const RESERVED: readonly string[] = ["callbacks", "parameters", "requestBody", "responses"]

/** Whether a policy may write operation key `key`: an `x-` extension or an allowed standard field. */
export function checkTargetKey(key: string, where: string, diagnostics: MetaSpecDiagnostics): boolean {
	if (key.startsWith("x-") || STANDARD.includes(key)) return true
	if (RESERVED.includes(key)) {
		diagnostics.add("RESERVED_FIELD", "error", `${where} targets reserved operation field "${key}"`)
		return false
	}
	diagnostics.add(
		"UNKNOWN_FIELD",
		"error",
		`${where} targets "${key}", which is neither an "x-" extension nor an allowed standard field (${STANDARD.join(", ")})`,
	)
	return false
}

/** Whether `value` passes the entry's `schema`; validation at generate time is synchronous. */
export function validProduced(
	schema: StandardSchemaLike | null,
	value: unknown,
	where: string,
	diagnostics: MetaSpecDiagnostics,
): boolean {
	if (schema === null) return true
	const result = schema["~standard"].validate(value)
	if (result instanceof Promise) {
		diagnostics.add(
			"ASYNC_VALIDATION",
			"error",
			`${where} has an async output schema — generate-time validation is sync`,
		)
		return false
	}
	if (result.issues === undefined || result.issues.length === 0) return true
	const detail = result.issues
		.slice(0, 3)
		.map(({ message }) => message)
		.join("; ")
	diagnostics.add("INVALID_VALUE", "error", `${where} produced a value rejected by its schema: ${detail}`)
	return false
}

export type SchemaMetaHit =
	| { readonly found: "ambiguous"; readonly values: readonly unknown[] }
	| { readonly found: false }
	| { readonly found: true; readonly value: unknown }

/** The value of metadata key `key` on a route's schema of `source`. */
export type SchemaMetaLookup = (
	source: MetaSpecSchemaSource,
	key: string,
	search: MetaSpecSchemaSearch,
) => SchemaMetaHit

const NOT_FOUND: SchemaMetaHit = { found: false }

/** How many levels a deep search descends. */
const DEEP_LEVELS = 6

const isRecord = (value: unknown): value is JsonSchema =>
	value !== null && typeof value === "object" && !Array.isArray(value)

/** A schema's own value of `key`, when it has one. */
function own(schema: unknown, key: string): SchemaMetaHit {
	return isRecord(schema) && Object.hasOwn(schema, key) && schema[key] !== undefined
		? { found: true, value: schema[key] }
		: NOT_FOUND
}

/** The schemas directly under `schema`: its properties, items and composition members. */
function children(schema: JsonSchema): JsonSchema[] {
	const properties = isRecord(schema.properties) ? Object.values(schema.properties) : []
	const members = ["allOf", "anyOf", "oneOf", "prefixItems"].flatMap((key) => {
		const list = schema[key]
		return Array.isArray(list) ? list : []
	})
	return [...properties, schema.items, ...members].filter(isRecord)
}

/** The shallowest level holding `key`: one value found, or two different ones refused. */
function deepSearch(root: JsonSchema, key: string): SchemaMetaHit {
	let level = [root]
	for (let depth = 0; depth <= DEEP_LEVELS && level.length > 0; depth++) {
		const found = new Map<string, unknown>()
		for (const schema of level) {
			const hit = own(schema, key)
			if (hit.found === true) found.set(JSON.stringify(hit.value), hit.value)
		}
		if (found.size === 1) return { found: true, value: [...found.values()][0] }
		if (found.size > 1) return { found: "ambiguous", values: [...found.values()] }
		level = level.flatMap(children)
	}
	return NOT_FOUND
}

/**
 * A lookup over a route's schemas by source. A root search reads the schema, and for an array
 * its items one level down; a deep search walks properties, items and members to the shallowest hit.
 */
export function schemaMetaLookup(roots: Readonly<Partial<Record<MetaSpecSchemaSource, JsonSchema>>>): SchemaMetaLookup {
	return (source, key, search) => {
		const root = roots[source]
		if (root === undefined) return NOT_FOUND
		if (search === "deep") return deepSearch(root, key)
		const hit = own(root, key)
		return hit.found === false && root.type === "array" ? own(root.items, key) : hit
	}
}

/** Why a descriptor's version is refused, or `null` when this entry handles it. */
function refusedVersion(descriptor: unknown, guard: MetaSpecVersionGuard): string | null {
	const field = guard.field ?? "v"
	const version = isRecord(descriptor) ? descriptor[field] : undefined
	if (typeof version !== "number" || !Number.isInteger(version)) {
		return `with no integer \`${field}\` — cannot tell which contract it follows`
	}
	if (version <= guard.max) return null
	return `v${version} but handles up to v${guard.max} — refusing to emit a partly-understood tag`
}

/** Whether `descriptor` holds every key of `match` with its value: the discriminant of a union. */
function satisfiesMatch(descriptor: unknown, match: Readonly<Record<string, unknown>>): boolean {
	return isRecord(descriptor) && Object.entries(match).every(([key, value]) => descriptor[key] === value)
}

/** What a schema entry reads, and which descriptor it claims. */
export type SchemaRead = {
	readonly from: readonly MetaSpecSchemaSource[]
	readonly match: Readonly<Record<string, unknown>> | null
	readonly read: string
	readonly search: MetaSpecSchemaSearch
	readonly version: MetaSpecVersionGuard | null
}

/**
 * The descriptor a schema entry claims, searching its sources in order. One that fails `match`
 * is skipped, since a union puts its members on different schemas; but a descriptor nothing
 * claims is a build error, never a silently missing tag.
 */
export function claimDescriptor(
	entry: SchemaRead,
	lookup: SchemaMetaLookup,
	where: string,
	diagnostics: MetaSpecDiagnostics,
): { readonly source: MetaSpecSchemaSource; readonly value: unknown } | null {
	const unclaimed: MetaSpecSchemaSource[] = []
	for (const source of entry.from) {
		const hit = lookup(source, entry.read, entry.search)
		if (hit.found === false) continue
		if (hit.found === "ambiguous") {
			const count = hit.values.length
			diagnostics.add("AMBIGUOUS_SCHEMA_KEY", "error", `${where} matched ${count} different values under "${source}"`)
			return null
		}
		/* version before match: a newer contract may have redefined the discriminant itself */
		const refused = entry.version === null ? null : refusedVersion(hit.value, entry.version)
		if (refused !== null) {
			diagnostics.add("UNSUPPORTED_VERSION", "error", `${where} read a descriptor from "${source}" ${refused}`)
			return null
		}
		if (entry.match === null || satisfiesMatch(hit.value, entry.match)) return { source, value: hit.value }
		unclaimed.push(source)
	}
	if (unclaimed.length > 0) {
		const seen = unclaimed.map((source) => `"${source}"`).join(", ")
		diagnostics.add(
			"DESCRIPTOR_MISMATCH",
			"error",
			`${where} reads "${entry.read}" expecting ${JSON.stringify(entry.match)}, but the descriptor on ${seen} does not match`,
		)
	}
	return null
}
