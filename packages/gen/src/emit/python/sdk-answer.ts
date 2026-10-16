/**
 * What a method takes and answers beyond its params (G3, G4, G5): its body's type by kind, its return type
 * and the transport call it makes in either error mode or as a stream, the JSON kind its answer must have, and
 * its `<Op>Headers` TypedDict, hoisted beside the types, with how the runtime reads each header and whether it
 * must arrive (Fc5).
 */
import type { IRParam, IRResponse } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { pyString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, pyClassName, pyIdentifier } from "../shared/lang.ts"
import { multipartBody } from "./sdk-body.ts"
import type { MethodEnv } from "./sdk-method.ts"
import { pyTypeOf } from "./types.ts"

/** `schema`'s type at `<Op><field>`, written in the client module. */
export const typeAt = (op: SdkOp, field: string, schema: IRParam["schema"], env: MethodEnv) =>
	pyTypeOf(schema, { ...env.at, fieldName: field, parentName: op.id })

/** The body parameter's type: its schema's for JSON and a form, `<Op>Body` for multipart, `str` for text, bytes or chunks for binary. */
export function bodyType(op: SdkOp, async: boolean, env: MethodEnv): string | null {
	const body = op.body
	if (body === undefined) return null
	if (body.kind === "text") return "str"
	if (body.kind === "binary") {
		env.imports.add(async ? "AsyncIterable" : "Iterable")
		return async ? "bytes | AsyncIterable[bytes]" : "bytes | Iterable[bytes]"
	}
	return body.kind === "multipart" ? multipartBody(op, body.parts, env) : typeAt(op, "Body", body.schema, env)
}

/** What a method answers (its `Operation`'s type and its return type), and the transport call it makes. */
export type Answer = { readonly type: string; readonly returns: string; readonly run: string }

/** The answer of `op`: a stream's own, else its decoded success, inside `SDKResult` in safe mode. */
export function answerOf(op: SdkOp, env: MethodEnv): Answer {
	const events = (fallback: string) => (op.events === undefined ? fallback : typeAt(op, "Event", op.events, env))
	if (op.stream === "sse") return { returns: `EventStream[${events("str")}]`, run: "sse", type: events("str") }
	if (op.stream === "ws") return { returns: "TypedWebSocket", run: "websocket", type: "None" }
	if (op.stream === "realtime") {
		const type = events(pyTypeOf({ kind: "unknown" }, env.at))
		return { returns: `ResumableConnection[${type}]`, run: "realtime", type }
	}
	const { kind, schema } = op.success
	const type =
		kind === "text"
			? "str"
			: kind === "binary"
				? "bytes"
				: schema === undefined
					? "None"
					: typeAt(op, "Response", schema, env)
	return env.throwOnError
		? { returns: type, run: "call", type }
		: { returns: `SDKResult[${type}]`, run: "result", type }
}

/** The JSON kind a success body must have, when its schema pins one. */
export function shapeOf(op: SdkOp, env: MethodEnv): string | null {
	if (op.stream !== null || op.success.kind !== "json" || op.success.schema === undefined) return null
	const schema = env.at.names.resolve(op.success.schema)
	if (schema.kind === "object" || schema.kind === "allOf") return "object"
	if (schema.kind === "array" || schema.kind === "tuple") return "array"
	if (schema.kind !== "scalar" || schema.type === "null") return null
	return schema.type === "integer" ? "number" : schema.type
}

/** The headers `op`'s 2xx responses declare, statuses ascending, a name's first spelling kept; by name. */
function declaredHeaders(op: SdkOp): NonNullable<IRResponse["headers"]> {
	if (op.stream === "ws" || op.stream === "realtime") return []
	const all = Object.keys(op.ir.responses)
		.filter((status) => /^2(?:\d\d|XX)$/i.test(status))
		.sort(compareCodeUnits)
		.flatMap((status) => (op.ir.responses[status] as IRResponse).headers ?? [])
	const first = new Map(all.toReversed().map((header) => [header.name.toLowerCase(), header]))
	return [...first.values()].sort((a, b) => compareCodeUnits(a.name, b.name))
}

/** `<Op>Headers` (total=False) hoisted beside the types, and how `Operation.headers` reads each; null without any. */
export function responseHeaders(op: SdkOp, env: MethodEnv) {
	const headers = declaredHeaders(op)
	if (headers.length === 0) return null
	const typing = env.at.declTyping
	const type = env.at.names.claim(`${pyClassName(op.id)}Headers`)
	const scope = new NameScope()
	const fields = headers.map((header) => {
		const resolved = env.at.names.resolve(header.schema)
		const at = { ...env.at, fieldName: header.name, parentName: type, typing }
		/* a scalar is read as its kind; any other schema as the header's text, which is what arrives */
		const read =
			resolved.kind === "scalar" && resolved.type !== "null"
				? { kind: resolved.type, type: pyTypeOf(header.schema, at) }
				: { kind: "string", type: "str" }
		return { header: header.name, key: scope.claim(pyIdentifier(header.name)), required: header.required, ...read }
	})
	typing.add("TypedDict")
	/* every key is an identifier (pyIdentifier), so the class form always spells it */
	env.at.decls.set(
		type,
		[`class ${type}(TypedDict, total=False):`, ...fields.map((f) => `    ${f.key}: ${f.type}`)].join("\n"),
	)
	const read = fields.map(
		({ header, key, kind, required }) =>
			`(${pyString(header)}, ${pyString(key)}, ${pyString(kind)}, ${required ? "True" : "False"})`,
	)
	return { plan: { fields: Object.fromEntries(fields.map((f) => [f.header, f.key])), type }, read }
}
