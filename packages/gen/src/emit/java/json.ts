/**
 * The Jackson binding text the Java models emit (bit 16 phase b, B4): a union's nested `Deserializer`, which reads the
 * discriminator and dispatches each value to its wrapper, and an integer enum's `@JsonValue` and `@JsonCreator`. The
 * mapper config is the runtime's (Json.java); this file holds no mapper.
 */
import { javaString } from "../shared/escape.ts"
import {
	bin,
	call,
	classOf,
	type Expr,
	forOpen,
	ifOpen,
	lit,
	local,
	methodHeader,
	newOf,
	param,
	returnStmt,
	rule,
	statement,
	throwStmt,
	typeHeader,
} from "./layout.ts"

/** One dispatch: the values that select a wrapper, the wrapper, and the payload type it reads. */
export type Dispatch = { readonly values: readonly string[]; readonly wrapper: string; readonly payload: string }

/* a payload's erasure: `Class` takes no type arguments */
const erased = (type: string) => type.replace(/<.*$/, "")

/** One switch arm, `case label -> value;` (`default` for no label), in the switch's body. */
const arm = (label: string | null, value: Expr): string[] =>
	statement(8, rule(label === null ? null : lit(label), value))

/** One `case` arm per selecting value, in dispatch order. */
const cases = (dispatch: readonly Dispatch[]): string[] =>
	dispatch.flatMap(({ values, wrapper, payload }) =>
		values.flatMap((value) =>
			arm(javaString(value), newOf(wrapper, [call("ctxt", "readTreeAsValue", ["node", classOf(erased(payload))])])),
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
		...typeHeader(2, {
			end: "{",
			extends: `StdDeserializer<${name}>`,
			kind: "class",
			modifiers: ["final"],
			name: "Deserializer",
		}),
		"    public Deserializer() {",
		...statement(6, { expr: call(null, "super", [classOf(name)]), k: "expr" }),
		"    }",
		"",
		"    @Override",
		...methodHeader(4, {
			end: "{",
			modifiers: ["public"],
			name: "deserialize",
			params: [param("JsonParser", "p"), param("DeserializationContext", "ctxt")],
			returns: name,
		}),
		"      JsonNode node = ctxt.readTree(p);",
		...statement(6, local({ init: call("node", "get", [javaString(property)]), name: "kind", type: "JsonNode" })),
		"      String value = kind != null && kind.isString() ? kind.asString() : null;",
		"      if (value == null) {",
		...statement(8, returnStmt(newOf(unknown, ["node"]))),
		"      }",
		"      return switch (value) {",
		...cases(dispatch),
		...arm(null, newOf(unknown, ["node"])),
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
		...methodHeader(2, { end: "{", name, params: [param("long", "value")] }),
		"    this.value = value;",
		"  }",
		"",
		"  @JsonValue",
		"  public long value() {",
		"    return value;",
		"  }",
		"",
		"  @JsonCreator",
		...methodHeader(2, {
			end: "{",
			modifiers: ["public", "static"],
			name: "fromValue",
			params: [param("JsonNode", "node")],
			returns: name,
		}),
		...statement(4, ifOpen(call("node", "isIntegralNumber"))),
		...statement(6, forOpen(name, "level", call(null, "values"))),
		"        if (level.value == node.longValue()) {",
		"          return level;",
		"        }",
		"      }",
		"    }",
		...statement(4, throwStmt(newOf("IllegalArgumentException", [bin("+", "node", javaString(` is no ${name}`))]))),
		"  }",
	]
}
