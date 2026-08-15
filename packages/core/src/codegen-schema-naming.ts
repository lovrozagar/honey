import { hashString } from "./codegen-hash.ts"

export type SchemaRole = "request" | "response"

export type SchemaNameContext =
	| { method: string; path: string; role: "request"; fieldPath?: string[] }
	| { method: string; path: string; role: "response"; status: number; fieldPath?: string[] }

const KNOWN_ACTIONS = new Set(["accept", "cancel", "refresh", "verify", "confirm", "reset", "revoke", "invite"])

/** Returns 6-char lowercase hex derived from content hash. */
export function shortHash(canonical: string): string {
	return hashString(canonical).slice(0, 6)
}

function toPascal(segment: string): string {
	return segment
		.replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
		.replace(/^(.)/, (_, c: string) => c.toUpperCase())
}

function stripPathPrefix(path: string): string[] {
	const raw = path.replace(/^\//, "").split("/")
	/* drop leading version segment like v1, v2, v10 */
	if (raw.length > 0 && /^v\d+$/.test(raw[0])) raw.shift()
	return raw
}

function isParam(segment: string): boolean {
	return segment.startsWith("{") && segment.endsWith("}")
}

/*
 * Drop "variant qualifier": when the last raw segment is a non-param non-action
 * literal that follows DIRECTLY after a plural collection noun (no {param} between
 * them), it's a discriminator (e.g. "github"/"stripe" in /webhooks/github).
 * Dropping it ensures both routes derive the same base name so collision detection
 * kicks in and hash-suffix disambiguates their distinct shapes.
 */
function dropVariantQualifier(rawSegments: string[]): string[] {
	if (rawSegments.length < 2) return rawSegments
	const last = rawSegments[rawSegments.length - 1]
	const prev = rawSegments[rawSegments.length - 2]
	if (!isParam(last) && !isParam(prev) && !KNOWN_ACTIONS.has(last.toLowerCase())) {
		const prevPascal = toPascal(prev)
		/* prev must be a collection noun (ends in 's' after PascalCase) */
		if (prevPascal.endsWith("s")) {
			return rawSegments.slice(0, -1)
		}
	}
	return rawSegments
}

function deriveVerb(method: string, rawSegments: string[]): string {
	const lastRaw = rawSegments[rawSegments.length - 1]

	if (method === "get") {
		if (lastRaw && isParam(lastRaw)) return "Get"
		return "List"
	}
	if (method === "patch") return "Update"
	if (method === "put") return "Replace"
	if (method === "delete") return "Delete"

	/* POST */
	if (lastRaw && KNOWN_ACTIONS.has(lastRaw.toLowerCase())) {
		return toPascal(lastRaw)
	}
	return "Create"
}

function buildResourcePart(rawSegments: string[], verb: string): string {
	const nonParam = rawSegments.filter((s) => !isParam(s))
	const lastSeg = rawSegments[rawSegments.length - 1]

	if (lastSeg && KNOWN_ACTIONS.has(lastSeg.toLowerCase()) && verb === toPascal(lastSeg)) {
		/* last segment is the action verb — drop it; it's already the verb prefix */
		return nonParam.slice(0, -1).map(toPascal).join("")
	}

	const parts = nonParam.map(toPascal)

	/* singularize last noun for non-List verbs */
	if (verb !== "List" && parts.length > 0) {
		const last = parts[parts.length - 1]
		if (last.endsWith("s") && last.length > 2) {
			parts[parts.length - 1] = last.slice(0, -1)
		}
	}

	return parts.join("")
}

function roleSuffix(ctx: SchemaNameContext): string {
	if (ctx.role === "request") return "Request"
	return `Response${ctx.status}`
}

/** Returns true if schema matches anyrow-style error envelope shape. */
export function isErrorEnvelope(schema: Record<string, unknown>): boolean {
	if (schema.type !== "object" && !schema.properties) return false
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return false
	if (!props.error_key || !props.status || !props.success) return false
	const successDef = props.success
	const isFalseConst = successDef.const === false
	const isFalseEnum = Array.isArray(successDef.enum) && successDef.enum.length === 1 && successDef.enum[0] === false
	return isFalseConst || isFalseEnum
}

/** Derives a canonical name for a shared error envelope (e.g. `Err400InvalidInput`). */
export function deriveErrorEnvelopeName(schema: Record<string, unknown>, fallbackStatus?: number): string {
	const props = schema.properties as Record<string, Record<string, unknown>>
	const statusProp = props.status
	let status: number | undefined
	if (typeof statusProp.const === "number") status = statusProp.const
	else if (Array.isArray(statusProp.enum) && statusProp.enum.length === 1 && typeof statusProp.enum[0] === "number") status = statusProp.enum[0]
	else if (fallbackStatus !== undefined) status = fallbackStatus
	else throw new Error("deriveErrorEnvelopeName: no status")

	const keyProp = props.error_key
	const keys: string[] = Array.isArray(keyProp?.enum)
		? [...keyProp.enum].filter((k): k is string => typeof k === "string").sort()
		: []

	if (keys.length === 0) return `Err${status}`
	const keysPascal = keys
		.map((k) => k.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(""))
		.join("")
	return `Err${status}${keysPascal}`
}

/** Derives a human-readable schema component name from operation context. */
export function deriveSchemaName(ctx: SchemaNameContext): string {
	const rawSegments = dropVariantQualifier(stripPathPrefix(ctx.path))
	const verb = deriveVerb(ctx.method, rawSegments)
	const resource = buildResourcePart(rawSegments, verb)
	const base = `${verb}${resource}`

	if (ctx.fieldPath && ctx.fieldPath.length > 0) {
		const fieldPart = ctx.fieldPath.map(toPascal).join("")
		return `${base}${fieldPart}`
	}

	return `${base}${roleSuffix(ctx)}`
}
