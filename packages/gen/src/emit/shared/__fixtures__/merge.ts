/**
 * Several OpenAPI documents as one (contract 18 Fb5, contract 28 Fb14): every registry merges its v0 fixtures
 * through here, so one gate serves every merged spec, and a language's registry imports no other language's
 * fixture module (whose emitter would then enter its import closure and its CI cache key).
 */
type Json = Readonly<Record<string, unknown>>

/** `Kebab-key` as a component prefix: `form-body` → `FormBody`. */
const pascal = (key: string) =>
	key
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("")

/**
 * `value` with every `$ref` to a component renamed `<prefix><Name>`, every operationId `<key>.<id>` and every
 * `x-invalidate` target's path under `/<key>`.
 */
function prefixed(value: unknown, key: string, prefix: string): unknown {
	if (Array.isArray(value)) return value.map((item) => prefixed(item, key, prefix))
	if (value === null || typeof value !== "object") return value
	return Object.fromEntries(
		Object.entries(value).map(([name, item]) => {
			if (name === "$ref" && typeof item === "string")
				return [name, item.replace(/^(#\/components\/[^/]+\/)/, `$1${prefix}`)]
			if (name === "operationId" && typeof item === "string") return [name, `${key}.${item}`]
			if (name === "x-invalidate" && Array.isArray(item))
				return [
					name,
					item.map((target: unknown) => (typeof target === "string" ? target.replace(" /", ` /${key}/`) : target)),
				]
			return [name, prefixed(item, key, prefix)]
		}),
	)
}

/** `entries` as one object, throwing on a repeated name. */
function claimed(entries: readonly (readonly [string, unknown])[], what: string): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [name, value] of entries) {
		if (name in out) throw new Error(`merged: ${what} ${name} is claimed twice`)
		out[name] = value
	}
	return out
}

/**
 * `sources` as one document, each under its key: its paths under `/<key>`, its operationIds `<key>.<id>` (so
 * `IR.tree` nests them under the `<key>` namespace) and its components `<Key><Name>`, every `$ref` and
 * `x-invalidate` target rewritten to match; the first source's `servers`. Deterministic: one compile serves
 * every merged spec (Fb5, a4673b6e42).
 */
export function merged(sources: Readonly<Record<string, Json>>): Json {
	const all = Object.entries(sources).map(([key, source]) => [key, prefixed(source, key, pascal(key)) as Json] as const)
	const paths = all.flatMap(([key, source]) =>
		Object.entries((source.paths ?? {}) as Json).map(([path, item]) => [`/${key}${path}`, item] as const),
	)
	const sections = [...new Set(all.flatMap(([, source]) => Object.keys((source.components ?? {}) as Json)))].sort()
	const components = sections.map((section) => {
		const named = all.flatMap(([key, source]) =>
			Object.entries(((source.components ?? {}) as Record<string, Json>)[section] ?? {}).map(
				([name, value]) => [`${pascal(key)}${name}`, value] as const,
			),
		)
		return [section, claimed(named, `component ${section}`)] as const
	})
	const servers = Object.values(sources)[0]?.servers
	return {
		components: Object.fromEntries(components),
		info: { title: "Fixtures", version: "1" },
		openapi: "3.1.0",
		paths: claimed(paths, "path"),
		...(servers === undefined ? {} : { servers }),
	}
}
