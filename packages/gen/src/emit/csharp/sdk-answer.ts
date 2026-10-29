/**
 * What a method answers (§2.1, C#2) and the response headers it can read (Fc7, §2.2). A JSON answer is its schema's
 * type through `CallAsync`/`NullableAsync`, text a `string` through `TextAsync`, bytes a `byte[]` through
 * `BytesAsync`, none a bare `Task` (its `client.Safe` twin a `Result` of each: sdk-method.ts). An
 * operation whose 2xx responses declare headers gets `<Op>Headers`, a class hoisted beside the types (never listed
 * in the JSON context) with one nullable `{ get; private set; }` property per header in code-unit order of its
 * name, typed by the header's scalar (`long?`, `double?`, `bool?`, else `string?`), and an `internal` `Read` the
 * transport calls on a 2xx; a WebSocket or realtime operation, whose 2xx no caller receives, gets none. A
 * stream operation answers as its `CsStream` says (`sse.ts`, `ws.ts`, `realtime.ts`).
 */
import type { IRResponse, IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csTypeName, NameScope } from "../shared/lang.ts"
import { docLines } from "./sdk-doc.ts"
import type { MethodEnv, Spelling } from "./sdk-method.ts"
import { csTypeOf } from "./types.ts"

const UNKNOWN: IRSchema = { kind: "unknown" }

/** A method's answer: its JSON type (null for any other kind), and its return type and transport method. */
export type CsAnswer = {
	readonly type: string | null
	readonly render: (spell: Spelling) => readonly [returns: string, run: string]
}

/**
 * What a stream operation's method is (contract 50 §2): whether a declared param is one its own fields carry (the
 * fold), those fields (each `<type> <ident> = null`, after `headersInto`), the arguments its call passes after the
 * `Call`, its answer, and its `<returns>` text.
 */
export type CsStream = {
	readonly carries: (name: string, where: string) => boolean
	readonly fields: readonly { readonly ident: string; readonly type: string }[]
	readonly args: readonly string[]
	answer(op: SdkOp, env: MethodEnv): CsAnswer
	readonly returns: string
}

/** The C# type of `op`'s declared event schema `events`. */
export const eventType = (events: IRSchema, op: SdkOp, env: MethodEnv) =>
	csTypeOf(events, { ...env.at, fieldName: "Event", parentName: op.id })

/** The `<Op>Headers` holder's type and each declared header (as written) to its property. */
export type CsHeadersPlan = { readonly type: string; readonly fields: Readonly<Record<string, string>> }

/** How an answer is typed and which transport method reads it, by its kind (`json?` a nullable one). */
const ANSWERS: Readonly<Record<string, (type: string) => [string, string]>> = {
	binary: () => ["Task<byte[]>", "BytesAsync"],
	json: (t) => [`Task<${t}>`, "CallAsync"],
	"json?": (t) => [`Task<${t}>`, "NullableAsync"],
	none: () => ["Task", "CallAsync"],
	text: () => ["Task<string>", "TextAsync"],
}

/** A signature's spelling of `type`: its runtime type, keeping a nullable reference's `?` at the top. */
export const signatureType = (type: string, spell: Spelling) =>
	`${spell.runtime(type).replace(/\?$/, "")}${type.endsWith("?") ? "?" : ""}`

/** The answer of `op`: `T` typed as the signature spells it. */
export function csAnswer(op: SdkOp, env: MethodEnv): CsAnswer {
	const json = op.success.kind === "json"
	const type = json
		? csTypeOf(op.success.schema ?? UNKNOWN, { ...env.at, fieldName: "Response", parentName: op.id })
		: null
	const kind = type === null ? op.success.kind : `json${type.endsWith("?") ? "?" : ""}`
	return {
		render: (spell) => (ANSWERS[kind] as (typeof ANSWERS)[string])(type === null ? "" : signatureType(type, spell)),
		type,
	}
}

type Header = NonNullable<IRResponse["headers"]>[number]

/** The headers `op`'s 2xx responses declare, statuses ascending, a name's first spelling (any casing) kept; by name. */
function declaredHeaders(op: SdkOp): Header[] {
	if (op.stream === "ws" || op.stream === "realtime") return []
	const all = Object.keys(op.ir.responses)
		.filter((status) => /^2(?:\d\d|XX)$/i.test(status))
		.sort(compareCodeUnits)
		.flatMap((status) => (op.ir.responses[status] as IRResponse).headers ?? [])
	/* reversed, so the first spelling of a name is the one its key ends on */
	const first = new Map(all.toReversed().map((header) => [header.name.toLowerCase(), header]))
	return [...first.values()].sort((a, b) => compareCodeUnits(a.name, b.name))
}

/* a scalar header's C# type and its reader; anything else is its text */
const READERS: Readonly<Record<string, readonly [string, string]>> = {
	boolean: ["bool?", "Bool"],
	integer: ["long?", "Int64"],
	number: ["double?", "Double"],
}

/* the holder's own members and the members every class has */
const HOLDER_MEMBERS = ["Equals", "Finalize", "GetHashCode", "GetType", "MemberwiseClone", "Read", "ToString"]

/** `<Op>Headers` hoisted into `env.at.decls` (never listed), and its plan; null when `op` declares none. */
export function csResponseHeaders(op: SdkOp, env: MethodEnv): { readonly plan: CsHeadersPlan } | null {
	const headers = declaredHeaders(op)
	if (headers.length === 0) return null
	const type = env.at.names.claim(`${csTypeName(op.id)}Headers`)
	env.at.unlisted.add(type)
	const scope = new NameScope([...HOLDER_MEMBERS, type])
	const fields = headers.map((header) => {
		const resolved = env.at.names.resolve(header.schema)
		const [cs, reader] = (resolved.kind === "scalar" && READERS[resolved.type]) || ["string?", "Text"]
		return {
			cs,
			header: header.name,
			property: scope.claim(csTypeName(header.name)),
			reader,
			required: header.required,
		}
	})
	env.at.decls.set(
		type,
		[
			...docLines("summary", `The response headers of ${op.id}, set when the call answers 2xx.`),
			`public sealed class ${type}`,
			"{",
			...fields.flatMap(({ cs, property }, i) => [
				...(i > 0 ? [""] : []),
				`    public ${cs} ${property} { get; private set; }`,
			]),
			"",
			"    internal void Read(IReadOnlyDictionary<string, string> headers)",
			"    {",
			...fields.map(
				(f) =>
					`        ${f.property} = ResponseHeaders.${f.reader}(headers, ${csString(f.header)}, required: ${f.required === true});`,
			),
			"    }",
			"}",
		].join("\n"),
	)
	return { plan: { fields: Object.fromEntries(fields.map((f) => [f.header, f.property])), type } }
}
