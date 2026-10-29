/**
 * Java record text (bit 16 phase c1, C3): an operation's `<Op>Params` record with its builder, one setter per field,
 * `build()` refusing a required field left unset; and a multipart body's `<Op>Body` record, one component per part.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { javaString } from "../shared/escape.ts"
import {
	assign,
	bin,
	call,
	exprStmt,
	field,
	ifOpen,
	local,
	methodHeader,
	newOf,
	param,
	returnStmt,
	statement,
	throwStmt,
	typeHeader,
} from "./layout.ts"
import { docOf } from "./sdk-decl.ts"
import type { OpEnv } from "./sdk-op.ts"
import { type Field, multipartRecord } from "./sdk-params.ts"

/** One builder setter: its doc, `public Builder field(Type field)`, the assignment, `return this`. */
const setterLines = (f: Field): string[] => [
	"",
	docOf(`Sets {@code ${f.name}}.`, "    "),
	...methodHeader(4, {
		modifiers: ["public"],
		name: f.field,
		params: [param(f.type, f.field)],
		returns: "Builder",
	}),
	...statement(6, exprStmt(assign(`this.${f.field}`, f.field))),
	"      return this;",
	"    }",
]

/** `<Op>Params`: the record over `fields`, its static `builder()`, and the builder's setters and `build()`. */
export function paramsRecord(name: string, id: string, fields: readonly Field[]): string[] {
	const setters = fields.flatMap(setterLines)
	const checks = fields
		.filter((f) => f.required)
		.flatMap((f) => [
			...statement(6, ifOpen(bin("==", f.field, "null"))),
			...statement(8, throwStmt(newOf("IllegalStateException", [javaString(`${f.name} is required`)]))),
			"      }",
		])
	return [
		docOf(`The parameters of {@code ${id}}.`, ""),
		...typeHeader(0, {
			components: fields.map((f) => param(f.type, f.field)),
			end: "{",
			kind: "record",
			modifiers: ["public"],
			name,
		}),
		"  /** A builder for the parameters: one setter per field. */",
		"  public static Builder builder() {",
		"    return new Builder();",
		"  }",
		"",
		"  /** Builds the parameters; a required field left unset is an {@link IllegalStateException}. */",
		"  public static final class Builder {",
		...fields.flatMap((f) => field(4, { modifiers: ["private"], name: f.field, type: f.type })),
		...(fields.length > 0 ? [""] : []),
		"    private Builder() {}",
		...setters,
		"",
		"    /** Builds the parameters. */",
		...methodHeader(4, { modifiers: ["public"], name: "build", params: [], returns: name }),
		...checks,
		...statement(
			6,
			returnStmt(
				newOf(
					name,
					fields.map((f) => f.field),
				),
			),
		),
		"    }",
		"  }",
		"}",
		"",
	]
}

/** `<Op>Body`: the multipart body record, one component per part, typed as its `Part` (`FilePart`, a list or text). */
export function multipartRecordLines(
	name: string,
	id: string,
	components: readonly { field: string; type: string }[],
): string[] {
	return [
		docOf(`The multipart body of {@code ${id}}: one component per part.`, ""),
		...typeHeader(0, {
			components: components.map((c) => param(c.type, c.field)),
			end: "{}",
			kind: "record",
			modifiers: ["public"],
			name,
		}),
		"",
	]
}

/** The `multipart` helper of a multipart body: null without a body, else the parts, one per component, in order. */
export function multipartHelper(op: SdkOp, env: OpEnv): string[] {
	const body = op.body
	if (body === undefined || body.kind !== "multipart") return []
	const { components, name } = multipartRecord(op, body.parts, env.ctx, env.isArray)
	const parts = components.map(({ field: component, name: part, type }) => {
		const kind = type === "FilePart" ? "file" : type === "List<FilePart>" ? "files" : "text"
		return call("Body.Part", kind, [javaString(part), call("body", component)])
	})
	return [
		...methodHeader(2, {
			modifiers: ["private", "static"],
			name: "multipart",
			params: [param(name, "body")],
			returns: "Body",
		}),
		...statement(4, ifOpen(bin("==", "body", "null"))),
		"      return null;",
		"    }",
		...statement(4, local({ init: call("List", "of", parts), name: "parts", type: "List<Body.Part>" })),
		"    return Body.multipart(parts);",
		"  }",
		"",
	]
}
