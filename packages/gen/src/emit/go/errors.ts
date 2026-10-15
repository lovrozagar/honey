/**
 * The API's declared error keys in Go (G6/G7): every operation's `x-honey-errors` key as an
 * `Err<Key>` constant of the runtime's `ErrorKey`, which `errors.Is` matches against a
 * `*ClientError` carrying it, and `<Key>Data` for a key whose own schema is inline and not honey's
 * envelope, the type `ClientError.DecodeBody` decodes its body into. Spec text reaches the source
 * only through the shared escape layer.
 */
import type { IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, type SdkModel } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { compareCodeUnits, goExported } from "../shared/lang.ts"
import { type GoTypeContext, goTopLevel } from "./types.ts"

/** Every declared key's schema (the first operation's to declare one), keys in code-unit order. */
function declaredKeys(model: SdkModel): [string, IRSchema | undefined][] {
	const declared = model.ops.flatMap((op) => Object.entries(op.ir.extensions.errors ?? {}))
	/* reversed, so a key ends on its first declaration */
	const first = new Map(declared.toReversed().map(([key, { schema }]) => [key, schema]))
	return [...first].sort(([a], [b]) => compareCodeUnits(a, b))
}

/** What a body carrying `key` decodes into: its component, a new `<Key>Data`, or nothing to name (no schema, the envelope). */
function bodyType(key: string, schema: IRSchema | undefined, model: SdkModel, at: GoTypeContext): string | undefined {
	if (schema === undefined) return undefined
	if (schema.kind === "ref") return at.names.ref(schema.name)
	if (irErrorEnvelope(schema, model.resolve) !== null) return undefined
	const name = at.names.claimConst(`${goExported(key)}Data`)
	at.decls.set(name, goTopLevel(name, schema, at))
	return name
}

/**
 * The `const ( … )` block of every key `model`'s operations declare, `Err<Key>` claimed in code-unit
 * order (a collision gets `…2`), each `<Key>Data` hoisted into `at.decls`; `""` when none declares one.
 */
export function goErrorKeys(model: SdkModel, at: GoTypeContext): string {
	const keys = declaredKeys(model)
	if (keys.length === 0) return ""
	const lines = keys.flatMap(([key, schema]) => {
		const constant = at.names.claimConst(`Err${goExported(key)}`)
		const body = bodyType(key, schema, model, at)
		const doc = body === undefined ? [] : [`\t// ${constant}'s body decodes into ${body} (ClientError.DecodeBody).`]
		return [...doc, `\t${constant} ErrorKey = ${goString(key)}`]
	})
	return [
		...lineComment("The error keys the API declares: errors.Is(err, key) matches a *ClientError carrying key.", "//"),
		"const (",
		...lines,
		")",
	].join("\n")
}
