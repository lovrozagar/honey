/**
 * metaSpec: the generate-time policy that turns route meta and route schemas into OpenAPI
 * operation fields. Never consulted at request time; what it finds goes to the diagnostics,
 * which the caller throws or reports.
 */
import {
	type MetaSpecConfig,
	type MetaSpecContext,
	type MetaSpecEntry,
	type MetaSpecProfile,
	type MetaSpecSchemaEntry,
	type MetaSpecSchemaSource,
	type MetaSpecStrictness,
	resolvedStrictness,
} from "./meta-spec-merge.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { checkTargetKey, type MetaSpecDiagnostics, type SchemaRead } from "./meta-spec-validate.ts"

export type {
	HoneyMetaSpec,
	MetaSpecConfig,
	MetaSpecContext,
	MetaSpecEntry,
	MetaSpecSchemaSearch,
	MetaSpecSchemaSource,
	MetaSpecStrictness,
	MetaSpecVersionGuard,
} from "./meta-spec-merge.ts"

export const DEFAULT_PROFILE = "default"

const isName = (value: unknown): value is string => typeof value === "string" && value !== ""
const isGroup = (value: unknown): value is string[] => Array.isArray(value) && value.every(isName)

/** `{ scheme: scopes[] }`: scheme names mapped to lists of scope names. */
function isRequirement(entry: unknown): boolean {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false
	return Object.entries(entry).every(
		([scheme, scopes]) => scheme !== "" && Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string"),
	)
}

/**
 * Security shorthand → OpenAPI requirements: a name, alternative names, groups of names, or
 * requirement objects; `[]` is explicitly public. Anything else throws: a guess would document
 * a protected route as public.
 */
export function normalizeSecurity(raw: unknown): Record<string, string[]>[] {
	if (typeof raw === "string") {
		if (raw === "") throw new TypeError("security: a scheme name cannot be empty")
		return [{ [raw]: [] }]
	}
	if (!Array.isArray(raw))
		throw new TypeError(`security: expected a scheme name or an array, got ${raw === null ? "null" : typeof raw}`)
	if (raw.every(isName)) return raw.map((scheme) => ({ [scheme]: [] }))
	if (raw.every(isGroup)) return raw.map((group) => Object.fromEntries(group.map((scheme) => [scheme, []])))
	if (raw.every(isRequirement)) return raw as Record<string, string[]>[]
	throw new TypeError(
		"security: entries must all be scheme names, all groups of scheme names, or all { scheme: scopes[] } requirement objects — mixed or malformed entries are refused",
	)
}

/** The scheme names a security list refers to, once each. */
export function securitySchemeNames(security: unknown): string[] {
	if (!Array.isArray(security)) return []
	return [
		...new Set(
			security.flatMap((requirement: unknown) => (requirement instanceof Object ? Object.keys(requirement) : [])),
		),
	]
}

export type Produce = (value: unknown, ctx: MetaSpecContext) => Record<string, unknown> | undefined

export type CompiledEntry = SchemaRead & {
	readonly http: boolean
	/** the keys it declares, for duplicate detection; none for an expand */
	readonly keys: readonly string[]
	readonly produce: Produce
	readonly profiles: readonly string[] | null
	/** 1: read off a schema; 2: route meta, built-ins included; 3 is meta.extensions */
	readonly rank: 1 | 2
	readonly schema: StandardSchemaLike | null
	readonly sourceKey: string
	readonly ws: boolean
}

export type CompiledMetaSpec = {
	readonly entries: readonly CompiledEntry[]
	/** meta keys with an entry or hidden by design: what totality checks against */
	readonly known: ReadonlySet<string>
	/** whether any entry reads schemas, so a document builds the lookup only when needed */
	readonly needsSchemas: boolean
	readonly profiles: Readonly<Record<string, MetaSpecProfile>>
	readonly strict: MetaSpecStrictness
}

/** Where a schema entry without `from` looks, in order. */
const SOURCES: readonly MetaSpecSchemaSource[] = [
	"output",
	"input.json",
	"input.search",
	"input.form",
	"input.headers",
	"input.cookies",
]

/** Meta keys that never reach a document, policy or none. */
const HIDDEN: readonly string[] = ["internal", "extensions"]

const UNREAD = { from: SOURCES, match: null, profiles: null, schema: null, search: "root", version: null } as const

const truthy =
	(key: string): Produce =>
	(value) =>
		value ? { [key]: value } : undefined

function builtin(key: string, target: string, produce: Produce, ws: boolean): CompiledEntry {
	return { ...UNREAD, http: true, keys: [target], produce, rank: 2, read: key, sourceKey: key, ws }
}

const invalidate: Produce = (value) =>
	Array.isArray(value) && value.length > 0 ? { "x-invalidate": [...new Set(value)] } : undefined

/** The eight mappings every app has, in their emit order. */
function builtins(): CompiledEntry[] {
	return [
		builtin("summary", "summary", truthy("summary"), true),
		builtin("description", "description", truthy("description"), true),
		builtin(
			"tags",
			"tags",
			(value) => (value ? { tags: typeof value === "string" ? [value] : value } : undefined),
			true,
		),
		builtin("deprecated", "deprecated", truthy("deprecated"), false),
		builtin("operationId", "operationId", truthy("operationId"), true),
		builtin("security", "security", (value) => (value ? { security: normalizeSecurity(value) } : undefined), false),
		builtin("invalidate", "x-invalidate", invalidate, false),
		builtin("mcp", "x-mcp", (value) => (value === true ? { "x-mcp": true } : undefined), false),
	]
}

function compileEntry(
	key: string,
	entry: MetaSpecEntry<never> | MetaSpecSchemaEntry<never>,
	rank: 1 | 2,
	diagnostics: MetaSpecDiagnostics,
): CompiledEntry | null {
	const where = `${rank === 1 ? "schema" : "meta"}."${key}"`
	if (entry === false) return null
	if (typeof entry === "string") {
		if (!checkTargetKey(entry, where, diagnostics)) return null
		const produce: Produce = (value) => (value === undefined ? undefined : { [entry]: value })
		return { ...UNREAD, http: true, keys: [entry], produce, rank, read: key, sourceKey: key, ws: true }
	}
	const read = entry as MetaSpecSchemaEntry<never>
	const base = {
		from: read.from ?? SOURCES,
		http: entry.on !== "ws",
		match: read.match ?? null,
		profiles: entry.profiles ?? null,
		rank,
		read: read.read ?? key,
		schema: entry.schema ?? null,
		search: read.search ?? "root",
		sourceKey: key,
		version: read.version ?? null,
		ws: entry.on !== "http",
	}
	if ("expand" in entry) {
		const expand = entry.expand as Produce
		const produce: Produce = (value, ctx) => {
			const out = expand(value, ctx)
			if (out === undefined) return undefined
			const kept = Object.entries(out).filter(
				([target, produced]) => produced !== undefined && checkTargetKey(target, `${where} (expand)`, diagnostics),
			)
			return kept.length > 0 ? Object.fromEntries(kept) : undefined
		}
		return { ...base, keys: [], produce }
	}
	if (!checkTargetKey(entry.key, where, diagnostics)) return null
	const { key: target } = entry
	const map = entry.map as ((value: unknown, ctx: MetaSpecContext) => unknown) | undefined
	const produce: Produce = (value, ctx) => {
		const mapped = map === undefined ? value : map(value, ctx)
		return mapped === undefined ? undefined : { [target]: mapped }
	}
	return { ...base, keys: [target], produce }
}

/** Whether two entries ever write to one operation: their targets and profiles overlap. */
function overlap(a: CompiledEntry, b: CompiledEntry): boolean {
	if (!((a.http && b.http) || (a.ws && b.ws))) return false
	return a.profiles === null || b.profiles === null || a.profiles.some((name) => b.profiles?.includes(name))
}

function detectDuplicates(entries: readonly CompiledEntry[], diagnostics: MetaSpecDiagnostics): void {
	const byKey = new Map<string, CompiledEntry[]>()
	for (const entry of entries) {
		for (const key of entry.keys) {
			const prior = byKey.get(`${entry.rank} ${key}`) ?? []
			const clash = prior.find((other) => other.sourceKey !== entry.sourceKey && overlap(other, entry))
			if (clash === undefined) byKey.set(`${entry.rank} ${key}`, [...prior, entry])
			else {
				const both = `"${clash.sourceKey}" and "${entry.sourceKey}"`
				diagnostics.add("DUPLICATE_TARGET", "error", `${both} both write operation key "${key}" at the same precedence`)
			}
		}
	}
}

const CONFLICT = {
	hidden:
		"a mounted sub-app hides this key, so it is hidden here too — hiding wins over a parent entry, because a leak is worse than a missing tag",
	parent:
		"a mounted sub-app declares a different entry; this app's entry wins for this document. The sub-app's own document still uses its own entry",
} as const

/** `config` ready to apply: built-ins (an app entry takes its slot), app entries, then schema entries. */
export function compileMetaSpec(config: MetaSpecConfig | null, diagnostics: MetaSpecDiagnostics): CompiledMetaSpec {
	const overrides = config?.meta ?? {}
	const known = new Set(HIDDEN)
	const compile = (key: string, entry: MetaSpecEntry<never>, rank: 1 | 2) => compileEntry(key, entry, rank, diagnostics)
	const meta = [
		...builtins().map((entry) =>
			Object.hasOwn(overrides, entry.sourceKey) ? compile(entry.sourceKey, overrides[entry.sourceKey], 2) : entry,
		),
		...Object.entries(overrides)
			.filter(([key]) => !builtins().some((entry) => entry.sourceKey === key))
			.map(([key, entry]) => compile(key, entry, 2)),
	]
	for (const key of [...builtins().map(({ sourceKey }) => sourceKey), ...Object.keys(overrides)]) known.add(key)
	const schema = Object.entries(config?.schema ?? {}).map(([key, entry]) => compile(key, entry, 1))
	const entries = [...meta, ...schema].filter((entry): entry is CompiledEntry => entry !== null)
	detectDuplicates(entries, diagnostics)
	for (const { key, resolution, section } of config?.conflicts ?? []) {
		diagnostics.add("SUBAPP_ENTRY_CONFLICT", "warn", `${section}."${key}": ${CONFLICT[resolution]}`)
	}
	return {
		entries,
		known,
		needsSchemas: schema.length > 0,
		profiles: config?.profiles ?? {},
		strict: resolvedStrictness(config),
	}
}

/** The meta keys a published manifest may carry: built-ins and keys with an entry, never a hidden one. */
export function publishableMetaKeys(config: MetaSpecConfig | null): (key: string) => boolean {
	const allowed = new Set(builtins().map(({ sourceKey }) => sourceKey))
	for (const [key, entry] of Object.entries(config?.meta ?? {})) {
		if (entry === false) allowed.delete(key)
		else allowed.add(key)
	}
	return (key) => allowed.has(key) && !HIDDEN.includes(key)
}

/** The filter of the document's profile: `exclude` drops keys, `include` allowlists `x-` keys. */
export function resolveProfile(
	spec: CompiledMetaSpec,
	profile: string | undefined,
	diagnostics: MetaSpecDiagnostics,
): { readonly filter: (key: string) => boolean; readonly name: string } {
	const name = profile ?? DEFAULT_PROFILE
	const declared = Object.hasOwn(spec.profiles, name) ? spec.profiles[name] : undefined
	if (declared === undefined) {
		if (name !== DEFAULT_PROFILE) {
			diagnostics.add(
				"UNKNOWN_PROFILE",
				"error",
				`document requests profile "${name}", which is not declared in metaSpec.profiles`,
			)
		}
		return { filter: () => true, name }
	}
	const { exclude = [], include } = declared
	const filter = (key: string) =>
		!exclude.includes(key) && (include === undefined || !key.startsWith("x-") || include.includes(key))
	return { filter, name }
}
