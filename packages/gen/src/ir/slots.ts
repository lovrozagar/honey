/**
 * One operation's slots in the IR: its parameters by where they travel, its request bodies in
 * preference order, its responses by status, and the honey extensions it carries (realtime, SSE,
 * websocket, invalidation…), and for a webhook, how it is signed. Component `$ref`s on parameters,
 * bodies and responses are followed.
 */
import {
	type IRBody,
	type IRMultipartPart,
	type IROperation,
	type IROperationExtensions,
	type IRParam,
	type IRResponse,
	type IRSignature,
	schemaToIR,
} from "./model.ts"

type Json = Record<string, unknown>

/** The document's `components`, by section then name. */
export type Components = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/** A path template's pieces: literal text and `{param}` names. */
export type IRPathSegment = { kind: "literal"; text: string } | { kind: "param"; name: string }

/** Splits an OpenAPI path template into literal text and `{param}` pieces. */
export function parseOpenApiPath(path: string): IRPathSegment[] {
	const out: IRPathSegment[] = []
	let last = 0
	for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
		if (match.index > last) out.push({ kind: "literal", text: path.slice(last, match.index) })
		out.push({ kind: "param", name: match[1] as string })
		last = match.index + match[0].length
	}
	if (last < path.length) out.push({ kind: "literal", text: path.slice(last) })
	return out
}

/** The path template's parameter names, once each, in order. */
export function openApiPathParams(path: string): string[] {
	return [...new Set(parseOpenApiPath(path).flatMap((seg) => (seg.kind === "param" ? [seg.name] : [])))]
}

/** Every request body an operation declares, preferred first. */
export function bodiesOf(op: IROperation): IRBody[] {
	return op.bodies ?? (op.body === undefined ? [] : [op.body])
}

/** A parameter, body or response object with its component `$ref` followed; `undefined` for a dangling one. */
function deref(value: unknown, components: Components, depth = 0): Json | undefined {
	const object = value as Json | undefined
	if (typeof object?.$ref !== "string" || depth > 16) return object
	const [root, section, name] = object.$ref.replace(/^#\//, "").split("/")
	const target =
		root === "components" && section !== undefined && Object.hasOwn(components, section)
			? components[section]
			: undefined
	return deref(
		target !== undefined && name !== undefined && Object.hasOwn(target, name) ? target[name] : undefined,
		components,
		depth + 1,
	)
}

/** A schema `$ref` resolved to its component, for shape checks only. */
function shallow(schema: Json | undefined, components: Components, depth = 0): Json | undefined {
	if (typeof schema?.$ref !== "string" || depth > 16) return schema
	const name = schema.$ref.split("/").pop() as string
	const schemas = components.schemas ?? {}
	return shallow(Object.hasOwn(schemas, name) ? (schemas[name] as Json) : undefined, components, depth + 1)
}

const STRING = { kind: "scalar", type: "string" } as const

function paramOf(p: Json): IRParam {
	const schema = p.schema as Json | undefined
	const param: IRParam = {
		name: String(p.name),
		required: p.in === "path" || p.required === true,
		schema: schema === undefined ? STRING : schemaToIR(schema),
	}
	if (typeof p.description === "string") param.description = p.description
	if (p["x-honey-wildcard"] === true) param.wildcard = true
	if (schema?.default !== undefined) param.default = schema.default
	return param
}

/** An operation's parameters, the path item's applying unless the operation declares the same name and place. */
export function paramsOf(path: string, op: Json, item: Json, components: Components): IROperation["params"] {
	const declared = ((op.parameters as unknown[] | undefined) ?? [])
		.map((p) => deref(p, components))
		.filter((p) => p !== undefined)
	for (const p of ((item.parameters as unknown[] | undefined) ?? []).map((q) => deref(q, components))) {
		if (p !== undefined && !declared.some((d) => d.name === p.name && d.in === p.in)) declared.push(p)
	}
	const by = (place: string) => declared.filter((p) => p.in === place).map(paramOf)
	const pathParams = by("path")
	/* path params in template order; one the template lacks cannot be sent, one it has but nobody declared is a string */
	const params: IROperation["params"] = {
		header: by("header"),
		path: openApiPathParams(path).map(
			(name) => pathParams.find((p) => p.name === name) ?? { name, required: true, schema: STRING },
		),
		query: by("query"),
	}
	const cookie = by("cookie")
	if (cookie.length > 0) params.cookie = cookie
	return params
}

/* JSON first, then the structured kinds; other JSON-like types next, then the rest as listed */
const PREFERENCE: readonly string[] = [
	"application/json",
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"application/octet-stream",
]

const essenceOf = (type: string) => (type.split(";")[0] as string).trim().toLowerCase()

function rank(type: string): number {
	const essence = essenceOf(type)
	const at = PREFERENCE.indexOf(essence)
	if (at >= 0) return at
	return essence.endsWith("+json") ? PREFERENCE.length : PREFERENCE.length + 1
}

/** `content`'s media types in preference order; ties keep the order the document lists them in. */
function ordered(content: Json): string[] {
	return Object.keys(content)
		.map((type, at) => ({ at, rank: rank(type), type }))
		.sort((a, b) => a.rank - b.rank || a.at - b.at)
		.map(({ type }) => type)
}

/** A multipart form's parts: a binary property, or a list of them, is a file. */
function partsOf(form: Json | undefined, components: Components): IRMultipartPart[] {
	return Object.entries((form?.properties ?? {}) as Record<string, Json>).map(([name, property]) => {
		const resolved = shallow(property, components)
		const items = resolved?.type === "array" ? shallow(resolved.items as Json | undefined, components) : undefined
		const file = resolved?.format === "binary" || items?.format === "binary"
		return { name, schema: schemaToIR(property), type: file ? "file" : "text" }
	})
}

function bodyOf(type: string, media: Json | undefined, required: boolean, components: Components): IRBody {
	const schema = media?.schema as Json | undefined
	const essence = essenceOf(type)
	if (essence === "application/octet-stream")
		return { contentType: "application/octet-stream", kind: "stream", required }
	const parts = essence === "multipart/form-data" ? partsOf(shallow(schema, components), components) : []
	if (parts.some((part) => part.type === "file")) {
		/* a part can only be a file when the form has a schema */
		return { contentType: "multipart/form-data", kind: "multipart", parts, required, schema: schemaToIR(schema) }
	}
	return { contentType: type, kind: "raw", required, schema: schemaToIR(schema) }
}

/** Every request body the operation declares, preferred first. */
export function requestBodies(op: Json, components: Components): IRBody[] {
	const requestBody = deref(op.requestBody, components)
	const content = (requestBody?.content ?? {}) as Record<string, Json>
	return ordered(content).map((type) => bodyOf(type, content[type], requestBody?.required === true, components))
}

/** The responses by status, each with its preferred media type's schema; and whether any streams events. */
export function responsesOf(op: Json, components: Components): { responses: Record<string, IRResponse>; sse: boolean } {
	const responses: Record<string, IRResponse> = {}
	let sse = false
	for (const [status, raw] of Object.entries((op.responses ?? {}) as Json)) {
		const content = (deref(raw, components)?.content ?? {}) as Record<string, Json>
		const type = ordered(content)[0]
		if (type === undefined) {
			responses[status] = { status }
			continue
		}
		if (Object.keys(content).some((key) => essenceOf(key) === "text/event-stream")) sse = true
		const schema = content[type]?.schema as Json | undefined
		responses[status] =
			schema === undefined ? { contentType: type, status } : { contentType: type, schema: schemaToIR(schema), status }
	}
	return { responses, sse }
}

/** The honey extensions: each only when it is literally `true`; invalidation targets as strings. */
export function extensionsOf(op: Json, sse: boolean): IROperationExtensions {
	const out: IROperationExtensions = {}
	if (op["x-websocket"] === true) out.websocket = true
	if (op["x-realtime"] === true) out.realtime = true
	if (sse) out.sse = true
	if (op["x-deprecated"] === true || op.deprecated === true) out.deprecated = true
	if (op["x-idempotency-key"] === true) out.idempotencyKey = true
	if (op["x-mcp"] === true) out.mcp = true
	if (typeof op["x-honey-route"] === "string") out.route = op["x-honey-route"]
	const invalidate = op["x-invalidate"]
	if (Array.isArray(invalidate)) out.invalidates = invalidate.filter((target) => typeof target === "string")
	return out
}

/* a header name: an RFC 9110 token */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Each reason an SDK could not verify a signature written as `raw`. */
function signatureErrors(raw: Json): string[] {
	const errors: string[] = []
	if (raw.algorithm !== "hmac-sha256") errors.push(`algorithm ${JSON.stringify(raw.algorithm)} is not hmac-sha256`)
	if (raw.encoding !== "hex" && raw.encoding !== "base64")
		errors.push(`encoding ${JSON.stringify(raw.encoding)} is not hex or base64`)
	if (typeof raw.header !== "string" || !TOKEN.test(raw.header))
		errors.push(`header ${JSON.stringify(raw.header)} is not a header name`)
	if (raw.prefix !== undefined && typeof raw.prefix !== "string") errors.push("the prefix is not a string")
	else if (/\p{Cc}/u.test(raw.prefix ?? "")) errors.push("the prefix holds a control character")
	return errors
}

/**
 * How the webhook `name` is signed, from its operation's `x-honey-signature`; none when unsigned.
 * gen reads documents it did not write: a signature an SDK could not verify is refused, never
 * emitted as a helper that cannot check it.
 */
export function signatureOf(name: string, op: Json): IRSignature | undefined {
	const raw = op["x-honey-signature"]
	if (raw === undefined) return undefined
	const errors = signatureErrors(raw !== null && typeof raw === "object" ? (raw as Json) : {})
	if (errors.length > 0) throw new Error(`x-honey-signature on webhook ${JSON.stringify(name)}: ${errors.join("; ")}`)
	const { encoding, header, prefix } = raw as { encoding: "base64" | "hex"; header: string; prefix?: string }
	return { algorithm: "hmac-sha256", encoding, header, prefix: prefix ?? "" }
}
