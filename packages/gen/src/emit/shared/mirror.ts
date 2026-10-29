/**
 * The safe mirror's name on every SDK's client (bit 21 i), and its one rule for a root group spelled the same: the
 * group is renamed so the mirror keeps its name, and the generation says so, never silently. Each language spells the
 * mirror its own way (TS and Python `safe`, Go and C# `Safe`, Rust and Java `safe()`) and calls `mirrorNotice` with
 * that spelling and the name its group is emitted as.
 */

/** The mirror's name before a language spells it. */
export const MIRROR = "safe"

/**
 * The notice `target`'s generation reports when its root group `group` is spelled like the mirror (`spelled`, the
 * language's spelling) and is emitted as `renamed` instead; null for any other group.
 */
export function mirrorNotice(target: string, spelled: string, group: string, renamed: string): string | null {
	if (group !== spelled) return null
	return `${target}: the root group "${group}" is emitted as "${renamed}": "${spelled}" is the client's safe mirror`
}
