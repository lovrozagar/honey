/**
 * Java enums and unions (bit 16 phase b, B2, B4): a string enum is a Java `enum` with `@JsonProperty` on each
 * constant, the constant named by a sanitized wire value (words in UPPER_SNAKE, `""` is EMPTY, a digit first is N,
 * a repeat is `…2`). A union of const strings alone is such an enum. A discriminated oneOf or anyOf is a `sealed
 * interface` with record permits: one wrapper per variant, `<Union><Value>`, holding the variant's type as
 * `@JsonValue`, and `<Union>Unknown` for a payload no variant selects. An inline object variant's payload is
 * `<Union><Value>Body`. The nested `Deserializer` reads the discriminator and dispatches by its value: a value a
 * variant's mapping, const or enum property names selects it, a ref with no such property is selected by its name,
 * and any other payload, or none, is `<Union>Unknown` (C#'s Raw). A union with no discriminator declares nothing,
 * unless every variant is a const string.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { javaTopLevel, javaTypeContext } from "./models.ts"

type Json = Record<string, unknown>

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const STRING = { type: "string" }

/** A minimal OpenAPI 3.1 document holding these components. */
const doc = (schemas: Record<string, Json>): OpenApiDocument => ({
	components: { schemas },
	info: { title: "Unions", version: "1" },
	openapi: "3.1.0",
	paths: {},
})

/** An object of `properties`, its `required` keys listed. */
const object = (properties: Json, required: string[] = []): Json => ({ properties, required, type: "object" })

/** The declaration of `name` for `schema`, and every declaration it hoisted (the wrappers, payloads), by name. */
function declare(name: string, schema: Json, components: Record<string, Json> = {}) {
	const ctx = javaTypeContext(toIR(doc(components)), ["AnyrowClient"])
	const text = javaTopLevel(name, schemaToIR(schema), ctx)
	return { decls: Object.fromEntries(ctx.decls), text }
}

/* the wire values of a Java enum, in code-unit order of the file: one @JsonProperty line, then the constant */
const ENUM_COLOR = [
	"public enum Color {",
	'  @JsonProperty("dark")',
	"  DARK,",
	'  @JsonProperty("light")',
	"  LIGHT,",
	'  @JsonProperty("")',
	"  EMPTY,",
	'  @JsonProperty("dark-mode")',
	"  DARK_MODE,",
	'  @JsonProperty("2fa")',
	"  N2FA,",
	'  @JsonProperty("Dark")',
	"  DARK2",
	"}",
].join("\n")

const ENUM_MODE = ["public enum Mode {", '  @JsonProperty("on")', "  ON,", '  @JsonProperty("off")', "  OFF", "}"].join(
	"\n",
)

/* the integer enum Level: L<n> and Neg<n> constants as C# names them, read by @JsonCreator, written by @JsonValue */
const LEVEL = [
	"public enum Level {",
	"  L1(1),",
	"  L2(2),",
	"  Neg3(-3);",
	"",
	"  private final long value;",
	"",
	"  Level(long value) {",
	"    this.value = value;",
	"  }",
	"",
	"  @JsonValue",
	"  public long value() {",
	"    return value;",
	"  }",
	"",
	"  @JsonCreator",
	"  public static Level fromValue(JsonNode node) {",
	"    if (node.isIntegralNumber()) {",
	"      for (Level level : values()) {",
	"        if (level.value == node.longValue()) {",
	"          return level;",
	"        }",
	"      }",
	"    }",
	'    throw new IllegalArgumentException(node + " is no Level");',
	"  }",
	"}",
].join("\n")

/* the discriminated union Pet: a Cat and a Dog by component, a fish inline; its Deserializer dispatches by `kind` */
const PET_UNION = [
	"@JsonDeserialize(using = Pet.Deserializer.class)",
	"public sealed interface Pet permits PetCat, PetDog, PetFish, PetUnknown {",
	"  final class Deserializer extends StdDeserializer<Pet> {",
	"    public Deserializer() {",
	"      super(Pet.class);",
	"    }",
	"",
	"    @Override",
	"    public Pet deserialize(JsonParser p, DeserializationContext ctxt) {",
	"      JsonNode node = ctxt.readTree(p);",
	'      JsonNode kind = node.get("kind");',
	"      String value = kind != null && kind.isString() ? kind.asString() : null;",
	"      if (value == null) {",
	"        return new PetUnknown(node);",
	"      }",
	"      return switch (value) {",
	'        case "cat" -> new PetCat(ctxt.readTreeAsValue(node, Cat.class));',
	'        case "dog" -> new PetDog(ctxt.readTreeAsValue(node, Dog.class));',
	'        case "fish" -> new PetFish(ctxt.readTreeAsValue(node, PetFishBody.class));',
	"        default -> new PetUnknown(node);",
	"      };",
	"    }",
	"  }",
	"}",
].join("\n")

const PET_CAT = "@JsonDeserialize\npublic record PetCat(@JsonValue Cat value) implements Pet {}"
const PET_DOG = "@JsonDeserialize\npublic record PetDog(@JsonValue Dog value) implements Pet {}"
const PET_FISH = "@JsonDeserialize\npublic record PetFish(@JsonValue PetFishBody value) implements Pet {}"
const PET_FISH_BODY = 'public record PetFishBody(@JsonProperty("kind") String kind) {}'
const PET_UNKNOWN = "@JsonDeserialize\npublic record PetUnknown(@JsonValue JsonNode value) implements Pet {}"
const PET_HOISTED = {
	PetCat: PET_CAT,
	PetDog: PET_DOG,
	PetFish: PET_FISH,
	PetFishBody: PET_FISH_BODY,
	PetUnknown: PET_UNKNOWN,
}

/** A Pet's variants: a Cat and a Dog selected by their const `kind`, and a fish written inline. */
const CAT = object({ kind: { const: "cat" } }, ["kind"])
const DOG = object({ kind: { const: "dog" } }, ["kind"])
const FISH = object({ kind: { const: "fish" } }, ["kind"])
const PET = { discriminator: { propertyName: "kind" }, oneOf: [ref("Cat"), ref("Dog"), FISH] }
const PET_COMPONENTS = { Cat: CAT, Dog: DOG }

describe("javaTopLevel: string enums (B2)", () => {
	it("declares an integer enum as a Java enum: L<n> and Neg<n> constants, a @JsonValue long, a @JsonCreator fromValue that takes only a JSON integer", () => {
		expect(declare("Level", { enum: [1, 2, -3], type: "integer" })).toEqual({ decls: {}, text: LEVEL })
	})

	it("declares one constant per value, each with its exact @JsonProperty, sanitized and unique", () => {
		const schema = { enum: ["dark", "light", "", "dark-mode", "2fa", "Dark"], type: "string" }
		expect(declare("Color", schema)).toEqual({ decls: {}, text: ENUM_COLOR })
	})

	it("declares a union of const strings alone as an enum of them, one constant per value", () => {
		const schema = { oneOf: [{ const: "on" }, { const: "off" }] }
		expect(declare("Mode", schema)).toEqual({ decls: {}, text: ENUM_MODE })
	})
})

describe("javaTopLevel: discriminated unions (B2, dispatch by the discriminator)", () => {
	it("declares a sealed interface whose permits are its wrappers, with a nested Deserializer dispatching by kind", () => {
		expect(declare("Pet", PET, PET_COMPONENTS).text).toBe(PET_UNION)
	})

	it("hoists each wrapper as a record implementing the interface, its payload as @JsonValue, and an inline payload as <Union><Value>Body", () => {
		expect(declare("Pet", PET, PET_COMPONENTS).decls).toEqual(PET_HOISTED)
	})
})

describe("the union's selectors and names (B2)", () => {
	it("selects a variant by the values of its discriminator mapping", () => {
		const mapped = { discriminator: { mapping: { meow: "Cat" }, propertyName: "kind" }, oneOf: [ref("Cat")] }
		const text = declare("Pet", mapped, { Cat: object({ name: STRING }) }).text
		expect(text).toContain('        case "meow" -> new PetMeow(ctxt.readTreeAsValue(node, Cat.class));')
	})

	it("selects a ref variant that has no const or enum property by its component's name", () => {
		const opaque = { discriminator: { propertyName: "kind" }, oneOf: [ref("Opaque")] }
		const text = declare("Pet", opaque, { Opaque: object({ name: STRING }) }).text
		expect(text).toContain('        case "Opaque" -> new PetOpaque(ctxt.readTreeAsValue(node, Opaque.class));')
	})

	it("selects a variant by each value of an enum discriminator property", () => {
		const enumKind = object({ kind: { enum: ["a", "b"], type: "string" } }, ["kind"])
		const text = declare("Pet", { discriminator: { propertyName: "kind" }, oneOf: [ref("A")] }, { A: enumKind }).text
		expect(text).toContain('        case "a" -> new PetA(ctxt.readTreeAsValue(node, A.class));')
		expect(text).toContain('        case "b" -> new PetA(ctxt.readTreeAsValue(node, A.class));')
	})

	it("takes a wrapper's name …2 when a component already holds it", () => {
		const text = declare("Pet", PET, { ...PET_COMPONENTS, PetCat: object({ name: STRING }) }).text
		expect(text).toContain("permits PetCat2, PetDog, PetFish, PetUnknown")
	})
})

/* a union of `kinds`, discriminated by `kind`, each variant an inline object of that const */
const kinds = (...values: string[]): Json => ({
	discriminator: { propertyName: "kind" },
	oneOf: values.map((value) => object({ kind: { const: value } }, ["kind"])),
})

/** The header lines of `name`'s sealed interface: from `public sealed interface` to the line its body opens on. */
function header(name: string, schema: Json): string[] {
	const lines = declare(name, schema).text.split("\n")
	const from = lines.findIndex((line) => line.startsWith("public sealed interface"))
	return lines.slice(from, lines.findIndex((line) => line.endsWith(" {")) + 1)
}

describe("javaTopLevel: a sealed interface's header past 100 columns (google-java-format's wrapping)", () => {
	it("breaks before permits, indented four, when the permits then fit", () => {
		expect(header("ShortName", kinds("alphaVariantNumberOne", "betaVariantTwo"))).toEqual([
			"public sealed interface ShortName",
			"    permits ShortNameAlphaVariantNumberOne, ShortNameBetaVariantTwo, ShortNameUnknown {",
		])
	})

	it("puts each permit on its own line, indented eight, when the permits line would still pass 100 columns", () => {
		expect(header("VeryLongUnionName", kinds("firstVariant", "secondVariant", "thirdVariant"))).toEqual([
			"public sealed interface VeryLongUnionName",
			"    permits VeryLongUnionNameFirstVariant,",
			"        VeryLongUnionNameSecondVariant,",
			"        VeryLongUnionNameThirdVariant,",
			"        VeryLongUnionNameUnknown {",
		])
	})
})

describe("javaTopLevel: enum constants and unions with no selecting value (B2, B4)", () => {
	it("names a string enum value with no letter or digit VALUE, its wire value kept", () => {
		expect(declare("Sym", { enum: ["-"], type: "string" })).toEqual({
			decls: {},
			text: ["public enum Sym {", '  @JsonProperty("-")', "  VALUE", "}"].join("\n"),
		})
	})

	it("writes an integer past the int range as a long literal, its constant named by the same value", () => {
		expect(declare("Big", { enum: [3000000000], type: "integer" }).text).toContain("  L3000000000(3000000000L);")
	})

	it("selects a ref to a component that is no object by its name, its payload the component's own type", () => {
		const label = { discriminator: { propertyName: "kind" }, oneOf: [ref("Label")] }
		const text = declare("Pet", label, { Label: STRING }).text
		expect(text).toContain('        case "Label" -> new PetLabel(ctxt.readTreeAsValue(node, String.class));')
	})

	it("declares an inline variant no value selects as a wrapper with no case, named by its position", () => {
		const schema = { discriminator: { propertyName: "kind" }, oneOf: [object({ name: STRING })] }
		const out = declare("Pet", schema)
		expect(out.text).toContain("permits PetVariant0, PetUnknown {")
		expect(out.text).not.toContain('case "')
		expect(Object.keys(out.decls)).toEqual(expect.arrayContaining(["PetVariant0", "PetVariant0Body"]))
	})
})

describe("javaTopLevel: a discriminated union's scalar variant (B2)", () => {
	it("gives a scalar variant no wrapper and no case: only the wrappers of refs and inline objects are permits", () => {
		const schema = { discriminator: { propertyName: "kind" }, oneOf: [ref("Cat"), STRING] }
		const out = declare("Pet", schema, PET_COMPONENTS)
		expect(out.text).toContain("permits PetCat, PetUnknown {")
		expect(out.text).not.toContain("PetString")
	})
})

describe("javaTopLevel: an inline variant no value selects beside a selected one (B2)", () => {
	it("orders the no-value variant first, its empty first value sorting before any selected value", () => {
		const schema = {
			discriminator: { propertyName: "kind" },
			oneOf: [ref("Cat"), object({ name: STRING }), ref("Dog")],
		}
		const out = declare("Pet", schema, PET_COMPONENTS)
		expect(out.text).toContain("permits PetVariant1, PetCat, PetDog, PetUnknown {")
	})
})
