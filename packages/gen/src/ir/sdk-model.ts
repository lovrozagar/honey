/**
 * One request model for the Go, Rust, Python and Go CLI emitters, read from the IR alone: method,
 * query, headers, body and answer handling are decided once here for regular, SSE, WebSocket and
 * realtime calls alike, instead of in each emitter.
 */
import { compareCodeUnits } from "../emit/shared/lang.ts"
import { type IR, type IRMultipartPart, type IROperation, type IRParam, type IRSchema } from "./model.ts"
import { irResolver } from "./schema.ts"
import { type IRPathSegment, parseOpenApiPath } from "./slots.ts"

export type SdkBody =
	| { kind: "json"; contentType: string; schema: IRSchema; required: boolean }
	| { kind: "form"; contentType: string; schema: IRSchema; required: boolean }
	| { kind: "multipart"; contentType: string; parts: IRMultipartPart[]; required: boolean }
	| { kind: "binary"; contentType: string; required: boolean }
	| { kind: "text"; contentType: string; required: boolean }

export type SdkResponseKind = "binary" | "json" | "none" | "text"

export type SdkSuccess = { kind: SdkResponseKind; status: string; contentType?: string; schema?: IRSchema }

export type SdkStream = "realtime" | "sse" | "ws" | null

export type SdkOp = {
	ir: IROperation
	id: string
	/** the id's dotted segments */
	segments: string[]
	method: string
	path: string
	pathSegments: IRPathSegment[]
	pathParams: IRParam[]
	/** in code-unit order by name */
	query: IRParam[]
	headers: IRParam[]
	body?: SdkBody
	success: SdkSuccess
	/** the schema of its events' `data`, when its event stream declares one that is not a string (`sseEventSchema`) */
	events?: IRSchema
	/** the 4xx and 5xx statuses it declares, ascending */
	errorStatuses: number[]
	stream: SdkStream
	idempotent: boolean
	invalidates: string[]
	summary: string
	description: string
	deprecated: boolean
}

export type SdkModel = {
	ir: IR
	ops: SdkOp[]
	opsById: Map<string, SdkOp>
	/** the component schema names, in code-unit order */
	schemaNames: string[]
	/** follows refs to their component; an unknown one is `unknown` */
	resolve: (schema: IRSchema) => IRSchema
}

/** A media type's essence: `Application/JSON; charset=utf-8` → `application/json`. */
export function mediaEssence(contentType: string): string {
	return (contentType.split(";")[0] as string).trim().toLowerCase()
}

export function isJsonMedia(contentType: string): boolean {
	const essence = mediaEssence(contentType)
	return essence === "application/json" || essence.endsWith("+json")
}

export function isTextMedia(contentType: string): boolean {
	const essence = mediaEssence(contentType)
	const [type, subtype] = essence.split("/")
	return (type === "text" && subtype !== undefined) || essence === "application/xml" || essence.endsWith("+xml")
}

function kindOf(contentType: string | undefined): SdkResponseKind {
	if (contentType === undefined || mediaEssence(contentType) === "text/event-stream") return "none"
	if (isJsonMedia(contentType)) return "json"
	return isTextMedia(contentType) ? "text" : "binary"
}

/** The answer a call returns: the lowest 2xx with a body, else the lowest 2xx, else a JSON 2XX or default. */
function successOf(op: IROperation): SdkSuccess {
	const codes = Object.keys(op.responses)
		.filter((status) => /^2[0-9]{2}$/.test(status))
		.sort((a, b) => Number(a) - Number(b))
	const status = codes.find((code) => op.responses[code]?.contentType !== undefined) ?? codes[0]
	if (status === undefined) {
		const fallback = op.responses["2XX"] ?? op.responses.default
		if (fallback?.contentType === undefined || !isJsonMedia(fallback.contentType)) {
			return { kind: Object.keys(op.responses).length === 0 ? "json" : "none", status: "200" }
		}
		const out: SdkSuccess = { contentType: fallback.contentType, kind: "json", status: fallback.status }
		if (fallback.schema !== undefined) out.schema = fallback.schema
		return out
	}
	const response = op.responses[status] as NonNullable<IROperation["responses"][string]>
	const kind = status === "204" || status === "205" ? "none" : kindOf(response.contentType)
	const out: SdkSuccess = { kind, status }
	if (response.contentType !== undefined) out.contentType = response.contentType
	if (response.schema !== undefined && kind === "json") out.schema = response.schema
	return out
}

/** What a call sends: JSON, a form, multipart parts (a text-only multipart's fields as text parts), text or bytes. */
function bodyOf(op: IROperation, resolve: (schema: IRSchema) => IRSchema): SdkBody | undefined {
	const body = op.body
	if (body === undefined) return undefined
	const { contentType, required } = body
	if (body.kind === "stream") return { contentType, kind: "binary", required }
	if (body.kind === "multipart") return { contentType, kind: "multipart", parts: body.parts, required }
	if (isJsonMedia(contentType)) return { contentType, kind: "json", required, schema: body.schema }
	const essence = mediaEssence(contentType)
	if (essence === "application/x-www-form-urlencoded")
		return { contentType, kind: "form", required, schema: body.schema }
	if (essence === "multipart/form-data") {
		const form = resolve(body.schema)
		const parts: IRMultipartPart[] =
			form.kind === "object" ? form.fields.map(({ name, schema }) => ({ name, schema, type: "text" })) : []
		return { contentType, kind: "multipart", parts, required }
	}
	return { contentType, kind: isTextMedia(contentType) ? "text" : "binary", required }
}

function streamOf(op: IROperation): SdkStream {
	const { realtime, sse, websocket } = op.extensions
	if (realtime === true) return "realtime"
	if (websocket === true) return "ws"
	return sse === true ? "sse" : null
}

/* a string-typed schema: a scalar string, or a string const or enum */
const isStringSchema = (schema: IRSchema) =>
	(schema.kind === "scalar" && schema.type === "string") ||
	(schema.kind === "const" && typeof schema.value === "string")

/**
 * The schema an SSE op declares for its events' `data`, when it is not a string: such events are
 * JSON (core JSON-encodes an object `data`) and the client parses them.
 */
export function sseEventSchema(op: IROperation, resolve: (schema: IRSchema) => IRSchema): IRSchema | undefined {
	const response = Object.values(op.responses).find(
		({ contentType }) => contentType !== undefined && mediaEssence(contentType) === "text/event-stream",
	)
	if (response?.schema === undefined) return undefined
	const resolved = resolve(response.schema)
	return resolved.kind === "unknown" || isStringSchema(resolved) ? undefined : response.schema
}

function opOf(op: IROperation, resolve: (schema: IRSchema) => IRSchema): SdkOp {
	const errorStatuses = Object.keys(op.responses)
		.filter((status) => /^[0-9]{3}$/.test(status) && Number(status) >= 400)
		.map(Number)
		.sort((a, b) => a - b)
	const out: SdkOp = {
		deprecated: op.extensions.deprecated === true,
		description: op.description ?? "",
		errorStatuses,
		headers: op.params.header,
		id: op.id,
		idempotent: op.extensions.idempotencyKey === true,
		invalidates: op.extensions.invalidates ?? [],
		ir: op,
		method: op.method,
		path: op.path,
		pathParams: op.params.path,
		pathSegments: parseOpenApiPath(op.path),
		query: [...op.params.query].sort((a, b) => compareCodeUnits(a.name, b.name)),
		segments: op.id.split("."),
		stream: streamOf(op),
		success: successOf(op),
		summary: op.summary ?? "",
	}
	const body = bodyOf(op, resolve)
	if (body !== undefined) out.body = body
	const events = sseEventSchema(op, resolve)
	if (events !== undefined) out.events = events
	return out
}

/** The SDK model of `ir` (built with `deriveOperationIds`, so every operation has an id). */
export function sdkModel(ir: IR): SdkModel {
	const resolve = irResolver(ir.schemas)
	const ops = ir.operations.map((op) => opOf(op, resolve))
	return {
		ir,
		ops,
		opsById: new Map(ops.map((op) => [op.id, op])),
		resolve,
		schemaNames: Object.keys(ir.schemas).sort(compareCodeUnits),
	}
}

/** The refs `schema` holds by value: through fields, allOf, nullable and union variants, not through containers. */
function valueRefs(schema: IRSchema): string[] {
	if (schema.kind === "ref") return [schema.name]
	if (schema.kind === "object") return schema.fields.flatMap(({ schema: field }) => valueRefs(field))
	if (schema.kind === "allOf") return schema.parts.flatMap(valueRefs)
	if (schema.kind === "union") return schema.variants.flatMap(valueRefs)
	return schema.kind === "nullable" ? valueRefs(schema.inner) : []
}

/** The component schemas on a by-value cycle, direct or mutual: such a reference needs a pointer or a `Box`. */
export function valueCycleSchemas(schemas: Record<string, IRSchema>): Set<string> {
	const edges = new Map(Object.entries(schemas).map(([name, schema]) => [name, valueRefs(schema)]))
	const cyclic = new Set<string>()
	for (const start of edges.keys()) {
		const seen = new Set<string>()
		const stack = [...(edges.get(start) as string[])]
		while (stack.length > 0) {
			const at = stack.pop() as string
			if (at === start) {
				cyclic.add(start)
				break
			}
			if (seen.has(at)) continue
			seen.add(at)
			stack.push(...(edges.get(at) ?? []))
		}
	}
	return cyclic
}

const isString = (schema: IRSchema | undefined) => schema?.kind === "scalar" && schema.type === "string"

type FieldOf = (object: IRSchema | undefined, name: string) => IRSchema | undefined

/** Whether `envelope` has the envelope's fixed shape: `success: false`, a message, a status key and its field list. */
function envelopeShape(envelope: IRSchema, field: FieldOf, resolve: (schema: IRSchema) => IRSchema): boolean {
	const success = field(envelope, "success")
	if (success?.kind !== "const" || success.value !== false) return false
	if (!isString(field(envelope, "message")) || !isString(field(envelope, "status_key"))) return false
	const fields = field(envelope, "fields")
	const list = fields?.kind === "object" && fields.additional ? resolve(fields.additional) : undefined
	const item = list?.kind === "array" ? resolve(list.items) : undefined
	return ["error_key", "message", "path"].every((name) => isString(field(item, name)))
}

/** honey's error envelope (`success: false`, an `error_key` enum, one `status`): its keys and status, else `null`. */
export function irErrorEnvelope(
	schema: IRSchema,
	resolve: (schema: IRSchema) => IRSchema,
): { keys: string[]; status: number } | null {
	const field: FieldOf = (object, name) => {
		const found = object?.kind === "object" ? object.fields.find((f) => f.name === name) : undefined
		return found === undefined ? undefined : resolve(found.schema)
	}
	const envelope = resolve(schema)
	if (!envelopeShape(envelope, field, resolve)) return null
	const status = field(envelope, "status")
	const key = field(envelope, "error_key")
	if (status?.kind !== "scalar" || status.enum?.length !== 1 || typeof status.enum[0] !== "number") return null
	if (key?.kind !== "scalar" || key.enum === undefined || key.enum.length === 0) return null
	return key.enum.every((k) => typeof k === "string") ? { keys: key.enum as string[], status: status.enum[0] } : null
}
