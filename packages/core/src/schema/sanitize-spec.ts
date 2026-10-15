/**
 * What a published OpenAPI document leaves out: security requirements and schemes the public
 * must not see, and operation extensions (`x-*`). Pure: only what changes is rebuilt.
 */
import type { SchemaSpec } from "./slots.ts"

export type OpenApiSanitizeOptions = {
	/** Drop each security requirement that names one of these schemes, on operations and the root. */
	readonly stripSecurityRequirements?: readonly string[]
	/** Drop these schemes from `components.securitySchemes`. */
	readonly stripSecuritySchemes?: readonly string[]
	/** Drop every `x-*` key of each operation, or only the ones listed. */
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

function withoutExtensions(operation: Readonly<Record<string, unknown>>, strip: boolean | readonly string[]) {
	if (strip === false) return operation
	const drop = (key: string) => (strip === true ? key.startsWith("x-") : strip.includes(key))
	return Object.fromEntries(Object.entries(operation).filter(([key]) => !drop(key)))
}

function withoutSchemes(components: SchemaSpec["components"], stripped: readonly string[]): SchemaSpec["components"] {
	const schemes = components?.securitySchemes as Readonly<Record<string, unknown>> | undefined
	if (components === undefined || schemes === undefined || stripped.length === 0) return components
	const { securitySchemes: _dropped, ...rest } = components
	const kept = Object.fromEntries(Object.entries(schemes).filter(([name]) => !stripped.includes(name)))
	return Object.keys(kept).length === 0 ? rest : { ...rest, securitySchemes: kept }
}

/** `spec` as the public sees it under `options`; `spec` itself is never changed. */
export function sanitizeOpenApiSpec(spec: SchemaSpec, options: OpenApiSanitizeOptions): SchemaSpec {
	const requirements = options.stripSecurityRequirements ?? []
	const extensions = options.stripXExtensions ?? false
	const paths = Object.fromEntries(
		Object.entries(spec.paths).map(([path, item]) => [
			path,
			Object.fromEntries(
				Object.entries(item).map(([key, value]) => {
					if (!METHODS.includes(key)) return [key, value]
					const operation = value as Readonly<Record<string, unknown>>
					return [key, withoutExtensions(withoutRequirements(operation, requirements), extensions)]
				}),
			),
		]),
	)
	const sanitized: Record<string, unknown> = { ...withoutRequirements(spec, requirements), paths }
	const components = withoutSchemes(spec.components, options.stripSecuritySchemes ?? [])
	if (components !== undefined) sanitized.components = components
	return sanitized as SchemaSpec
}
