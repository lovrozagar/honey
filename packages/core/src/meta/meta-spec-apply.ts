/**
 * Applying a compiled metaSpec to one route: each entry's value, from route meta or the route's
 * schema metadata, turned into operation fields; then `meta.extensions`; then the totality check.
 */
import type { CompiledEntry, CompiledMetaSpec } from "./meta-spec.ts"
import {
	claimDescriptor,
	type MetaSpecDiagnostics,
	type SchemaMetaLookup,
	validProduced,
} from "./meta-spec-validate.ts"

export type ApplyMetaSpecArgs = {
	readonly diagnostics: MetaSpecDiagnostics
	readonly filter: (key: string) => boolean
	readonly kind: "http" | "ws"
	readonly meta: Readonly<Record<string, unknown>> | null
	readonly method: string
	/** written in place */
	readonly operation: Record<string, unknown>
	readonly path: string
	readonly profile: string
	/** the route's schema metadata; schema entries are skipped without it */
	readonly schemaMeta?: SchemaMetaLookup
	readonly spec: CompiledMetaSpec
}

/** The value an entry turns into operation fields, and where it came from; `null` for none. */
function sourceOf(entry: CompiledEntry, args: ApplyMetaSpecArgs, where: string) {
	const meta = args.meta ?? {}
	if (entry.rank === 2)
		return Object.hasOwn(meta, entry.sourceKey) ? { source: "meta" as const, value: meta[entry.sourceKey] } : null
	return args.schemaMeta === undefined ? null : claimDescriptor(entry, args.schemaMeta, where, args.diagnostics)
}

/**
 * Write the operation fields `spec` derives for one route into `operation`. A key is written at
 * its first, highest-ranked contribution: route meta over schema metadata, `meta.extensions` over both.
 */
export function applyMetaSpec(args: ApplyMetaSpecArgs): void {
	const { diagnostics, method, operation, path, spec } = args
	const meta = args.meta ?? {}
	const written = new Map<string, readonly [rank: number, owner: string]>()
	const write = (key: string, value: unknown, rank: number, owner: string) => {
		const prior = written.get(key)
		if (!args.filter(key) || (prior !== undefined && prior[0] > rank)) return
		if (prior !== undefined && prior[0] === rank && prior[1] !== owner) {
			const both = `"${prior[1]}" and "${owner}"`
			diagnostics.add(
				"DUPLICATE_TARGET",
				"error",
				`${method} ${path}: ${both} both write operation key "${key}" at the same precedence`,
			)
			return
		}
		written.set(key, [rank, owner])
		operation[key] = value
	}
	for (const entry of spec.entries) {
		if (!(args.kind === "http" ? entry.http : entry.ws) || entry.profiles?.includes(args.profile) === false) continue
		const owner = `${entry.rank === 1 ? "schema" : "meta"}."${entry.sourceKey}"`
		const where = `${method} ${path} — ${owner}`
		const found = sourceOf(entry, args, where)
		if (found === null) continue
		let produced: Record<string, unknown> | undefined
		try {
			produced = entry.produce(found.value, { meta, method, path, profile: args.profile, source: found.source })
		} catch (error) {
			/* a policy error: the diagnostics carry it to the caller, whose throwIfErrors() fails the build */
			diagnostics.add("MAP_THREW", "error", `${where} threw: ${error instanceof Error ? error.message : String(error)}`)
			continue
		}
		if (produced === undefined) continue
		const checked = entry.keys.length === 1 ? produced[entry.keys[0] as string] : produced
		if (!validProduced(entry.schema, checked, where, diagnostics)) continue
		for (const [key, value] of Object.entries(produced)) write(key, value, entry.rank, owner)
	}
	writeExtensions(meta.extensions, args, (key, value) => write(key, value, 3, "meta.extensions"))
	checkTotality(meta, args)
}

/** `meta.extensions`: `x-` keys only, written above every entry. */
function writeExtensions(extensions: unknown, args: ApplyMetaSpecArgs, write: (key: string, value: unknown) => void) {
	if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) return
	for (const [key, value] of Object.entries(extensions)) {
		if (value === undefined) continue
		if (key.startsWith("x-")) write(key, value)
		else {
			const message = `${args.method} ${args.path} — meta.extensions may only set "x-" extensions, got "${key}"`
			args.diagnostics.add("UNKNOWN_FIELD", "error", message)
		}
	}
}

/** Under a declared policy, every meta key needs an entry: a key without one is reported once. */
function checkTotality(
	meta: Readonly<Record<string, unknown>>,
	{ diagnostics, method, path, spec }: ApplyMetaSpecArgs,
) {
	if (spec.strict === "off") return
	for (const key of Object.keys(meta)) {
		if (spec.known.has(key) || diagnostics.reportedMissing.has(key)) continue
		diagnostics.reportedMissing.add(key)
		const hint = "map it to an operation key or set it to `false` to hide it"
		diagnostics.add(
			"MISSING_ENTRY",
			spec.strict,
			`meta key "${key}" (first seen on ${method} ${path}) has no metaSpec entry — ${hint}`,
		)
	}
}
