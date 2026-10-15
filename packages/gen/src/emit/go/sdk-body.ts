/**
 * A Go method's request body (G4), by its declared kind: JSON as its Go type, a form as
 * `url.Values`, binary as a streamed `io.Reader`, text as a `string`, and multipart as the hoisted
 * `<Op>Body` (text parts as pointers or slices, file parts as `FilePart`). Spec text reaches the
 * source only through the shared escape layer.
 */
import type { IRMultipartPart, IRScalarType, IRSchema } from "../../ir/model.ts"
import type { SdkBody, SdkOp } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { goExported, NameScope } from "../shared/lang.ts"
import { type GoTypeContext, goTypeOf } from "./types.ts"

/** A method's body: its parameter's type, the statements encoding it (failing with `fail`), and the expression the call sends. */
export type GoBody = { readonly type: string; readonly lines: (fail: string) => string[]; readonly send: string }

/** Where the body lands: the method's body local, and the SDK's type context. */
export type BodyEnv = { readonly local: string; readonly at: GoTypeContext }

/* a body sent as it is: nothing to encode first */
const NO_LINES = () => []

/* a text part's Go type by its scalar type (v0 codegen-go.ts:382-391); any other schema is sent as a string */
const PART_SCALARS: Readonly<Record<IRScalarType, string>> = {
	boolean: "bool",
	integer: "int64",
	null: "string",
	number: "float64",
	string: "string",
}

/** One multipart part as a field of `<Op>Body`: its Go name and type, and the statements appending it to `fields`. */
type PartField = { readonly name: string; readonly type: string; readonly lines: readonly string[] }

/** `fields = append(fields, <part>)` at `indent`. */
const appended = (indent: string, part: string) => `${indent}fields = append(fields, ${part})`

/** The field of `part` named `name` on the body `local`: a list repeats the part, an unset value sends none. */
function partField(part: IRMultipartPart, name: string, local: string, at: GoTypeContext): PartField {
	/* the IR gives every part its schema (ir/slots.ts partsOf, sdk-model bodyOf) */
	const schema = at.names.resolve(part.schema as IRSchema)
	const list = schema.kind === "array"
	const item = schema.kind === "array" ? at.names.resolve(schema.items) : schema
	const key = goString(part.name)
	const field = `${local}.${name}`
	if (part.type === "file") {
		const sent = (value: string) => [`if ${value}.Data != nil {`, appended("\t", `fileField(${key}, ${value})`), "}"]
		const lines = list ? [`for _, v := range ${field} {`, ...sent("v").map((line) => `\t${line}`), "}"] : sent(field)
		return { lines, name, type: list ? "[]FilePart" : "FilePart" }
	}
	const scalar = item.kind === "scalar" ? PART_SCALARS[item.type] : "string"
	const lines = list
		? [`for _, v := range ${field} {`, appended("\t", `textField(${key}, v)`), "}"]
		: [`if ${field} != nil {`, appended("\t", `textField(${key}, *${field})`), "}"]
	return { lines, name, type: list ? `[]${scalar}` : `*${scalar}` }
}

/** A multipart body: `<Op>Body` hoisted into the type context, and the statements encoding it as `mp`. */
function multipartBody(op: SdkOp, parts: readonly IRMultipartPart[], env: BodyEnv): GoBody {
	const type = env.at.names.claimConst(`${goExported(op.id)}Body`)
	const scope = new NameScope()
	const fields = parts.map((part) => partField(part, scope.claim(goExported(part.name)), env.local, env.at))
	const doc = `${type} is the multipart/form-data body of ${op.id}: a nil text part or a file part without Data is not sent.`
	env.at.decls.set(
		type,
		[...lineComment(doc, "//"), `type ${type} struct {`, ...fields.map((f) => `\t${f.name} ${f.type}`), "}"].join("\n"),
	)
	const lines = (fail: string) => [
		"\tvar fields []multipartField",
		...fields.flatMap((field) => field.lines.map((line) => `\t${line}`)),
		"\tmp, err := multipartBody(fields)",
		"\tif err != nil {",
		`\t\treturn ${fail}`,
		"\t}",
	]
	return { lines, send: "mp", type }
}

/** The body of `op` as its method takes and sends it. */
export function goBody(op: SdkOp, body: SdkBody, env: BodyEnv): GoBody {
	const { local } = env
	const contentType = goString(body.contentType)
	switch (body.kind) {
		case "json": {
			const type = goTypeOf(body.schema, { ...env.at, fieldName: "Body", parentName: op.id })
			return { lines: NO_LINES, send: `jsonBody(${local})`, type }
		}
		case "form":
			return { lines: NO_LINES, send: `formBody(${local})`, type: "url.Values" }
		case "binary":
			return { lines: NO_LINES, send: `readerBody(${local}, ${contentType})`, type: "io.Reader" }
		case "text":
			return { lines: NO_LINES, send: `rawBody([]byte(${local}), ${contentType})`, type: "string" }
		case "multipart":
			return multipartBody(op, body.parts, env)
	}
}
