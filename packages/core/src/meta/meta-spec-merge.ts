/**
 * The metaSpec policy model, and its composition across mounted sub-apps. Kept apart from the
 * engine, so an app holds and merges policies without loading it.
 */
import { GRAPH } from "../routing/app.ts"
import type { HoneyMeta } from "../routing/app-types.ts"
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

/** What a `map` or `expand` is told about the value it turns into operation fields; `TMeta` is the app's route meta. */
export type MetaSpecContext<TMeta = Record<string, unknown>> = {
	/** the route's whole meta, keys the policy hides included */
	readonly meta: Readonly<HoneyMeta<TMeta>>
	/** the operation's method in uppercase, or `"WS"` for a WebSocket route; an `all()` route is called once per method it documents */
	readonly method: string
	/** the route's pattern with parameters as `:name`, such as `/users/:id`; not the OpenAPI `{id}` form */
	readonly path: string
	/** the name of the document's profile; `"default"` when the document names none */
	readonly profile: string
	/** where the value came from: route meta, or a schema's metadata at that source */
	readonly source: "meta" | MetaSpecSchemaSource
}

/** The options every object entry shares; a `false` or string entry has none. */
type EntryBase = {
	/** the operations an entry applies to; default both */
	readonly on?: "both" | "http" | "ws"
	/** the documents an entry applies to; default every profile */
	readonly profiles?: readonly string[]
	/** checks the produced value at generate time; a failure is a build error */
	readonly schema?: StandardSchemaLike
}

/** An entry writing one operation key; a map answering undefined leaves it out. */
export type MetaSpecSingle<TValue = unknown, TMeta = Record<string, unknown>> = EntryBase & {
	/** the operation key to write: an `x-` key or one of `deprecated`, `description`, `externalDocs`, `operationId`, `security`, `servers`, `summary`, `tags`; any other key fails the document */
	readonly key: string
	/** turns the value into the key's value; with no `map` the value is written as is */
	readonly map?: (value: TValue, ctx: MetaSpecContext<TMeta>) => unknown
}

/** An entry fanning one value out to several operation keys; undefined leaves a key, or all, out. */
export type MetaSpecExpand<TValue = unknown, TMeta = Record<string, unknown>> = EntryBase & {
	/** returns the operation keys to write, limited as `MetaSpecSingle`'s `key` is; returning `undefined` writes nothing */
	readonly expand: (value: TValue, ctx: MetaSpecContext<TMeta>) => Record<string, unknown> | undefined
}

/** One entry: hidden (`false`), verbatim (`"x-foo"`), one key, or a fan-out. */
export type MetaSpecEntry<TValue = unknown, TMeta = Record<string, unknown>> =
	| false
	| MetaSpecExpand<TValue, TMeta>
	| MetaSpecSingle<TValue, TMeta>
	| string

/** `"root"`: the schema, or an array's items; `"deep"`: the shallowest hit anywhere below. */
export type MetaSpecSchemaSearch = "deep" | "root"

/** Refuse a descriptor from a publisher contract newer than `max`. */
export type MetaSpecVersionGuard = {
	/** the descriptor's field holding its integer version, `"v"` by default; a descriptor without an integer there fails the document */
	readonly field?: string
	/** the highest version the entry handles; a higher one fails the document */
	readonly max: number
}

/** An entry reading its value off a route schema's metadata rather than route meta. */
export type MetaSpecSchemaEntry<TValue = unknown> = (MetaSpecExpand<TValue> | MetaSpecSingle<TValue>) & {
	/** the sources to look in, in order, the first claimed descriptor winning; default `output` (the lowest 2xx JSON answer), then `input.json`, `input.search`, `input.form`, `input.headers`, `input.cookies` */
	readonly from?: readonly MetaSpecSchemaSource[]
	/** the discriminant this entry claims, e.g. `{ kind: "entity" }` */
	readonly match?: Readonly<Record<string, unknown>>
	/** the metadata key to read; default the entry's name */
	readonly read?: string
	/** how deep to look for the metadata; `"root"` by default */
	readonly search?: MetaSpecSchemaSearch
	/** refuses a descriptor the entry cannot handle, failing the document; by default every version is read */
	readonly version?: MetaSpecVersionGuard
}

/** A per-document filter: `include` allowlists `x-` keys, `exclude` drops any key. */
export type MetaSpecProfile = {
	/** operation keys the policy may not write to this document, `x-` or standard; wins over `include` */
	readonly exclude?: readonly string[]
	/** the only `x-` keys the policy may write to this document; unset allows all, and standard keys are not affected */
	readonly include?: readonly string[]
}

/** How a meta key without an entry is reported: `"error"` fails the document, `"warn"` warns, `"off"` stays silent. */
export type MetaSpecStrictness = "error" | "off" | "warn"

/** A sub-app's entry that disagreed with its parent's: hidden (the sub's false won) or the parent's. */
export type MetaSpecMergeConflict = {
	/** the meta key, profile name or schema entry name that disagreed */
	readonly key: string
	/** which entry won */
	readonly resolution: "hidden" | "parent"
	/** which part of the policy the entry is in */
	readonly section: "meta" | "profiles" | "schema"
}

/** The parts of a policy, with the type of its meta entries left to the caller. */
type Sections<TMeta> = {
	/** one entry for each route meta key */
	readonly meta?: TMeta
	/** per-document filters, by profile name */
	readonly profiles?: Readonly<Record<string, MetaSpecProfile>>
	/** entries read from schema metadata, by name */
	readonly schema?: Readonly<Record<string, MetaSpecSchemaEntry<never>>>
	/** how a meta key without an entry is reported; default error */
	readonly strict?: MetaSpecStrictness
}

/** A policy as stored: untyped meta keys, and the conflicts a merge recorded. */
export type MetaSpecConfig = Sections<Readonly<Record<string, MetaSpecEntry<never, never>>>> & {
	/** the disagreements recorded when sub-app policies were merged */
	readonly conflicts?: readonly MetaSpecMergeConflict[]
}

/** A meta key's value type, without the `undefined` an optional key adds. */
type Defined<T> = Exclude<T, undefined>

/** A policy for an app whose meta is `TMeta`: every key it adds needs an entry, built-ins may have one. */
export type HoneyMetaSpec<TMeta = unknown> = [TMeta] extends [never]
	? MetaSpecConfig
	: TMeta extends Record<string, unknown>
		? Sections<
				{ readonly [K in Extract<keyof TMeta, keyof HoneyMeta>]?: MetaSpecEntry<Defined<TMeta[K]>, TMeta> } & {
					/* a symbol key is honey's own marker (the chain-meta phantom), never a key a spec describes */
					readonly [K in Exclude<keyof TMeta, keyof HoneyMeta | symbol>]-?: MetaSpecEntry<Defined<TMeta[K]>, TMeta>
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
	const meta: Record<string, MetaSpecEntry<never, never>> = { ...sub.meta, ...own.meta }
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
	/** the policy this app declared itself, if any */
	declared: MetaSpecConfig | null
	/** the sources of the sub-apps mounted into this app */
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
