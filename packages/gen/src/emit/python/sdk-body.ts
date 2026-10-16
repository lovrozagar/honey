/**
 * A multipart body as its method takes it (G4, Fc6): `<Op>Body`, a TypedDict hoisted beside the API's types with
 * a key per part in code-unit order. A file part is the runtime's in-memory `FilePart` (`list[FilePart]` for an
 * array), which types.py imports; a text part is its schema's type. A part the body schema requires is bare, any
 * other `NotRequired[…]` (G8). Spec text reaches the source only through the shared escape layer.
 */
import type { IRMultipartPart, IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { compareCodeUnits, pyClassName } from "../shared/lang.ts"
import type { MethodEnv } from "./sdk-method.ts"
import { dictDecl } from "./types-dict.ts"
import { pyTypeOf } from "./types.ts"

/** The parts the body schema of `op` requires: none unless it is an object. */
function requiredParts(op: SdkOp, env: MethodEnv): Set<string> {
	/* a multipart body, with file parts or text parts alone, is declared with its form's schema */
	const form = env.at.names.resolve((op.ir.body as { schema: IRSchema }).schema)
	return new Set(form.kind === "object" ? form.fields.flatMap((f) => (f.required ? [f.name] : [])) : [])
}

/** The type of `part` as a key of `parent`: `FilePart` or its list for a file, its schema's type for text. */
function partType(part: IRMultipartPart, parent: string, env: MethodEnv): string {
	/* the IR gives every part its schema (ir/slots.ts partsOf, ir/sdk-model.ts bodyOf) */
	const schema = part.schema as IRSchema
	if (part.type === "text") {
		return pyTypeOf(schema, { ...env.at, fieldName: part.name, parentName: parent, typing: env.at.declTyping })
	}
	env.typesImports.add("FilePart")
	return env.at.names.resolve(schema).kind === "array" ? "list[FilePart]" : "FilePart"
}

/** `<Op>Body` for `parts`, declared once into `env.at.decls` (each client's method asks for it); its name. */
export function multipartBody(op: SdkOp, parts: readonly IRMultipartPart[], env: MethodEnv): string {
	const name = env.at.names.hoist(`${op.id}.Body`, `${pyClassName(op.id)}Body`)
	if (env.at.decls.has(name)) return name
	/* claimed before its keys: what a text part hoists in turn comes after it */
	env.at.decls.set(name, "")
	const required = requiredParts(op, env)
	const keys = [...parts]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((part) => {
			const type = partType(part, name, env)
			if (required.has(part.name)) return { key: part.name, type }
			env.at.declTyping.add("NotRequired")
			return { key: part.name, type: `NotRequired[${type}]` }
		})
	env.at.declTyping.add("TypedDict")
	env.at.decls.set(name, dictDecl(name, keys))
	return name
}
