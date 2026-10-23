/**
 * An operation's typed response headers (bit 16 phase c2, A1/A2): the Java port of C#'s `<Op>Headers` holder
 * (`csharp/sdk-answer.ts`). The holder is a public, mutable class, one `public` accessor per declared header in
 * code-unit order of its name, typed by the header's scalar (`Long`, `Double`, `Boolean`, else `String`). Its
 * package-private `read` fills it from a 2xx's headers (lower-case names); a required header that is missing or does
 * not parse is a DecodeException, an optional one that is absent is null. The method takes it as the middle argument
 * of its three-argument overload, which only an operation declaring response headers gets.
 */
import type { IRResponse, IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { javaString } from "../shared/escape.ts"
import { camelWords, compareCodeUnits, javaIdentifier, NameScope } from "../shared/lang.ts"
import type { JavaTypeContext } from "./models.ts"
import { assigned, docOf } from "./sdk-decl.ts"
import { opTypeName } from "./sdk-params.ts"

/** The holder's type, its file's declaration lines, and each declared header (as written) to its accessor. */
export type JavaHeaders = {
	readonly type: string
	readonly lines: string[]
	readonly fields: Readonly<Record<string, string>>
}

type Header = NonNullable<IRResponse["headers"]>[number]

/** The names an accessor may not take: the holder's own members, Object's, and the `read` parameters' (which shadow a field). */
const HOLDER_MEMBERS = [
	"clone",
	"equals",
	"finalize",
	"getClass",
	"hashCode",
	"headers",
	"notify",
	"notifyAll",
	"read",
	"toString",
	"wait",
]

/** The headers `op`'s 2xx responses declare, statuses ascending, a name's first spelling (any casing) kept; by name. */
function declaredHeaders(op: SdkOp): Header[] {
	const all = Object.keys(op.ir.responses)
		.filter((status) => /^2(?:\d\d|XX)$/i.test(status))
		.sort(compareCodeUnits)
		.flatMap((status) => (op.ir.responses[status] as IRResponse).headers ?? [])
	/* reversed, so the first spelling of a name is the one its key ends on */
	const first = new Map(all.toReversed().map((header) => [header.name.toLowerCase(), header]))
	return [...first.values()].sort((a, b) => compareCodeUnits(a.name, b.name))
}

/** A header's Java type, its parser, and the word its unparsable message names: a `Long`, `Double` or `Boolean` scalar parses strictly; anything else is its text. */
function scalarOf(
	schema: IRSchema,
	ctx: JavaTypeContext,
): { readonly java: string; readonly parse: string; readonly word: string } {
	const resolved = ctx.names.resolve(schema)
	if (resolved.kind === "scalar" && resolved.type === "integer")
		return { java: "Long", parse: "Long::parseLong", word: "integer" }
	if (resolved.kind === "scalar" && resolved.type === "number")
		return { java: "Double", parse: "Double::parseDouble", word: "number" }
	if (resolved.kind === "scalar" && resolved.type === "boolean")
		return { java: "Boolean", parse: "Answer::flag", word: "boolean" }
	return { java: "String", parse: "value -> value", word: "text" }
}

/** `<Op>Headers` for `op`, or null when its 2xx responses declare no header. */
export function javaResponseHeaders(op: SdkOp, env: { readonly ctx: JavaTypeContext }): JavaHeaders | null {
	const headers = declaredHeaders(op)
	if (headers.length === 0) return null
	const type = opTypeName(op, "Headers", env.ctx)
	const scope = new NameScope(HOLDER_MEMBERS)
	const fields = headers.map((header) => {
		const scalar = scalarOf(header.schema, env.ctx)
		return { accessor: scope.claim(javaIdentifier(camelWords(header.name))), header, ...scalar }
	})
	const lines = [
		docOf(`The response headers of ${op.id}, set when the call answers 2xx.`, ""),
		`public final class ${type} {`,
		...fields.map(({ accessor, java }) => `  private ${java} ${accessor};`),
		"",
		...fields.flatMap(({ accessor, java }) => [
			`  public ${java} ${accessor}() {`,
			`    return ${accessor};`,
			"  }",
			"",
		]),
		"  void read(Map<String, String> headers) {",
		...fields.flatMap(({ accessor, header, parse, word }) =>
			assigned("    ", accessor, {
				items: ["headers", javaString(header.name), String(header.required === true), javaString(word), parse],
				prefix: "Answer.header(",
				suffix: ");",
			}),
		),
		"  }",
		"}",
	]
	return {
		fields: Object.fromEntries(fields.map(({ accessor, header }) => [header.name, accessor])),
		lines,
		type,
	}
}
