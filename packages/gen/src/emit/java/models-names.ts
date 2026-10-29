/**
 * The Java names types are declared under (bit 16 phase b, B3): one scope that components and hoisted types claim from,
 * clear of the runtime's own types (scanned from every file of src/runtime/java, as C#'s runtime names are), the types
 * the emitted models and client spell (listed in SPELLED: no runtime file holds them), and `taken`. A component whose
 * name is taken is `<Name>Model`; a later claim of a taken name is `…2`. An unspelled java.lang name is kept.
 */
import { readdirSync, readFileSync } from "node:fs"
import type { IR, IRSchema } from "../../ir/model.ts"
import { irResolver } from "../../ir/schema.ts"
import { compareCodeUnits, javaTypeName, NameScope } from "../shared/lang.ts"
import type { Rename } from "../shared/mirror.ts"

/** The type a value without a schema is, and the one a nullable open value is. */
export const JSON_NODE = "JsonNode"

/** How component, hoisted and other declared names are claimed, and which schema a ref to a non-declaring component is. */
export type JavaTypeNames = {
	/** the Java name of the component `name` */
	ref(name: string): string
	/** a unique name for a hoisted declaration; one key always gets the same name */
	hoist(key: string, base: string): string
	/** the schema of the component `name` when Java declares nothing for it, so a ref to it is its use type */
	alias(name: string): IRSchema | undefined
	resolve(schema: IRSchema): IRSchema
	/** each component emitted under another name than its own (`<Name>Model`), for the generation's notices */
	readonly renamed: readonly Rename[]
}

/* the type names the emitted models and the client spell, which no runtime file holds: each is reserved */
const SPELLED: readonly string[] = [
	"Boolean",
	"Builder",
	"DeserializationContext",
	"Deserializer",
	"Double",
	"IllegalArgumentException",
	"IllegalStateException",
	"JsonAnyGetter",
	"JsonAnySetter",
	"JsonCreator",
	"JsonDeserialize",
	"JsonInclude",
	"JsonNode",
	"JsonParser",
	"JsonProperty",
	"JsonValue",
	"List",
	"Long",
	"Map",
	"Override",
	"StdDeserializer",
	"String",
	"URI",
]

/**
 * The code text a scan reads: comments dropped and string and char literals emptied, in one left-to-right pass, so a
 * `//` inside a string opens no comment and a quote inside a comment opens no string.
 */
export const codeOf = (code: string) =>
	code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)'/gm, (token) =>
		token.startsWith("/") ? "" : token[0] === '"' ? '""' : "''",
	)

/** The type names `code` spells: each imported type by its simple name, and each capitalized identifier that is not a member access. */
export function spelledIn(code: string): string[] {
	const text = codeOf(code)
	const imported = [...text.matchAll(/^import [\w.]*\.(\w+);/gm)].map((match) => match[1] as string)
	const bare = [...text.matchAll(/(?<![.\w])[A-Z][A-Za-z0-9]*\b/g)].map((match) => match[0])
	return [...imported, ...bare]
}

/** The names every file of the vendored runtime spells, read on every call. */
const runtimeSpelled = (): string[] => {
	const dir = new URL("../../runtime/java/", import.meta.url)
	return readdirSync(dir)
		.filter((file) => file.endsWith(".java"))
		.flatMap((file) => spelledIn(readFileSync(new URL(file, dir), "utf8")))
}

const UNKNOWN: IRSchema = { kind: "unknown" }

/**
 * Names for an SDK of the components `schemas` with `taken` reserved besides (its client): each component Java declares
 * claims its name in code-unit order, as `<Name>Model` when it is taken; hoists and other declarations claim after
 * them. A component `declares` nothing for is an alias, and one `schemas` lacks is any JSON value.
 */
export function javaNames(
	schemas: IR["schemas"],
	taken: readonly string[],
	declares: (ir: IRSchema) => boolean,
): JavaTypeNames {
	const scope = new NameScope([...runtimeSpelled(), ...SPELLED, ...taken])
	const components = new Map<string, string>()
	const renamed: Rename[] = []
	for (const name of Object.keys(schemas)
		.sort(compareCodeUnits)
		.filter((n) => declares(schemas[n] as IRSchema))) {
		const base = javaTypeName(name)
		const taken = scope.has(base)
		components.set(name, scope.claim(taken ? `${base}Model` : base))
		if (taken)
			renamed.push({
				because: `"${base}" is a name the SDK's runtime, the JDK or another declaration holds`,
				name,
				renamed: components.get(name) as string,
				what: "component",
			})
	}
	const hoisted = new Map<string, string>()
	return {
		alias: (name) => {
			const schema = schemas[name] ?? UNKNOWN
			return declares(schema) ? undefined : schema
		},
		hoist: (key, base) => {
			const name = hoisted.get(key) ?? scope.claim(base)
			hoisted.set(key, name)
			return name
		},
		/* a ref reaches here only for a declared component: `alias` answers for every other one */
		ref: (name) => components.get(name) as string,
		renamed,
		resolve: irResolver(schemas),
	}
}
