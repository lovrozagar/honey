/**
 * The API's error keys in C# (Fc3, §2.3): a `public static class ErrorKey` of `public const string` members over
 * every key the API declares, in an operation's `x-honey-errors` or as an error response's envelope keys, in
 * code-unit order of the key, so `ApiStatusException.Key` (the server's own string) compares, switches and matches
 * against a constant with no conversion and an undeclared key stays the server's string. A key whose own schema is
 * inline, declares a type and is not honey's envelope gets `<Key>Data`, the type `DecodeBody<T>()` reads its body
 * into, hoisted among the declarations (and so listed in the JSON context); a ref's component is listed already.
 * No key: nothing is emitted. Spec text reaches the source only through the shared escape layer.
 */
import type { IRResponse, IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, isJsonMedia, type SdkModel } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csTypeName, NameScope } from "../shared/lang.ts"
import { docLines } from "./sdk-doc.ts"
import { type CsTypeContext, csTopLevel, declares } from "./types.ts"

/* the class's own name (CS0542) and the members a static class would hide (CS0108 under warnings as errors) */
const RESERVED = ["ErrorKey", "Equals", "GetHashCode", "GetType", "MemberwiseClone", "ReferenceEquals", "ToString"]

/** The keys an error response's envelope names, over every operation's JSON error statuses. */
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
 * the key, so the document's path order never changes it), over an envelope's keys, which carry none.
 */
function declaredKeys(model: SdkModel): [string, IRSchema | undefined][] {
	const byId = [...model.ops].sort((a, b) => compareCodeUnits(a.id, b.id))
	const declared = byId.flatMap((op) => Object.entries(op.ir.extensions.errors ?? {}))
	const keys = new Map<string, IRSchema | undefined>([
		...envelopeKeys(model).map((key) => [key, undefined] as const),
		...declared.toReversed().map(([key, { schema }]) => [key, schema] as const),
	])
	return [...keys].sort(([a], [b]) => compareCodeUnits(a, b))
}

/** What a body carrying `key` decodes into: a declared component, a new `<Key>Data`, or nothing to name. */
function bodyType(key: string, schema: IRSchema | undefined, model: SdkModel, at: CsTypeContext): string | undefined {
	if (schema === undefined) return undefined
	if (schema.kind === "ref") return at.names.alias(schema.name) === undefined ? at.names.ref(schema.name) : undefined
	if (!declares(schema) || irErrorEnvelope(schema, model.resolve) !== null) return undefined
	const name = at.names.claim(`${csTypeName(key)}Data`)
	/* claimed before its body: what the body hoists in turn comes after it */
	at.decls.set(name, "")
	at.decls.set(name, csTopLevel(name, schema, at))
	return name
}

/**
 * `ErrorKey` for `model`: its summary, a remark naming each key's body type, then a constant per key in code-unit
 * order (a colliding name gets `…2`); each `<Key>Data` hoisted into `at.decls`. `null` when no key is declared.
 */
export function csharpErrorKeys(model: SdkModel, at: CsTypeContext): string | null {
	const declared = declaredKeys(model)
	if (declared.length === 0) return null
	const members = new NameScope(RESERVED)
	const keys = declared.map(([wire, schema]) => ({
		data: bodyType(wire, schema, model, at),
		member: members.claim(csTypeName(wire)),
		wire,
	}))
	const decoded = keys.flatMap(({ data, wire }) => (data === undefined ? [] : [`${wire}: its body decodes as ${data}`]))
	const remark = decoded.map((line, i) => `${line}${i === 0 ? " (ApiStatusException.DecodeBody)" : ""}.`).join(" ")
	return [
		"/// <summary>The error keys the API declares: ApiStatusException.Key is one of these, else the server's own string.</summary>",
		...docLines("remarks", remark),
		"public static class ErrorKey",
		"{",
		...keys.map(({ member, wire }) => `    public const string ${member} = ${csString(wire)};`),
		"}",
	].join("\n")
}
