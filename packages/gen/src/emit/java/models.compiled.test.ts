/**
 * The emitted Java models, compiled and run (bit 16 phase b, B2, B5): a document of every phase-b shape, a record whose
 * optional nullable field is a three-state `Opt<T>`, an open value, a map, a string enum whose constant the wire spells
 * with a dash, an integer enum, and a discriminated union of const-kind variants, is emitted by `generateJavaSdk`,
 * compiled `--release 17 -Xlint:all -Werror` on the 21 pin, held to google-java-format, and run: a driver round-trips
 * JSON through the runtime's one mapper. The driver is the test's own program, not an emitted one.
 */
import { describe, expect, it } from "vitest"
import { compiledJavaSdk, type JavaRun } from "./__fixtures__/compiled.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

type Json = Record<string, unknown>

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** A cold compile and run take seconds; a leg's bound is generous so a loaded machine never trips it. */
const SLOW = { timeout: 600_000 }

const object = (properties: Json, required: string[]): Json => ({ properties, required, type: "object" })
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })

/** Every phase-b shape: `Thing` has all three field states, an open value, a map, two enums and a union of const kinds. */
const DOC: Json = {
	components: {
		schemas: {
			Cat: object({ kind: { const: "cat" }, lives: { type: "integer" } }, ["kind", "lives"]),
			Color: { enum: ["red", "blue-green"], type: "string" },
			Dog: object({ bark: { type: "boolean" }, kind: { const: "dog" } }, ["bark", "kind"]),
			Level: { enum: [1, 2, -3], type: "integer" },
			Pet: { discriminator: { propertyName: "kind" }, oneOf: [ref("Cat"), ref("Dog")] },
			Thing: object(
				{
					color: ref("Color"),
					count: { type: "integer" },
					extra: {},
					id: { type: "string" },
					labels: { additionalProperties: { type: "string" }, type: "object" },
					level: ref("Level"),
					note: { type: ["string", "null"] },
					parent: { type: ["string", "null"] },
					pet: ref("Pet"),
				},
				["count", "id", "parent"],
			),
		},
	},
	info: { title: "Models", version: "1" },
	openapi: "3.1.0",
	paths: {},
}

/** Every .java file DOC's SDK emits, code-unit sorted: the models, the runtime and the client. */
const SOURCES = [
	"src/main/java/ai/anyrow/AnyrowClient.java",
	"src/main/java/ai/anyrow/Cat.java",
	"src/main/java/ai/anyrow/Color.java",
	"src/main/java/ai/anyrow/Dog.java",
	"src/main/java/ai/anyrow/Json.java",
	"src/main/java/ai/anyrow/Level.java",
	"src/main/java/ai/anyrow/Opt.java",
	"src/main/java/ai/anyrow/Pet.java",
	"src/main/java/ai/anyrow/PetCat.java",
	"src/main/java/ai/anyrow/PetDog.java",
	"src/main/java/ai/anyrow/PetUnknown.java",
	"src/main/java/ai/anyrow/Thing.java",
	"src/main/java/ai/anyrow/Transport.java",
]

/** The classes javac writes for DOC's SDK, code-unit sorted. */
const CLASSES = [
	"ai/anyrow/AnyrowClient$Builder.class",
	"ai/anyrow/AnyrowClient.class",
	"ai/anyrow/Cat.class",
	"ai/anyrow/Color.class",
	"ai/anyrow/Dog.class",
	"ai/anyrow/Json.class",
	"ai/anyrow/Level.class",
	"ai/anyrow/Opt$Reader.class",
	"ai/anyrow/Opt$Writer.class",
	"ai/anyrow/Opt.class",
	"ai/anyrow/Pet$Deserializer.class",
	"ai/anyrow/Pet.class",
	"ai/anyrow/PetCat.class",
	"ai/anyrow/PetDog.class",
	"ai/anyrow/PetUnknown.class",
	"ai/anyrow/Thing.class",
	"ai/anyrow/Transport.class",
]

/** The driver: one line per check, `<label> <answer>`. */
const DRIVER = `package ai.anyrow;

/** One line per check: its label, then its answer. */
public final class Driver {
  static final String ABSENT =
      """
      {"count":1,"id":"t","parent":null}\\
      """;
  static final String NULL =
      """
      {"count":1,"id":"t","note":null,"parent":null}\\
      """;
  static final String VALUE =
      """
      {"count":1,"id":"t","note":"x","parent":null}\\
      """;
  static final String UNKNOWN =
      """
      {"count":1,"id":"t","parent":null,"zz":{"a":1}}\\
      """;
  static final String COLOR =
      """
      {"color":"blue-green","count":1,"id":"t","parent":null}\\
      """;
  static final String CAT =
      """
      {"count":1,"id":"t","parent":null,"pet":{"kind":"cat","lives":9}}\\
      """;
  static final String DOG =
      """
      {"count":1,"id":"t","parent":null,"pet":{"bark":true,"kind":"dog"}}\\
      """;
  static final String ZZZ =
      """
      {"count":1,"id":"t","parent":null,"pet":{"kind":"zzz"}}\\
      """;
  static final String LEVEL_2 =
      """
      {"count":1,"id":"t","level":2,"parent":null}\\
      """;
  static final String LEVEL_7 =
      """
      {"count":1,"id":"t","level":7,"parent":null}\\
      """;
  static final String ARRAY_GADGET =
      """
      ["java.lang.ProcessBuilder",{"command":["id"]}]\\
      """;
  static final String OBJECT_GADGET =
      """
      {"@class":"java.lang.ProcessBuilder","command":["id"]}\\
      """;

  static String state(Opt<?> field) {
    if (!field.isPresent()) {
      return "absent";
    }
    return field.value() == null ? "null" : "value";
  }

  static void line(String label, Object answer) {
    System.out.println(label + " " + answer);
  }

  static void round(String label, String json) throws Exception {
    Thing thing = Json.MAPPER.readValue(json, Thing.class);
    line(label, state(thing.note()) + " " + Json.MAPPER.writeValueAsString(thing));
  }

  static void refused(String label, String json) {
    try {
      Json.MAPPER.readValue(json, Thing.class);
      line(label, "READ");
    } catch (Exception e) {
      line(label, "REFUSED " + e.getClass().getSimpleName());
    }
  }

  public static void main(String[] args) throws Exception {
    round("note-absent", ABSENT);
    round("note-null", NULL);
    round("note-value", VALUE);
    round("unknown-ignored", UNKNOWN);
    round("enum-blue-green", COLOR);
    Thing cat = Json.MAPPER.readValue(CAT, Thing.class);
    line(
        "union-cat",
        cat.pet().getClass().getSimpleName() + " " + Json.MAPPER.writeValueAsString(cat));
    Thing dog = Json.MAPPER.readValue(DOG, Thing.class);
    line(
        "union-dog",
        dog.pet().getClass().getSimpleName() + " " + Json.MAPPER.writeValueAsString(dog));
    Thing zzz = Json.MAPPER.readValue(ZZZ, Thing.class);
    line(
        "union-unknown",
        zzz.pet().getClass().getSimpleName() + " " + Json.MAPPER.writeValueAsString(zzz));
    Thing two = Json.MAPPER.readValue(LEVEL_2, Thing.class);
    line("level-2", two.level().name() + " " + Json.MAPPER.writeValueAsString(two));
    refused("level-7", LEVEL_7);
    line("gadget-array", Json.MAPPER.readValue(ARRAY_GADGET, Object.class).getClass().getName());
    line("gadget-object", Json.MAPPER.readValue(OBJECT_GADGET, Object.class).getClass().getName());
  }
}`

/** The driver's lines, one per check, in the order the driver makes them. */
const OUT = [
	'note-absent absent {"count":1,"id":"t","parent":null}',
	'note-null null {"count":1,"id":"t","note":null,"parent":null}',
	'note-value value {"count":1,"id":"t","note":"x","parent":null}',
	'unknown-ignored absent {"count":1,"id":"t","parent":null}',
	'enum-blue-green absent {"color":"blue-green","count":1,"id":"t","parent":null}',
	'union-cat PetCat {"count":1,"id":"t","parent":null,"pet":{"kind":"cat","lives":9}}',
	'union-dog PetDog {"count":1,"id":"t","parent":null,"pet":{"bark":true,"kind":"dog"}}',
	'union-unknown PetUnknown {"count":1,"id":"t","parent":null,"pet":{"kind":"zzz"}}',
	'level-2 L2 {"count":1,"id":"t","level":2,"parent":null}',
	"level-7 REFUSED ValueInstantiationException",
	"gadget-array java.util.ArrayList",
	"gadget-object java.util.LinkedHashMap",
]

/** The emitted SDK for DOC, compiled and checked. */
const sdk = () => compiledJavaSdk(generateJavaSdk(DOC).files)

/** `make`'s value, computed on first call: one compile and one run serve every leg that reads it. */
function once<T>(make: () => T): () => T {
	let value: T | undefined
	return () => (value ??= make())
}

/** The driver run on the SDK: compiled with it, then run as `ai.anyrow.Driver`. */
const run = once((): JavaRun => sdk().run("ai.anyrow.Driver", DRIVER))

/** A run's stdout, one line each. */
const lines = (stdout: string): string[] => stdout.split("\n").filter((line) => line !== "")

describe.skipIf(!JAVA)("the models SDK: javac --release 17 -Xlint:all -Werror on the 21 pin", SLOW, () => {
	it("compiles every phase-b shape with no diagnostic, into exactly the expected classes", () => {
		const built = sdk()
		expect({ classes: [...built.javac.classes].sort(), diagnostics: built.javac.diagnostics }).toEqual({
			classes: CLASSES,
			diagnostics: [],
		})
	})

	it("emits every model's source, and is google-java-format's canonical form", () => {
		const sources = Object.keys(generateJavaSdk(DOC).files).filter((name) => name.endsWith(".java"))
		expect({ format: sdk().format(), sources: sources.sort() }).toEqual({ format: [], sources: SOURCES })
	})
})

describe.skipIf(!JAVA)("the driver on the models: the shapes round-trip through the one mapper", SLOW, () => {
	it("compiles the driver with no diagnostic and exits 0", () => {
		const ran = run()
		expect({ diagnostics: ran.diagnostics, status: ran.status }).toEqual({ diagnostics: [], status: 0 })
	})

	it("round-trips an optional nullable field's three states, absent, null and a value, each back as it came", () => {
		expect(lines(run().stdout).slice(0, 3)).toEqual(OUT.slice(0, 3))
	})

	it("ignores an unknown property and writes nothing of it back", () => {
		expect(lines(run().stdout)[3]).toBe(OUT[3])
	})

	it("reads and writes a string enum constant by its wire value, a dash and all", () => {
		expect(lines(run().stdout)[4]).toBe(OUT[4])
	})

	it("dispatches a const-kind union to its wrapper by value: a cat, a dog", () => {
		expect(lines(run().stdout).slice(5, 7)).toEqual(OUT.slice(5, 7))
	})

	it("keeps an unknown discriminator value in PetUnknown and writes it back as it came, refusing nothing", () => {
		expect(lines(run().stdout)[7]).toBe(OUT[7])
	})

	it("reads an integer enum's JSON integer as its constant, and writes the constant back as the integer", () => {
		expect(lines(run().stdout)[8]).toBe(OUT[8])
	})

	it("refuses an integer no constant names", () => {
		expect(lines(run().stdout)[9]).toBe(OUT[9])
	})

	it("reads a gadget shape into Object as a plain list or map, never the class it names", () => {
		expect(lines(run().stdout).slice(10, 12)).toEqual(OUT.slice(10, 12))
	})
})
