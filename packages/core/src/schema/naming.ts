/**
 * Component names for the schemas a document hoists: read from the operation that uses the
 * schema (`POST /v1/projects` body → `CreateProjectRequest`), from an error envelope's status and
 * keys (`Err400InvalidInput`), and a short content hash for telling clashing names apart.
 */
import { compareCodeUnits } from "./canonicalize.ts"
import type { JsonSchema } from "./to-json-schema.ts"

export type SchemaNameContext =
	| { readonly fieldPath?: readonly string[]; readonly method: string; readonly path: string; readonly role: "request" }
	| {
			readonly fieldPath?: readonly string[]
			readonly method: string
			readonly path: string
			readonly role: "response"
			readonly status: number
	  }

/** A POST leaf that names the action rather than a resource. */
const ACTIONS: readonly string[] = ["accept", "cancel", "confirm", "invite", "refresh", "reset", "revoke", "verify"]

/** djb2 of `text` as 8 lowercase hex characters. */
function hashString(text: string): string {
	let hash = 5381
	for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) | 0
	return (hash >>> 0).toString(16).padStart(8, "0")
}

/** Six hex characters of `canonical`'s hash: the suffix that tells two clashing names apart. */
export function shortHash(canonical: string): string {
	return hashString(canonical).slice(0, 6)
}

/** `user-profiles`, `books:archive`, `v1.json` → one PascalCase word of letters and digits. */
function pascal(segment: string): string {
	return segment
		.split(/[^A-Za-z0-9]+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("")
}

/**
 * A name OpenAPI takes as a `components.schemas` key that also reads as an identifier in every
 * SDK language: letters, digits and `_`, never a leading digit.
 */
export function sanitizeComponentName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
	return /^[0-9]/.test(cleaned) ? `S${cleaned}` : cleaned
}

const isParam = (segment: string) => segment.startsWith("{") && segment.endsWith("}")
const isAction = (segment: string | undefined) => segment !== undefined && ACTIONS.includes(segment.toLowerCase())

/**
 * The path's segments without its version prefix, and without a variant that follows a
 * collection (`/webhooks/github`): two variants share one base name, and the hash parts them.
 */
function segmentsOf(path: string): string[] {
	const segments = path.replace(/^\//, "").split("/")
	if (/^v\d+$/.test(segments[0] as string)) segments.shift()
	const [prev, last] = segments.slice(-2)
	const variant = prev !== undefined && last !== undefined && !isParam(prev) && !isParam(last) && !isAction(last)
	return variant && pascal(prev).endsWith("s") ? segments.slice(0, -1) : segments
}

function verbOf(method: string, last: string | undefined): string {
	if (method === "get") return last !== undefined && isParam(last) ? "Get" : "List"
	if (method === "patch") return "Update"
	if (method === "put") return "Replace"
	if (method === "delete") return "Delete"
	return isAction(last) ? pascal(last as string) : "Create"
}

/** The resource words: an action leaf dropped, the last noun singular unless listed. */
function resourceOf(segments: readonly string[], verb: string): string {
	const words = segments.filter((segment) => !isParam(segment)).map(pascal)
	if (isAction(segments.at(-1))) return words.slice(0, -1).join("")
	const last = words.at(-1)
	if (verb !== "List" && last !== undefined && last.length > 2 && last.endsWith("s")) {
		words[words.length - 1] = last.slice(0, -1)
	}
	return words.join("")
}

/** The component name of the schema at `context`: verb, resource, then the field path or the role. */
export function deriveSchemaName(context: SchemaNameContext): string {
	const segments = segmentsOf(context.path)
	const verb = verbOf(context.method, segments.at(-1))
	const base = `${verb}${resourceOf(segments, verb)}`
	const { fieldPath } = context
	if (fieldPath !== undefined && fieldPath.length > 0) return nestedSchemaName(base, fieldPath)
	return sanitizeComponentName(base + (context.role === "request" ? "Request" : `Response${context.status}`))
}

/** The name of an object nested in the component `owner` at `fieldPath`. */
export function nestedSchemaName(owner: string, fieldPath: readonly string[]): string {
	return sanitizeComponentName(owner + fieldPath.map(pascal).join(""))
}

type Properties = Readonly<Record<string, JsonSchema | undefined>>

/** Whether `schema` is honey's error body: `error_key`, `status`, and a `success` that can only be false. */
export function isErrorEnvelope(schema: JsonSchema): boolean {
	const properties = schema.properties as Properties | undefined
	if (properties?.error_key === undefined || properties.status === undefined) return false
	const success = properties.success
	if (success === undefined) return false
	const only = success.enum
	return success.const === false || (Array.isArray(only) && only.length === 1 && only[0] === false)
}

/** The one status an envelope declares: its const, else its one-value enum. */
function declaredStatus(status: JsonSchema): unknown {
	if (status.const !== undefined) return status.const
	const only = status.enum
	return Array.isArray(only) && only.length === 1 ? only[0] : undefined
}

/**
 * The name of an error envelope several answers share: `Err`, its status (declared, else the
 * answer's `fallback`, else none), then every error key, sorted.
 */
export function deriveErrorEnvelopeName(schema: JsonSchema, fallback: number | undefined): string {
	const properties = schema.properties as Readonly<Record<string, JsonSchema>>
	const declared = declaredStatus(properties.status as JsonSchema)
	const status = typeof declared === "number" ? declared : (fallback ?? "")
	const keys = (properties.error_key as JsonSchema).enum
	const words = Array.isArray(keys)
		? keys.filter((key): key is string => typeof key === "string").sort(compareCodeUnits)
		: []
	return sanitizeComponentName(`Err${status}${words.map(pascal).join("")}`)
}
