/**
 * What a published OpenAPI document leaves out: security requirements and schemes the public
 * must not see, and extensions (`x-*`) on operations, their parameters and responses, and every
 * schema. Pure: only what changes is rebuilt.
 */
import type { SchemaSpec } from "./slots.ts"

/** What to remove from an OpenAPI document before it is published. */
export type OpenApiSanitizeOptions = {
	/** Drop each security requirement that names one of these schemes, on operations and the root. */
	readonly stripSecurityRequirements?: readonly string[]
	/** Drop these schemes from `components.securitySchemes`. */
	readonly stripSecuritySchemes?: readonly string[]
	/**
	 * Drop the `x-*` keys of each operation, its parameters and responses, and every schema: `true` drops every key honey
	 * and its generators do not read (they keep `x-honey-*`, `x-mcp`, `x-invalidate` and the like), a list drops exactly
	 * the keys it names.
	 */
	readonly stripXExtensions?: boolean | readonly string[]
}

type Requirement = Readonly<Record<string, unknown>>

/** The path-item keys that are operations. */
const METHODS: readonly string[] = ["delete", "get", "head", "options", "patch", "post", "put", "trace"]

/** `holder` without the requirements naming a stripped scheme, and without `security` once none is left. */
function withoutRequirements<T extends Readonly<Record<string, unknown>>>(holder: T, stripped: readonly string[]): T {
	if (stripped.length === 0 || !Array.isArray(holder.security)) return holder
	const { security, ...rest } = holder
	const kept = (security as readonly Requirement[]).filter((requirement) =>
		stripped.every((scheme) => !Object.hasOwn(requirement, scheme)),
	)
	return (kept.length === 0 ? rest : { ...rest, security: kept }) as unknown as T
}

/** The extensions honey's generators read besides its own `x-honey-*`: `true` keeps them. */
const READ: Readonly<Record<string, true>> = /* @__PURE__ */ Object.freeze({
	"x-deprecated": true,
	"x-idempotency-key": true,
	"x-invalidate": true,
	"x-mcp": true,
	"x-mcp-file": true,
	"x-realtime": true,
	"x-websocket": true,
})

type Drop = (key: string) => boolean
type Node = Readonly<Record<string, unknown>>

/** Which extension keys go: `null` when none does. */
function dropOf(strip: boolean | readonly string[]): Drop | null {
	if (strip === false) return null
	if (strip === true) return (key) => key.startsWith("x-") && !key.startsWith("x-honey-") && !Object.hasOwn(READ, key)
	return (key) => strip.includes(key)
}

/**
 * `value` without its dropped keys, each kept value through `inner` (by key); a boolean schema (`items: true`) as it is.
 */
function pruned(value: unknown, drop: Drop, inner: (key: string, value: unknown) => unknown): unknown {
	if (typeof value !== "object" || value === null) return value
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) if (!drop(key)) out[key] = inner(key, entry)
	return out
}

/** Each value of a map (properties, content, headers), through `each`: its keys are names, never extensions. */
function mapped(value: unknown, each: (entry: unknown) => unknown): Node {
	return Object.fromEntries(Object.entries(value as Node).map(([key, entry]) => [key, each(entry)]))
}

const listed = (value: unknown, each: (entry: unknown) => unknown) => (value as readonly unknown[]).map(each)

/* JSON Schema keywords holding a schema, a list of them, or a map of them; const, enum, default and examples are data */
const ONE: readonly string[] = [
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
]
const LIST: readonly string[] = ["allOf", "anyOf", "oneOf", "prefixItems"]
const MAP: readonly string[] = ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]

function schema(value: unknown, drop: Drop): unknown {
	const each = (entry: unknown) => schema(entry, drop)
	return pruned(value, drop, (key, inner) => {
		if (ONE.includes(key)) return each(inner)
		if (LIST.includes(key)) return listed(inner, each)
		return MAP.includes(key) ? mapped(inner, each) : inner
	})
}

/** A parameter, a header or a media type: its own extensions, and its schema's. */
function holder(value: unknown, drop: Drop): unknown {
	return pruned(value, drop, (key, inner) => (key === "schema" ? schema(inner, drop) : inner))
}

/** A request body or a response: its own extensions, and each media type's and header's. */
function body(value: unknown, drop: Drop): unknown {
	const each = (entry: unknown) => holder(entry, drop)
	return pruned(value, drop, (key, inner) => (key === "content" || key === "headers" ? mapped(inner, each) : inner))
}

function withoutExtensions(operation: Node, drop: Drop | null): unknown {
	if (drop === null) return operation
	return pruned(operation, drop, (key, inner) => {
		if (key === "parameters") return listed(inner, (entry) => holder(entry, drop))
		if (key === "requestBody") return body(inner, drop)
		return key === "responses" ? mapped(inner, (entry) => body(entry, drop)) : inner
	})
}

function withoutSchemes(
	components: SchemaSpec["components"],
	stripped: readonly string[],
	drop: Drop | null,
): SchemaSpec["components"] {
	if (drop !== null && components?.schemas !== undefined)
		components = { ...components, schemas: mapped(components.schemas, (entry) => schema(entry, drop)) as never }
	const schemes = components?.securitySchemes as Readonly<Record<string, unknown>> | undefined
	if (components === undefined || schemes === undefined || stripped.length === 0) return components
	const { securitySchemes: _dropped, ...rest } = components
	const kept = Object.fromEntries(Object.entries(schemes).filter(([name]) => !stripped.includes(name)))
	return Object.keys(kept).length === 0 ? rest : { ...rest, securitySchemes: kept }
}

/** Every scheme a security requirement of `spec` names, on its operations or its root. */
export function securityNamed(spec: SchemaSpec): Set<string> {
	const named = new Set<string>()
	const add = (holder: Readonly<Record<string, unknown>>) => {
		if (Array.isArray(holder.security))
			for (const requirement of holder.security as readonly Requirement[])
				for (const scheme of Object.keys(requirement)) named.add(scheme)
	}
	add(spec)
	for (const item of Object.values(spec.paths))
		for (const [key, value] of Object.entries(item))
			if (METHODS.includes(key)) add(value as Readonly<Record<string, unknown>>)
	return named
}

/** `spec` as the public sees it under `options`; `spec` itself is never changed. */
export function sanitizeOpenApiSpec(spec: SchemaSpec, options: OpenApiSanitizeOptions): SchemaSpec {
	const requirements = options.stripSecurityRequirements ?? []
	const drop = dropOf(options.stripXExtensions ?? false)
	const paths = Object.fromEntries(
		Object.entries(spec.paths).map(([path, item]) => [
			path,
			Object.fromEntries(
				Object.entries(item).map(([key, value]) => {
					if (!METHODS.includes(key)) return [key, value]
					const operation = value as Readonly<Record<string, unknown>>
					return [key, withoutExtensions(withoutRequirements(operation, requirements), drop)]
				}),
			),
		]),
	)
	const sanitized: Record<string, unknown> = { ...withoutRequirements(spec, requirements), paths }
	const components = withoutSchemes(spec.components, options.stripSecuritySchemes ?? [], drop)
	if (components !== undefined) sanitized.components = components
	return sanitized as SchemaSpec
}
