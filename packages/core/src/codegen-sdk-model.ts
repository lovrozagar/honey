/* One request model for the Go, Rust, Python and Go CLI emitters, built from the IR.
 *
 * Regular, SSE, WebSocket and realtime operations share it, so method, query, headers, body and
 * response handling are decided once here instead of per emitter from the raw spec.
 */

import type { OpenApiSpecInput } from "./codegen.ts"
import { parseOpenApiPath, toIR } from "./codegen-ir.ts"
import type { IR, IRMultipartPart, IROperation, IRParam, IRPathSegment, IRSchema } from "./codegen-ir.ts"
import { cmpCodeUnit } from "./codegen-lang.ts"

export type SdkBody =
	| { kind: "json"; contentType: string; schema: IRSchema; required: boolean }
	| { kind: "form"; contentType: string; schema: IRSchema; required: boolean }
	| { kind: "multipart"; contentType: string; parts: IRMultipartPart[]; required: boolean }
	| { kind: "binary"; contentType: string; required: boolean }
	| { kind: "text"; contentType: string; required: boolean }

export type SdkResponseKind = "json" | "text" | "binary" | "none"

export type SdkSuccess = {
	kind: SdkResponseKind
	status: string
	contentType?: string
	schema?: IRSchema
}

export type SdkStream = "sse" | "ws" | "realtime" | null

export type SdkOp = {
	ir: IROperation
	/** Raw OpenAPI operation, only for shape checks the IR does not carry (error envelopes). */
	raw: Record<string, unknown>
	id: string
	segments: string[]
	method: string
	path: string
	pathSegments: IRPathSegment[]
	pathParams: IRParam[]
	/** Query params, code-unit sorted by name. */
	query: IRParam[]
	headers: IRParam[]
	body?: SdkBody
	success: SdkSuccess
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
	/** Schema names in code-unit order. */
	schemaNames: string[]
	/** Follows `ref` nodes to the component schema; unknown refs resolve to `unknown`. */
	resolve: (schema: IRSchema) => IRSchema
}

export function mediaEssence(contentType: string): string {
	return contentType.split(";")[0]?.trim().toLowerCase() ?? ""
}

export function isJsonMedia(contentType: string): boolean {
	const e = mediaEssence(contentType)
	return e === "application/json" || e.endsWith("+json")
}

function isTextMedia(contentType: string): boolean {
	const e = mediaEssence(contentType)
	return e.startsWith("text/") || e === "application/xml" || e.endsWith("+xml")
}

function classifyResponse(contentType: string | undefined): SdkResponseKind {
	if (!contentType) return "none"
	if (isJsonMedia(contentType)) return "json"
	if (mediaEssence(contentType) === "text/event-stream") return "none"
	if (isTextMedia(contentType)) return "text"
	return "binary"
}

function successOf(op: IROperation): SdkSuccess {
	const codes = Object.keys(op.responses)
		.map((s) => ({ code: Number.parseInt(s, 10), status: s }))
		.filter((x) => /^[0-9]{3}$/.test(x.status) && x.code >= 200 && x.code < 300)
		.sort((a, b) => a.code - b.code)
	const preferred = codes.find((c) => op.responses[c.status]?.contentType !== undefined) ?? codes[0]
	if (!preferred) {
		/* only `default` or 2XX ranges: treat as JSON when they carry JSON, else unknown */
		const fallback = op.responses["2XX"] ?? op.responses.default
		if (fallback?.contentType && isJsonMedia(fallback.contentType)) {
			const out: SdkSuccess = { contentType: fallback.contentType, kind: "json", status: fallback.status }
			if (fallback.schema) out.schema = fallback.schema
			return out
		}
		return { kind: Object.keys(op.responses).length === 0 ? "json" : "none", status: "200" }
	}
	const resp = op.responses[preferred.status]
	const kind = preferred.code === 204 || preferred.code === 205 ? "none" : classifyResponse(resp?.contentType)
	const out: SdkSuccess = { kind, status: preferred.status }
	if (resp?.contentType) out.contentType = resp.contentType
	if (resp?.schema && kind === "json") out.schema = resp.schema
	return out
}

function bodyOf(op: IROperation, resolve: (s: IRSchema) => IRSchema): SdkBody | undefined {
	const b = op.body
	if (!b) return undefined
	if (b.kind === "stream") return { contentType: b.contentType, kind: "binary", required: b.required }
	if (b.kind === "multipart") {
		return { contentType: b.contentType, kind: "multipart", parts: b.parts, required: b.required }
	}
	const essence = mediaEssence(b.contentType)
	if (isJsonMedia(b.contentType)) {
		return { contentType: b.contentType, kind: "json", required: b.required, schema: b.schema }
	}
	if (essence === "application/x-www-form-urlencoded") {
		return { contentType: b.contentType, kind: "form", required: b.required, schema: b.schema }
	}
	if (essence === "multipart/form-data") {
		/* text-only multipart: every property is a text part */
		const resolved = resolve(b.schema)
		const parts: IRMultipartPart[] =
			resolved.kind === "object" ? resolved.fields.map((f) => ({ name: f.name, schema: f.schema, type: "text" })) : []
		return { contentType: b.contentType, kind: "multipart", parts, required: b.required }
	}
	if (isTextMedia(b.contentType)) return { contentType: b.contentType, kind: "text", required: b.required }
	return { contentType: b.contentType, kind: "binary", required: b.required }
}

export function buildSdkModel(spec: OpenApiSpecInput): SdkModel {
	const ir = toIR(spec, { deriveOperationIds: true })

	const resolve = (schema: IRSchema): IRSchema => {
		let cur = schema
		for (let i = 0; i < 32 && cur.kind === "ref"; i++) {
			const next = Object.hasOwn(ir.schemas, cur.name) ? ir.schemas[cur.name] : undefined
			if (!next) return { kind: "unknown" }
			cur = next
		}
		return cur
	}

	const rawById = new Map<string, Record<string, unknown>>()
	for (const pathItem of Object.values(spec.paths ?? {})) {
		for (const op of Object.values(pathItem as Record<string, unknown>)) {
			if (op && typeof op === "object" && typeof (op as Record<string, unknown>).operationId === "string") {
				rawById.set((op as Record<string, unknown>).operationId as string, op as Record<string, unknown>)
			}
		}
	}

	const ops: SdkOp[] = []
	const opsById = new Map<string, SdkOp>()
	for (const op of ir.operations) {
		const ext = op.extensions
		let stream: SdkStream = null
		if (ext.realtime) stream = "realtime"
		else if (ext.websocket) stream = "ws"
		else if (ext.sse) stream = "sse"

		const errorStatuses = Object.keys(op.responses)
			.filter((s) => /^[0-9]{3}$/.test(s))
			.map(Number)
			.filter((n) => n >= 400)
			.sort((a, b) => a - b)

		const sdkOp: SdkOp = {
			body: bodyOf(op, resolve),
			deprecated: ext.deprecated === true,
			description: op.description ?? "",
			errorStatuses,
			headers: op.params.header,
			id: op.id,
			idempotent: ext.idempotencyKey === true,
			invalidates: ext.invalidates ?? [],
			ir: op,
			method: op.method,
			path: op.path,
			pathParams: op.params.path,
			pathSegments: parseOpenApiPath(op.path),
			query: [...op.params.query].sort((a, b) => cmpCodeUnit(a.name, b.name)),
			raw: rawById.get(op.id) ?? {},
			segments: op.id.split("."),
			stream,
			success: successOf(op),
			summary: op.summary ?? "",
		}
		ops.push(sdkOp)
		opsById.set(op.id, sdkOp)
	}

	const schemaNames = Object.keys(ir.schemas).sort(cmpCodeUnit)
	return { ir, ops, opsById, resolve, schemaNames }
}

/** Refs a schema reaches by value: through fields, allOf, nullable and union variants, not through containers. */
function valueRefs(schema: IRSchema, out: Set<string>): void {
	switch (schema.kind) {
		case "ref":
			out.add(schema.name)
			return
		case "object":
			for (const f of schema.fields) valueRefs(f.schema, out)
			return
		case "allOf":
			for (const p of schema.parts) valueRefs(p, out)
			return
		case "nullable":
			valueRefs(schema.inner, out)
			return
		case "union":
			for (const v of schema.variants) valueRefs(v, out)
			return
		default:
			return
	}
}

/** Component schemas on a by-value reference cycle (direct or mutual). Such references need a pointer or `Box`. */
export function valueCycleSchemas(schemas: Record<string, IRSchema>): Set<string> {
	const edges = new Map<string, Set<string>>()
	for (const [name, schema] of Object.entries(schemas)) {
		const refs = new Set<string>()
		valueRefs(schema, refs)
		edges.set(name, refs)
	}
	const cyclic = new Set<string>()
	for (const start of edges.keys()) {
		const seen = new Set<string>()
		const stack = [...(edges.get(start) ?? [])]
		while (stack.length > 0) {
			const cur = stack.pop() as string
			if (cur === start) {
				cyclic.add(start)
				break
			}
			if (seen.has(cur)) continue
			seen.add(cur)
			for (const next of edges.get(cur) ?? []) stack.push(next)
		}
	}
	return cyclic
}
