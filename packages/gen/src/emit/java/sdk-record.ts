/**
 * Java record text (bit 16 phase c1, C3): an operation's `<Op>Params` record with its builder, one setter per field,
 * `build()` refusing a required field left unset; and a multipart body's `<Op>Body` record, one component per part.
 */
import { javaString } from "../shared/escape.ts"
import { docOf, layout } from "./sdk-decl.ts"
import type { Field } from "./sdk-params.ts"

/** `<Op>Params`: the record over `fields`, its static `builder()`, and the builder's setters and `build()`. */
export function paramsRecord(name: string, id: string, fields: readonly Field[]): string[] {
	const setters = fields.flatMap((f) => [
		"",
		docOf(`Sets {@code ${f.name}}.`, "    "),
		`    public Builder ${f.field}(${f.type} ${f.field}) {`,
		`      this.${f.field} = ${f.field};`,
		"      return this;",
		"    }",
	])
	const checks = fields
		.filter((f) => f.required)
		.flatMap((f) => [
			`      if (${f.field} == null) {`,
			`        throw new IllegalStateException(${javaString(`${f.name} is required`)});`,
			"      }",
		])
	return [
		docOf(`The parameters of {@code ${id}}.`, ""),
		...layout(
			`public record ${name}(`,
			fields.map((f) => `${f.type} ${f.field}`),
			") {",
		),
		"  /** A builder for the parameters: one setter per field. */",
		"  public static Builder builder() {",
		"    return new Builder();",
		"  }",
		"",
		"  /** Builds the parameters; a required field left unset is an {@link IllegalStateException}. */",
		"  public static final class Builder {",
		...fields.map((f) => `    private ${f.type} ${f.field};`),
		...(fields.length > 0 ? [""] : []),
		"    private Builder() {}",
		...setters,
		"",
		"    /** Builds the parameters. */",
		`    public ${name} build() {`,
		...checks,
		...layout(
			`return new ${name}(`,
			fields.map((f) => f.field),
			");",
			"      ",
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
		...layout(
			`public record ${name}(`,
			components.map((c) => `${c.type} ${c.field}`),
			") {}",
		),
		"",
	]
}
