/**
 * Composition of metaSpec policies across mounted sub-apps. Kept apart from the policy engine
 * so the app core can merge policies without loading the engine.
 */
import type { MetaSpecConfig, MetaSpecEntry, MetaSpecMergeConflict, MetaSpecStrictness } from "./types.ts"

/** The strictness a declared policy actually runs with: `"error"` unless it says otherwise. */
export function resolvedStrictness(config: MetaSpecConfig | null): MetaSpecStrictness {
	return config?.strict ?? (config ? "error" : "off")
}

/**
 * Merge a mounted sub-app's policy into a parent's.
 *
 * The parent wins on conflict, so one gateway keeps one answer for its aggregate document —
 * with a single exception. A sub entry of `false` wins over anything the parent says, because
 * hiding is a safety claim and the strictest claim has to survive composition: a worker that
 * declares a field unpublishable must not have the gateway publish it. Wrongly hidden is a
 * visible gap; wrongly published is a leak.
 *
 * Strictness is the parent's *resolved* setting: a parent that never wrote `strict` runs with
 * `"error"`, and a sub-app's `"off"` must not downgrade it. Every other disagreement is
 * recorded in `conflicts` and reported at codegen.
 *
 * Order-independent with respect to when the parent declares its own policy: callers may keep
 * the absorbed sub policies and merge them in at codegen time.
 */
export function mergeMetaSpec(own: MetaSpecConfig | null, sub: MetaSpecConfig | null): MetaSpecConfig | null {
	if (!sub) return own
	if (!own) return sub
	const conflicts: MetaSpecMergeConflict[] = [...(own.conflicts ?? []), ...(sub.conflicts ?? [])]

	const meta: Record<string, MetaSpecEntry> = { ...sub.meta, ...own.meta }
	for (const [key, subEntry] of Object.entries(sub.meta ?? {})) {
		const ownEntry = own.meta?.[key]
		if (ownEntry === undefined || ownEntry === subEntry) continue
		if (subEntry === false && ownEntry !== false) {
			meta[key] = false
			conflicts.push({ key, resolution: "hidden", section: "meta" })
			continue
		}
		conflicts.push({ key, resolution: "parent", section: "meta" })
	}

	const recordOverlap = (section: "profiles" | "schema", subSide: object, ownSide: object): void => {
		for (const [key, subEntry] of Object.entries(subSide)) {
			const ownEntry = (ownSide as Record<string, unknown>)[key]
			if (ownEntry === undefined || ownEntry === subEntry) continue
			conflicts.push({ key, resolution: "parent", section })
		}
	}
	recordOverlap("schema", sub.schema ?? {}, own.schema ?? {})
	recordOverlap("profiles", sub.profiles ?? {}, own.profiles ?? {})

	return {
		conflicts,
		meta,
		profiles: { ...sub.profiles, ...own.profiles },
		schema: { ...sub.schema, ...own.schema },
		strict: resolvedStrictness(own),
	}
}
