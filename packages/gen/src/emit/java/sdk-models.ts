/**
 * The Java SDK's model files (bit 16 phase b): each component that declares a type, and every type its declaration
 * hoists (an inline object, an enum, a union's wrappers), as one source file each, since a public top-level type
 * needs its own. A file imports exactly the types its text spells, in google-java-format's order: one block, sorted.
 */
import { compareCodeUnits } from "../shared/lang.ts"
import { declares, type JavaTypeContext, javaTopLevel } from "./models.ts"
import type { IR } from "../../ir/model.ts"

/* every type a model declaration may spell that java.lang does not hold, by its simple name */
const IMPORTS: Readonly<Record<string, string>> = {
	DeserializationContext: "tools.jackson.databind.DeserializationContext",
	JsonAnyGetter: "com.fasterxml.jackson.annotation.JsonAnyGetter",
	JsonAnySetter: "com.fasterxml.jackson.annotation.JsonAnySetter",
	JsonCreator: "com.fasterxml.jackson.annotation.JsonCreator",
	JsonDeserialize: "tools.jackson.databind.annotation.JsonDeserialize",
	JsonInclude: "com.fasterxml.jackson.annotation.JsonInclude",
	JsonNode: "tools.jackson.databind.JsonNode",
	JsonParser: "tools.jackson.core.JsonParser",
	JsonProperty: "com.fasterxml.jackson.annotation.JsonProperty",
	JsonValue: "com.fasterxml.jackson.annotation.JsonValue",
	LinkedHashMap: "java.util.LinkedHashMap",
	Map: "java.util.Map",
	StdDeserializer: "tools.jackson.databind.deser.std.StdDeserializer",
	Consumer: "java.util.function.Consumer",
	Duration: "java.time.Duration",
	InputStream: "java.io.InputStream",
	List: "java.util.List",
	Supplier: "java.util.function.Supplier",
	TypeReference: "tools.jackson.core.type.TypeReference",
}

/** `text` without its string literals and comments: what its code spells. */
const codeOf = (text: string): string =>
	text
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")

/** The import lines `decl` needs, sorted as google-java-format sorts them. */
export function importsOf(decl: string): string[] {
	const code = codeOf(decl)
	return Object.entries(IMPORTS)
		.filter(([name]) => new RegExp(`(?<![\\w.])${name}\\b`).test(code))
		.map(([, path]) => `import ${path};`)
		.sort(compareCodeUnits)
}

/** One model file's text: the marker, the package, its imports, its declaration. */
export function sourceOf(marker: string, packageName: string, decl: string): string {
	const imports = importsOf(decl)
	const head = imports.length > 0 ? `\n${imports.join("\n")}\n` : ""
	return `${marker}\npackage ${packageName};\n${head}\n${decl}\n`
}

/** The model declarations of `ir` in `ctx`: every component that declares, then what each hoists, the ops' included. */
export function componentDecls(ir: IR, ctx: JavaTypeContext): Map<string, string> {
	const decls = new Map<string, string>()
	for (const [key, schema] of Object.entries(ir.schemas).sort(([a], [b]) => compareCodeUnits(a, b))) {
		if (!declares(schema)) continue
		const name = ctx.names.ref(key)
		decls.set(name, javaTopLevel(name, schema, ctx))
	}
	/* a hoist claims its name from the same scope as the components, so it never repeats one */
	for (const [name, decl] of ctx.decls) decls.set(name, decl)
	return decls
}

/** The model files of `decls` under `dir`, in `packageName`, each behind `marker`. */
export function modelFiles(
	decls: ReadonlyMap<string, string>,
	{ dir, marker, packageName }: { dir: string; marker: string; packageName: string },
): Record<string, string> {
	return Object.fromEntries(
		[...decls].map(([name, decl]) => [`${dir}/${name}.java`, sourceOf(marker, packageName, decl)]),
	)
}
