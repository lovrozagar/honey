/**
 * The Jackson text of the bit-16 models (B5, R6, R7; Qa4): the one mapper `Json.java` builds, with unknown properties
 * ignored set explicitly and no type information anywhere, and the three-state `Opt<T>` that `Opt.java` holds, whose
 * reader keeps absent, null and a value apart and whose writer leaves an absent field out. The union readers are
 * pinned by models.unions.test.ts, and their round trips by models.compiled.test.ts.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/** A vendored runtime file's text, by class name. */
const runtime = (name: string): string =>
	readFileSync(new URL(`../../runtime/java/${name}.java`, import.meta.url), "utf8")

/** Jackson's type-id and default-typing surface: none of it may appear in the runtime. */
const TYPE_IDS =
	/@JsonTypeInfo|@JsonSubTypes|activateDefaultTyping|enableDefaultTyping|setDefaultTyping|DefaultTyping|PolymorphicTypeValidator|JsonTypeResolver/

describe("Json.java: one mapper, unknown properties ignored, no type information", () => {
	it("builds one JsonMapper once, disables FAIL_ON_UNKNOWN_PROPERTIES explicitly, and registers the Opt module", () => {
		const json = runtime("Json")
		expect(json.match(/JsonMapper\.builder\(\)/g)).toHaveLength(1)
		expect(json).toMatch(/static final JsonMapper MAPPER\s*=/)
		expect(json).toContain(".disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)")
		expect(json).not.toMatch(/\benable\(DeserializationFeature\.FAIL_ON_UNKNOWN_PROPERTIES/)
		expect(json).toContain(".addModule(")
		expect(json).toContain("addDeserializer(Opt.class, new Opt.Reader(null))")
		expect(json).toContain("addSerializer(new Opt.Writer())")
	})

	it("never turns on default typing, a type id, or a polymorphic validator, in the mapper or the runtime", () => {
		expect(runtime("Json")).not.toMatch(TYPE_IDS)
		expect(runtime("Opt")).not.toMatch(TYPE_IDS)
	})
})

describe("Opt.java: absent, null and a value are three states", () => {
	it("has a factory for each state", () => {
		const opt = runtime("Opt")
		expect(opt).toMatch(/public static <T> Opt<T> absent\(\)/)
		expect(opt).toMatch(/public static <T> Opt<T> ofNull\(\)/)
		expect(opt).toMatch(/public static <T> Opt<T> of\(T value\)/)
	})

	it("reads a missing field as absent and JSON null as present-null, through its contextual content type", () => {
		const opt = runtime("Opt")
		expect(opt).toMatch(/getAbsentValue\(DeserializationContext ctxt\)\s*\{\s*return Opt\.absent\(\);/)
		expect(opt).toMatch(/getNullValue\(DeserializationContext ctxt\)\s*\{\s*return Opt\.ofNull\(\);/)
		expect(opt).toMatch(/createContextual\(\s*DeserializationContext ctxt, BeanProperty property\)/)
	})

	it("writes an absent field as empty, so a NON_EMPTY property leaves it out, and a present null as null", () => {
		const opt = runtime("Opt")
		expect(opt).toMatch(/isEmpty\(SerializationContext c, Opt<\?> v\)\s*\{\s*return v == null \|\| !v\.present;/)
		expect(opt).toMatch(/if \(v\.value == null\)\s*\{\s*g\.writeNull\(\);/)
	})

	it("uses no java.util.Optional and no JsonNullable, which both collapse absent and null", () => {
		const opt = runtime("Opt")
		expect(opt).not.toMatch(/\bOptional\b/)
		expect(opt).not.toMatch(/JsonNullable/)
	})
})
