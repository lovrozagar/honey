/**
 * A Rust method's request body (G4), by its declared kind: JSON and a form as a borrowed `&<T>` encoded at
 * once, text as `&str`, binary as the runtime's `Body`, and multipart as a borrowed `<Op>Body` hoisted beside
 * the API's types: a text part as `Option<T>` (a list as `Vec<T>`), a file part as `Option<FilePart>` (a list
 * as `Vec<FilePart>`), each added to the runtime's encoder by name. Spec text reaches the source only through
 * the shared escape layer.
 */
import type { IRMultipartPart, IRSchema } from "../../ir/model.ts"
import type { SdkBody, SdkOp } from "../../ir/sdk-model.ts"
import { lineComment, rustString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, rustTypeIdent, rustValueIdent } from "../shared/lang.ts"
import { unboxed } from "./types-struct.ts"
import { type RustTypeContext, rustTypeOf } from "./types.ts"

/** A method's body: its parameter's type, and the statements encoding it into `spec`. */
export type RustBody = { readonly type: string; readonly lines: readonly string[] }

/** `schema`'s Rust type at `<parent><field>`, a component reference unboxed. */
export const typeAt = (schema: IRSchema, parent: string, field: string, at: RustTypeContext): string =>
	unboxed(schema, rustTypeOf(schema, { ...at, fieldName: field, parentName: parent }))

/** One part as a field of `<Op>Body`: its declaration and the statement adding it to `form`. */
type PartField = { readonly decl: string; readonly line: string }

/** The field of `part` named `ident` on the struct `parent`: its type by the part's kind, and its statement. */
function partField(part: IRMultipartPart, ident: string, parent: string, at: RustTypeContext): PartField {
	/* the IR gives every part its schema (ir/slots.ts partsOf) */
	const declared = part.schema as IRSchema
	const schema = at.names.resolve(declared)
	const call = part.type === "file" ? "files" : "text"
	const line = `form.${call}(${rustString(part.name)}, &body.${ident});`
	if (part.type === "file") {
		return { decl: schema.kind === "array" ? "Vec<crate::FilePart>" : "Option<crate::FilePart>", line }
	}
	if (schema.kind === "array") return { decl: `Vec<${typeAt(schema.items, parent, part.name, at)}>`, line }
	return { decl: `Option<${typeAt(declared, parent, part.name, at)}>`, line }
}

/** A multipart body: `<Op>Body` hoisted into `at.decls`, a field per part in name order, and the encoder filled from it. */
function multipartBody(op: SdkOp, parts: readonly IRMultipartPart[], at: RustTypeContext): RustBody {
	const type = at.names.claim(`${rustTypeIdent(op.id)}Body`)
	const scope = new NameScope()
	const sorted = [...parts].sort((a, b) => compareCodeUnits(a.name, b.name))
	const fields = sorted.map((part) => {
		const ident = scope.claim(rustValueIdent(part.name))
		return { ident, ...partField(part, ident, type, at) }
	})
	const doc = `The multipart/form-data parts of ${op.id}'s body: None and an empty list send no part.`
	/* never empty: a body is multipart only with a file part (ir/slots.ts bodyOf) */
	const decl = [
		...lineComment(doc, "///"),
		"#[derive(Debug, Clone, Default)]",
		`pub struct ${type} {`,
		...fields.map((f) => `    pub ${f.ident}: ${f.decl},`),
		"}",
	]
	at.decls.set(type, decl.join("\n"))
	const lines = ["let mut form = crate::body::Multipart::new();", ...fields.map((f) => f.line), "spec.multipart(form);"]
	return { lines, type: `&${type}` }
}

/** The body of `op` as its method takes it, and the statements encoding it into the spec at once. */
export function rustBody(op: SdkOp, body: SdkBody, at: RustTypeContext): RustBody {
	if (body.kind === "multipart") return multipartBody(op, body.parts, at)
	const media = rustString(body.contentType)
	if (body.kind === "text") return { lines: [`spec.text(body, ${media});`], type: "&str" }
	if (body.kind === "binary") return { lines: [`spec.binary(body, ${media});`], type: "Body" }
	return { lines: [`spec.${body.kind}(body, ${media});`], type: `&${typeAt(body.schema, op.id, "Body", at)}` }
}
