/**
 * A method's body by its kind (§2.1, Fc6): the parameter's C# type and the `Body.*` expression the call passes.
 * JSON is its schema's type through `Body.Json`, with the declared media type when it is not `application/json`
 * (Python's `body.py:76`); a form is its schema's type through `Body.Form`; text is a `string`; binary is the
 * runtime's `BinaryBody` (a `byte[]` or a one-shot `Stream`); multipart is `<Op>Body`, a record hoisted beside the
 * types with one `{ get; init; }` property per part in code-unit order of the part name: a file part the runtime's
 * in-memory `FilePart` (`IReadOnlyList<FilePart>` for an array), a text part its schema's type, `required` where
 * the body schema requires it. `<Op>Body` is never listed in the JSON context; each text part's type is.
 */
import type { IRMultipartPart, IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csTypeName, NameScope } from "../shared/lang.ts"
import { docLines } from "./sdk-doc.ts"
import type { MethodEnv, Spelling } from "./sdk-method.ts"
import { RECORD_MEMBERS } from "./types-record.ts"
import { csTypeOf } from "./types.ts"

/** A body as the method takes and sends it: its parameter type (null: none), its expression, the types it lists. */
export type CsBody = {
	readonly type: string | null
	readonly expr: (spell: Spelling) => string
	readonly types: readonly string[]
}

/** One multipart part: its wire name, its property, its type, and whether it is a file part. */
type Part = {
	readonly name: string
	readonly property: string
	readonly type: string
	readonly file: boolean
	readonly required: boolean
}

const NONE: CsBody = { expr: () => "null", type: null, types: [] }

/** The parts the body schema of `op` requires: none unless it is an object. */
function requiredParts(op: SdkOp, env: MethodEnv): Set<string> {
	/* a multipart body, with file parts or text parts alone, is declared with its form's schema */
	const form = env.at.names.resolve((op.ir.body as { schema: IRSchema }).schema)
	return new Set(form.kind === "object" ? form.fields.flatMap((f) => (f.required ? [f.name] : [])) : [])
}

/** The C# type of `part` as a property of `parent`: `FilePart` or its list for a file, its schema's type for text. */
function partType(part: IRMultipartPart, parent: string, env: MethodEnv): string {
	/* the IR gives every part its schema (ir/slots.ts partsOf, ir/sdk-model.ts bodyOf) */
	const schema = part.schema as IRSchema
	if (part.type === "text") return csTypeOf(schema, { ...env.at, fieldName: part.name, parentName: parent })
	return env.at.names.resolve(schema).kind === "array" ? "IReadOnlyList<FilePart>" : "FilePart"
}

/** `<Op>Body` for `parts`, declared once into `env.at.decls` and never listed; its name and its parts. */
function multipartBody(op: SdkOp, parts: readonly IRMultipartPart[], env: MethodEnv) {
	const name = env.at.names.hoist(`${op.id}.Body`, `${csTypeName(op.id)}Body`)
	/* claimed before its parts: what a text part hoists in turn comes after it */
	env.at.decls.set(name, "")
	env.at.unlisted.add(name)
	const required = requiredParts(op, env)
	const scope = new NameScope([...RECORD_MEMBERS, name])
	const typed: Part[] = [...parts]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((part) => {
			const type = partType(part, name, env)
			/* a part left unset is null: a value type's `?` makes it Nullable<T>, which the context lists */
			return {
				file: part.type === "file",
				name: part.name,
				property: scope.claim(csTypeName(part.name)),
				required: required.has(part.name),
				type: required.has(part.name) ? type : `${type.replace(/\?$/, "")}?`,
			}
		})
	const property = ({ property: own, required: must, type }: Part) =>
		`public ${must ? "required " : ""}${type} ${own} { get; init; }`
	env.at.decls.set(
		name,
		[
			...docLines("summary", `The multipart body of ${op.id}: one part per property.`),
			`public sealed record ${name}`,
			"{",
			...typed.flatMap((part, i) => [...(i > 0 ? [""] : []), `    ${property(part)}`]),
			"}",
		].join("\n"),
	)
	return { name, parts: typed }
}

/** `Part.File`, `Part.Files` or `Part.Text` for one part of `body`. */
function partExpr({ file, name, property, type }: Part, spell: Spelling): string {
	if (file) return `Part.${type.startsWith("FilePart") ? "File" : "Files"}(${csString(name)}, body.${property})`
	return `Part.Text(${csString(name)}, body.${property}, ${spell.info(type)})`
}

/** `expr` for a body the method may be called without: null then. */
const guarded = (op: SdkOp, expr: string) => (op.body?.required === true ? expr : `body is null ? null : ${expr}`)

/** The body of `op`: its parameter type, its `Body.*` expression, and the types the context lists for it. */
export function csBody(op: SdkOp, env: MethodEnv): CsBody {
	const body = op.body
	if (body === undefined) return NONE
	const schemaType = (schema: IRSchema) => csTypeOf(schema, { ...env.at, fieldName: "Body", parentName: op.id })
	const media = csString(body.contentType)
	switch (body.kind) {
		case "json": {
			const type = schemaType(body.schema)
			const declared = body.contentType === "application/json" ? "" : `, ${media}`
			return { expr: (spell) => `Body.Json(body, ${spell.info(type)}${declared})`, type, types: [type] }
		}
		case "form": {
			const type = schemaType(body.schema)
			return { expr: (spell) => `Body.Form(body, ${spell.info(type)})`, type, types: [type] }
		}
		case "text":
			return { expr: () => `Body.Text(body, ${media})`, type: "string", types: [] }
		case "binary":
			return { expr: () => `Body.Binary(body, ${media})`, type: "BinaryBody", types: [] }
		case "multipart": {
			const { name, parts } = multipartBody(op, body.parts, env)
			const expr = (spell: Spelling) =>
				guarded(op, `Body.Multipart([${parts.map((part) => partExpr(part, spell)).join(", ")}])`)
			return { expr, type: name, types: parts.filter((p) => !p.file).map((p) => p.type) }
		}
	}
}
