/**
 * The Jackson binding text the Java models emit (bit 16 phase b, B4): a union's nested `Deserializer`, which reads the
 * discriminator and dispatches each value to its wrapper, and an integer enum's `@JsonValue` and `@JsonCreator`. The
 * mapper config is the runtime's (Json.java); this file holds no mapper.
 */
import { javaString } from "../shared/escape.ts"

/** One dispatch: the values that select a wrapper, the wrapper, and the payload type it reads. */
export type Dispatch = { readonly values: readonly string[]; readonly wrapper: string; readonly payload: string }

/* a payload's erasure: `Class` takes no type arguments */
const erased = (type: string) => type.replace(/<.*$/, "")

/** One switch arm, `label -> value;`: one line when it fits 100 columns, else broken after `->` as google-java-format breaks it. */
function arm(label: string, value: string): string[] {
	const one = `        ${label} -> ${value};`
	return one.length <= 100 ? [one] : [`        ${label} ->`, `            ${value};`]
}

/** One `case` arm per selecting value, in dispatch order. */
const cases = (dispatch: readonly Dispatch[]): string[] =>
	dispatch.flatMap(({ values, wrapper, payload }) =>
		values.flatMap((value) =>
			arm(`case ${javaString(value)}`, `new ${wrapper}(ctxt.readTreeAsValue(node, ${erased(payload)}.class))`),
		),
	)

/** A union's nested `Deserializer`, two spaces in: from its `final class` line to its closing brace. */
export function deserializerLines(
	name: string,
	property: string,
	dispatch: readonly Dispatch[],
	unknown: string,
): string[] {
	return [
		`  final class Deserializer extends StdDeserializer<${name}> {`,
		"    public Deserializer() {",
		`      super(${name}.class);`,
		"    }",
		"",
		"    @Override",
		`    public ${name} deserialize(JsonParser p, DeserializationContext ctxt) {`,
		"      JsonNode node = ctxt.readTree(p);",
		`      JsonNode kind = node.get(${javaString(property)});`,
		"      String value = kind != null && kind.isString() ? kind.asString() : null;",
		"      if (value == null) {",
		`        return new ${unknown}(node);`,
		"      }",
		"      return switch (value) {",
		...cases(dispatch),
		...arm("default", `new ${unknown}(node)`),
		"      };",
		"    }",
		"  }",
	]
}

/**
 * The members an integer enum adds after its constants: the `long` value, `@JsonValue` and `@JsonCreator fromValue`,
 * which takes only a JSON integer. The caller writes the closing brace.
 */
export function intEnumJsonLines(name: string): string[] {
	return [
		"",
		"  private final long value;",
		"",
		`  ${name}(long value) {`,
		"    this.value = value;",
		"  }",
		"",
		"  @JsonValue",
		"  public long value() {",
		"    return value;",
		"  }",
		"",
		"  @JsonCreator",
		`  public static ${name} fromValue(JsonNode node) {`,
		"    if (node.isIntegralNumber()) {",
		`      for (${name} level : values()) {`,
		"        if (level.value == node.longValue()) {",
		"          return level;",
		"        }",
		"      }",
		"    }",
		`    throw new IllegalArgumentException(node + ${javaString(` is no ${name}`)});`,
		"  }",
	]
}
