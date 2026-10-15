/**
 * The metaSpec policy model, and its composition across mounted sub-apps. Kept apart from the
 * engine, so an app holds and merges policies without loading it.
 */
import { GRAPH } from "../routing/app.ts"
import type { OpenApiMeta } from "../routing/app-types.ts"
import type { HoneyGraph } from "../routing/register.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"

/** Where a schema entry reads its descriptor. */
export type MetaSpecSchemaSource =
	| "input.cookies"
	| "input.form"
	| "input.headers"
	| "input.json"
	| "input.search"
	| "output"

/** What a `map` or `expand` is told about the value it turns into operation fields. */
export type MetaSpecContext = {
	readonly meta: Readonly<Record<string, unknown>>
	readonly method: string
	readonly path: string
	readonly profile: string
	readonly source: "meta" | MetaSpecSchemaSource
}

type EntryBase = {
	/** the operations an entry applies to; default both */
	readonly on?: "both" | "http" | "ws"
	/** the documents an entry applies to; default every profile */
	readonly profiles?: readonly string[]
	/** checks the produced value at generate time; a failure is a build error */
	readonly schema?: StandardSchemaLike
}

/** An entry writing one operation key; a map answering undefined leaves it out. */
export type MetaSpecSingle<TValue = unknown> = EntryBase & {
	readonly key: string
	readonly map?: (value: TValue, ctx: MetaSpecContext) => unknown
}

/** An entry fanning one value out to several operation keys; undefined leaves a key, or all, out. */
export type MetaSpecExpand<TValue = unknown> = EntryBase & {
	readonly expand: (value: TValue, ctx: MetaSpecContext) => Record<string, unknown> | undefined
}

/** One entry: hidden (`false`), verbatim (`"x-foo"`), one key, or a fan-out. */
export type MetaSpecEntry<TValue = unknown> = false | MetaSpecExpand<TValue> | MetaSpecSingle<TValue> | string

/** `"root"`: the schema, or an array's items; `"deep"`: the shallowest hit anywhere below. */
export type MetaSpecSchemaSearch = "deep" | "root"

/** Refuse a descriptor from a publisher contract newer than `max`. */
export type MetaSpecVersionGuard = { readonly field?: string; readonly max: number }

/** An entry reading its value off a route schema's metadata rather than route meta. */
export type MetaSpecSchemaEntry<TValue = unknown> = (MetaSpecExpand<TValue> | MetaSpecSingle<TValue>) & {
	readonly from?: readonly MetaSpecSchemaSource[]
	/** the discriminant this entry claims, e.g. `{ kind: "entity" }` */
	readonly match?: Readonly<Record<string, unknown>>
	/** the metadata key to read; default the entry's name */
	readonly read?: string
	readonly search?: MetaSpecSchemaSearch
	readonly version?: MetaSpecVersionGuard
}

/** A per-document filter: `include` allowlists `x-` keys, `exclude` drops any key. */
export type MetaSpecProfile = { readonly exclude?: readonly string[]; readonly include?: readonly string[] }

export type MetaSpecStrictness = "error" | "off" | "warn"

/** A sub-app's entry that disagreed with its parent's: hidden (the sub's false won) or the parent's. */
export type MetaSpecMergeConflict = {
	readonly key: string
	readonly resolution: "hidden" | "parent"
	readonly section: "meta" | "profiles" | "schema"
}

type Sections<TMeta> = {
	readonly meta?: TMeta
	readonly profiles?: Readonly<Record<string, MetaSpecProfile>>
	readonly schema?: Readonly<Record<string, MetaSpecSchemaEntry<never>>>
	/** how a meta key without an entry is reported; default error */
	readonly strict?: MetaSpecStrictness
}

/** A policy as stored: untyped meta keys, and the conflicts a merge recorded. */
export type MetaSpecConfig = Sections<Readonly<Record<string, MetaSpecEntry<never>>>> & {
	readonly conflicts?: readonly MetaSpecMergeConflict[]
}

type Defined<T> = Exclude<T, undefined>

/** A policy for an app whose meta is `TMeta`: every key it adds needs an entry, built-ins may have one. */
export type HoneyMetaSpec<TMeta = unknown> = [TMeta] extends [never]
	? MetaSpecConfig
	: TMeta extends Record<string, unknown>
		? Sections<
				{ readonly [K in Extract<keyof TMeta, keyof OpenApiMeta>]?: MetaSpecEntry<Defined<TMeta[K]>> } & {
					readonly [K in Exclude<keyof TMeta, keyof OpenApiMeta>]-?: MetaSpecEntry<Defined<TMeta[K]>>
				}
			>
		: MetaSpecConfig

/** The strictness a declared policy runs with: `"error"` unless it says otherwise; `"off"` without one. */
export function resolvedStrictness(config: MetaSpecConfig | null): MetaSpecStrictness {
	return config === null ? "off" : (config.strict ?? "error")
}

/** Each key `sub` and `own` both hold with different entries, resolved to the parent. */
function overlaps(
	section: MetaSpecMergeConflict["section"],
	own: Readonly<Record<string, unknown>> | undefined,
	sub: Readonly<Record<string, unknown>> | undefined,
): MetaSpecMergeConflict[] {
	return Object.entries(sub ?? {})
		.filter(([key, entry]) => own?.[key] !== undefined && own[key] !== entry)
		.map(([key]) => ({ key, resolution: "parent", section }))
}

/**
 * A mounted sub-app's policy under its parent's. The parent wins a disagreement, so a gateway
 * keeps one answer for its document; but a sub's `false` wins over anything, because hiding is
 * a safety claim: wrongly hidden is a visible gap, wrongly published is a leak. Strictness is
 * the parent's resolved one, so a sub's `"off"` cannot downgrade it. Each disagreement is recorded.
 */
export function mergeMetaSpec(own: MetaSpecConfig | null, sub: MetaSpecConfig | null): MetaSpecConfig | null {
	if (sub === null) return own
	if (own === null) return sub
	const meta: Record<string, MetaSpecEntry<never>> = { ...sub.meta, ...own.meta }
	const conflicts: MetaSpecMergeConflict[] = [...(own.conflicts ?? []), ...(sub.conflicts ?? [])]
	for (const conflict of overlaps("meta", own.meta, sub.meta)) {
		const hides = sub.meta?.[conflict.key] === false && own.meta?.[conflict.key] !== false
		if (hides) meta[conflict.key] = false
		conflicts.push(hides ? { ...conflict, resolution: "hidden" } : conflict)
	}
	conflicts.push(...overlaps("schema", own.schema, sub.schema), ...overlaps("profiles", own.profiles, sub.profiles))
	return {
		conflicts,
		meta,
		profiles: { ...sub.profiles, ...own.profiles },
		schema: { ...sub.schema, ...own.schema },
		strict: resolvedStrictness(own),
	}
}

/** A policy as an app holds it: its own declaration and each mounted sub-app's source, merged on read. */
export type MetaSpecSource = {
	declared: MetaSpecConfig | null
	readonly absorbed: MetaSpecSource[]
}

function resolve(source: MetaSpecSource): MetaSpecConfig | null {
	return source.absorbed.reduce<MetaSpecConfig | null>(
		(merged, sub) => mergeMetaSpec(merged, resolve(sub)),
		source.declared,
	)
}

/** The policy `app` documents with: its own, with each mounted sub-app's merged in mount order. */
export function metaSpecOf(app: { readonly [GRAPH]: HoneyGraph }): MetaSpecConfig | null {
	return resolve(app[GRAPH].settings.metaSpec)
}
