/**
 * An operation's `<Op>Params` record and its builder (bit 16 phase c1, C3): one record field per path, body, query and
 * header param, then the idempotency key; the builder has exactly one setter per field, and `build()` refuses a required
 * field left unset. A multipart body is a record of its own, `<Op>Body`, one component per part (C#'s parity).
 */
import type { IRMultipartPart, IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { compareCodeUnits, javaIdentifier, javaTypeName, NameScope } from "../shared/lang.ts"
import { type JavaTypeContext, javaTypeOf } from "./models.ts"

/** One record field: its spec name, its Java identifier and type, where it goes, and whether it is required. */
export type Field = {
	readonly name: string
	readonly field: string
	readonly type: string
	readonly where: "path" | "body" | "query" | "header" | "key"
	readonly required: boolean
}

/** The record's own members, which a component may not take (`builder()` is static). */
const RECORD_RESERVED = ["builder", "equals", "hashCode", "toString"]

/** The idempotency header's spec name: a declared one is the key field itself. */
const KEY_HEADER = "Idempotency-Key"

/** A type's text at the param named `name` of `op`. */
const typeAt = (schema: IRSchema, op: SdkOp, name: string, ctx: JavaTypeContext) =>
	javaTypeOf(schema, { ...ctx, fieldName: name, parentName: op.id })

/** The record's fields in order: path params in path order, the body, the query, the headers, then the key. */
export function fieldsOf(op: SdkOp, ctx: JavaTypeContext): Field[] {
	const scope = new NameScope(RECORD_RESERVED)
	const segments = op.pathSegments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
	const path = segments.flatMap((name) => op.pathParams.filter((p) => p.name === name))
	const query = [...op.query].sort((a, b) => compareCodeUnits(a.name, b.name))
	const headers = [...op.headers].sort((a, b) => compareCodeUnits(a.name, b.name))
	const fields: Field[] = []
	for (const param of path) {
		fields.push({
			field: scope.claim(javaIdentifier(param.name)),
			name: param.name,
			required: true,
			type: "String",
			where: "path",
		})
	}
	const body = op.body
	if (body !== undefined) {
		const type = bodyType(body, op, ctx)
		fields.push({ field: scope.claim("body"), name: "body", required: body.required, type, where: "body" })
	}
	for (const param of query) {
		const type = typeAt(param.schema, op, param.name, ctx)
		fields.push({
			field: scope.claim(javaIdentifier(param.name)),
			name: param.name,
			required: param.required === true,
			type,
			where: "query",
		})
	}
	for (const param of headers) {
		const type = typeAt(param.schema, op, param.name, ctx)
		fields.push({
			field: scope.claim(javaIdentifier(param.name)),
			name: param.name,
			required: param.required === true,
			type,
			where: "header",
		})
	}
	const declared = headers.some((param) => param.name.toLowerCase() === KEY_HEADER.toLowerCase())
	if (op.idempotent && !declared) {
		fields.push({
			field: scope.claim("idempotencyKey"),
			name: KEY_HEADER,
			required: false,
			type: "String",
			where: "key",
		})
	}
	return fields
}

/** A body's Java type: a schema's, `String` for text, `BinaryBody` for binary, `<Op>Body` for multipart. */
function bodyType(body: NonNullable<SdkOp["body"]>, op: SdkOp, ctx: JavaTypeContext): string {
	if (body.kind === "json" || body.kind === "form") return typeAt(body.schema, op, "Body", ctx)
	if (body.kind === "text") return "String"
	if (body.kind === "binary") return "BinaryBody"
	return `${javaTypeName(op.id)}Body`
}

/** The record's name: `<Op>Params`. */
export const paramsName = (op: SdkOp) => `${javaTypeName(op.id)}Params`

/** Each multipart part as a record component: a file's `FilePart` or a list of them, a text part's type. */
export function multipartRecord(
	op: SdkOp,
	parts: readonly IRMultipartPart[],
	ctx: JavaTypeContext,
	isArray: (s: IRSchema) => boolean,
) {
	const scope = new NameScope(["equals", "hashCode", "toString"])
	const sorted = [...parts].sort((a, b) => compareCodeUnits(a.name, b.name))
	const components = sorted.map((part) => {
		const schema = part.schema as IRSchema
		const type =
			part.type === "file" ? (isArray(schema) ? "List<FilePart>" : "FilePart") : typeAt(schema, op, part.name, ctx)
		return { field: scope.claim(javaIdentifier(part.name)), name: part.name, type }
	})
	return { components, name: `${javaTypeName(op.id)}Body` }
}
