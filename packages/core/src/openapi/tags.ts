/**
 * The document's tags: every tag an operation names, once, in the order operations first name
 * them, each merged with what the caller declares for it (description, externalDocs,
 * x-displayName). Tags are explicit: nothing is derived from paths. A declared tag no operation
 * names is not listed, and said; a tag declared twice is refused.
 */
import type { EmittedOperation } from "./paths.ts"

/** A link to documentation outside the document. */
export type OpenApiExternalDocs = {
	/** what the link leads to; CommonMark */
	readonly description?: string
	/** where the documentation is */
	readonly url: string
}

/** Metadata for a tag that operations name. A declared tag no operation names is left out, with a warning; declaring a name twice fails the document. */
export type OpenApiTag = {
	/** what the tag groups; CommonMark */
	readonly description?: string
	/** documentation outside the document */
	readonly externalDocs?: OpenApiExternalDocs
	/** the tag, as operations name it */
	readonly name: string
	/** a display label written to the document as is, for docs tools that read this extension */
	readonly "x-displayName"?: string
}

export type TagReport = (code: "INVALID_TAG" | "UNUSED_TAG", level: "error" | "warn", message: string) => void

/** The tags `operations` name, first-seen, with the declared metadata of each. */
export function tagsOf(
	operations: readonly EmittedOperation[],
	declared: readonly OpenApiTag[] | undefined,
	report: TagReport,
): OpenApiTag[] {
	const byName = new Map<string, OpenApiTag>()
	for (const tag of declared ?? []) {
		if (byName.has(tag.name)) report("INVALID_TAG", "error", `tag "${tag.name}" is declared twice`)
		else byName.set(tag.name, tag)
	}
	const named = new Set<string>()
	for (const { operation } of operations) {
		for (const name of Array.isArray(operation.tags) ? operation.tags : []) named.add(name as string)
	}
	for (const name of byName.keys()) {
		if (!named.has(name)) report("UNUSED_TAG", "warn", `tag "${name}" is declared but no operation names it`)
	}
	return [...named].map((name) => structuredClone(byName.get(name) ?? { name }))
}
