/**
 * What a method takes and answers beyond its params (G3, G4, G5): its body's type by kind, its return type
 * and the transport call it makes in either error mode, the JSON kind its answer (or a typed stream's event) must
 * have, and its `<Op>Headers` TypedDict, hoisted beside the types, with how the runtime reads each header and
 * whether it must arrive (Fc5). A streaming operation answers as its `PyStream` says (`sse.ts`, `ws.ts`,
 * `realtime.ts`), in either error mode.
 */
import type { IRParam, IRResponse, IRSchema } from "../../ir/model.ts"
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

/**
 * What a streaming operation's method is: whether a declared param is one its own fields carry (Fd3), those
 * fields (`name: type = None`, after the declared params), its answer, and the lines its docstring adds.
 */
export type PyStream = {
	readonly carries: (name: string, where: string) => boolean
	readonly fields: readonly string[]
	answer(op: SdkOp, env: MethodEnv): Answer
	readonly doc: readonly string[]
}

/** A streamed event's type: the operation's declared event schema, else `fallback`. */
export const eventType = (op: SdkOp, env: MethodEnv, fallback: string) =>
	op.events === undefined ? fallback : typeAt(op, "Event", op.events, env)

/** The answer of a plain operation `op`: its decoded success, inside `SDKResult` in safe mode. */
export function answerOf(op: SdkOp, env: MethodEnv): Answer {
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

/** The JSON kind a success body, or a typed SSE or realtime event (Fd5), must have, when its schema pins one. */
export function shapeOf(op: SdkOp, env: MethodEnv): string | null {
	if (op.stream === "sse" || op.stream === "realtime") return op.events === undefined ? null : kindOf(op.events, env)
	if (op.stream !== null || op.success.kind !== "json" || op.success.schema === undefined) return null
	return kindOf(op.success.schema, env)
}

/** The JSON kind `declared` pins: an object, array or scalar type; none for any other schema. */
function kindOf(declared: IRSchema, env: MethodEnv): string | null {
	const schema = env.at.names.resolve(declared)
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
