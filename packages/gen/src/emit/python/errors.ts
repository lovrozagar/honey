/**
 * The API's error keys in Python (G6/G7, Fc3): one `ErrorKey` StrEnum over every key the API declares, in an
 * operation's `x-honey-errors` or as an error response's envelope keys, in the functional form (the class form
 * trips ruff's S105 on a member spelling password, token or secret, and emitted code takes no `noqa`), its
 * members UPPER_SNAKE; the runtime reads a body's key into it through `Defaults.keys`, so it never names a
 * generated type. A key whose own schema is inline and not honey's envelope gets `<Key>Data`, the TypedDict
 * `APIStatusError.decode_body` casts its body to, hoisted among the other declarations. Spec text reaches the
 * source only through the shared escape layer.
 */
import type { IRResponse, IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, isJsonMedia, type SdkModel } from "../../ir/sdk-model.ts"
import { lineComment, pyString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, pyClassName, pyIdentifier } from "../shared/lang.ts"
import { type PyTypeContext, pyTopLevel } from "./types.ts"

/** The keys an error response's envelope names, over every operation's JSON error statuses (the runtime reads JSON only). */
function envelopeKeys(model: SdkModel): string[] {
	return model.ops.flatMap((op) =>
		op.errorStatuses.flatMap((status) => {
			/* an error status is a declared response, and a schema comes with the content type it is under */
			const { contentType, schema } = op.ir.responses[String(status)] as IRResponse
			if (schema === undefined || !isJsonMedia(contentType as string)) return []
			return irErrorEnvelope(schema, model.resolve)?.keys ?? []
		}),
	)
}

/**
 * Every declared key in code-unit order with its schema: `x-honey-errors`' (the first operation by id to declare
 * the key, so the document's path order never changes it), then an envelope's keys, which carry none (Rust's rule).
 */
function declaredKeys(model: SdkModel): [string, IRSchema | undefined][] {
	const byId = [...model.ops].sort((a, b) => compareCodeUnits(a.id, b.id))
	const declared = byId.flatMap((op) => Object.entries(op.ir.extensions.errors ?? {}))
	/* a later entry wins: an envelope's key gives way to a declaration, each declaration reversed to its first */
	const keys = new Map<string, IRSchema | undefined>([
		...envelopeKeys(model).map((key) => [key, undefined] as const),
		...declared.toReversed().map(([key, { schema }]) => [key, schema] as const),
	])
	return [...keys].sort(([a], [b]) => compareCodeUnits(a, b))
}

/** What a body carrying `key` decodes into: its component, a new `<Key>Data`, or nothing to name (no schema, the envelope). */
function bodyType(key: string, schema: IRSchema | undefined, model: SdkModel, at: PyTypeContext): string | undefined {
	if (schema === undefined) return undefined
	if (schema.kind === "ref") return at.names.ref(schema.name)
	if (irErrorEnvelope(schema, model.resolve) !== null) return undefined
	const name = at.names.claim(`${pyClassName(key)}Data`)
	at.decls.set(name, pyTopLevel(name, schema, at))
	return name
}

/**
 * The `ErrorKey` block for `model`: its doc comment (a line per key whose body decodes into a type), then the
 * functional StrEnum, a member per key in code-unit order (a colliding name gets `…2`); each `<Key>Data` hoisted
 * into `at.decls`. `null` when the API declares no key: nothing else changes then.
 */
export function pythonErrorKeys(model: SdkModel, at: PyTypeContext): string | null {
	const declared = declaredKeys(model)
	if (declared.length === 0) return null
	const members = new NameScope()
	const keys = declared.map(([wire, schema]) => ({
		data: bodyType(wire, schema, model, at),
		/* an UPPER_SNAKE member never meets a keyword, so the keyword guard's `_` goes */
		member: members.claim(pyIdentifier(wire).replace(/_$/, "").toUpperCase()),
		wire,
	}))
	const doc = keys.flatMap(({ data, wire }) =>
		data === undefined ? [] : lineComment(`${wire}: its body decodes into ${data} (APIStatusError.decode_body).`, "#"),
	)
	return [
		"# The error keys the API declares: APIStatusError.key is one of these, else the server's string.",
		...doc,
		"ErrorKey = StrEnum(",
		'    "ErrorKey",',
		"    {",
		...keys.map(({ member, wire }) => `        ${pyString(member)}: ${pyString(wire)},`),
		"    },",
		")",
	].join("\n")
}
