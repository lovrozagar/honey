/**
 * The C# names types are declared under (H52): one scope that components, hoisted types, converters, the client,
 * its context and its resource classes all claim from, clear of every top-level type the runtime declares (in the
 * SDK's own namespace, Fb2) and of the BCL names emitted text spells unqualified (§4.7). A component whose name is
 * taken is `<Name>Model`; a later claim of a taken name is `…2`. The BCL names by namespace also give each emitted
 * file exactly the `using` lines it needs.
 */
import type { IR, IRSchema } from "../../ir/model.ts"
import { irResolver } from "../../ir/schema.ts"
import { compareCodeUnits, csTypeName, NameScope } from "../shared/lang.ts"
import { runtimeFiles, runtimeTypeNames } from "./transport.ts"

/** How component, hoisted and other declared names are claimed, and which declared types are enums. */
export type CsTypeNames = {
	/** the C# name of the component `name` */
	ref(name: string): string
	/** a unique name for a hoisted declaration; one key always gets the same name */
	hoist(key: string, base: string): string
	/** a unique name for any other declaration (a converter, a resource class) */
	claim(base: string): string
	/** the schema of the component `name` when C# declares nothing for it, so a ref to it is its use type */
	alias(name: string): IRSchema | undefined
	resolve(schema: IRSchema): IRSchema
}

/* the BCL names emitted text spells unqualified, by the namespace a `using` brings them from (§4.7) */
export const BCL: Readonly<Record<string, readonly string[]>> = {
	System: ["Exception", "Func", "IDisposable", "Object", "String", "Type"],
	"System.Collections.Generic": ["IDictionary", "IReadOnlyDictionary", "IReadOnlyList"],
	"System.Text.Json": [
		"JsonElement",
		"JsonException",
		"JsonSerializer",
		"JsonSerializerOptions",
		"JsonTokenType",
		"JsonValueKind",
		"Utf8JsonReader",
		"Utf8JsonWriter",
	],
	"System.Text.Json.Serialization": [
		"JsonConverter",
		"JsonExtensionData",
		"JsonIgnore",
		"JsonIgnoreCondition",
		"JsonPropertyName",
		"JsonSerializable",
		"JsonSerializerContext",
		"JsonSourceGenerationOptions",
		"JsonUnmappedMemberHandling",
	],
	"System.Text.Json.Serialization.Metadata": ["JsonTypeInfo"],
	"System.Threading": ["CancellationToken"],
	"System.Threading.Tasks": ["Task"],
}

/* the attributes emitted text spells without their `Attribute` suffix: the suffixed name is taken too */
const ATTRIBUTES = [
	"JsonConverter",
	"JsonExtensionData",
	"JsonIgnore",
	"JsonPropertyName",
	"JsonSerializable",
	"JsonSourceGenerationOptions",
]

const UNKNOWN: IRSchema = { kind: "unknown" }

/** Every name a declared type may not take: the runtime's types, the BCL's, `System` itself, and `taken`. */
const reserved = (taken: readonly string[]) => [
	...Object.values(runtimeFiles({ realtime: true, ws: true }, "X")).flatMap(runtimeTypeNames),
	...Object.values(BCL).flat(),
	...ATTRIBUTES.map((name) => `${name}Attribute`),
	/* the static class of the API's error keys (errors.ts), declared beside the types when any key is */
	"ErrorKey",
	"System",
	...taken,
]

/**
 * Names for an SDK of the components `schemas` with `taken` reserved besides (its client and context): each
 * component C# declares claims its name in code-unit order, as `<Name>Model` when it is taken; hoists and other
 * declarations claim after them. A component `declares` nothing for is an alias, and one `schemas` lacks is any
 * JSON value.
 */
export function irNames(
	schemas: IR["schemas"],
	taken: readonly string[],
	declares: (ir: IRSchema) => boolean,
): CsTypeNames {
	const scope = new NameScope(reserved(taken))
	const components = new Map<string, string>()
	for (const name of Object.keys(schemas)
		.sort(compareCodeUnits)
		.filter((n) => declares(schemas[n] as IRSchema))) {
		const base = csTypeName(name)
		components.set(name, scope.claim(scope.has(base) ? `${base}Model` : base))
	}
	const hoisted = new Map<string, string>()
	return {
		alias: (name) => {
			const schema = schemas[name] ?? UNKNOWN
			return declares(schema) ? undefined : schema
		},
		claim: (base) => scope.claim(base),
		hoist: (key, base) => {
			const name = hoisted.get(key) ?? scope.claim(base)
			hoisted.set(key, name)
			return name
		},
		/* a ref reaches here only for a declared component: `alias` answers for every other one */
		ref: (name) => components.get(name) as string,
		resolve: irResolver(schemas),
	}
}

/** `code` without its string and char literals and comments: the text that spells names. */
const codeOf = (code: string) =>
	code
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)'/g, "''")
		.replace(/\/\/.*$/gm, "")

/** The `using` lines `code` needs: each namespace one of whose BCL names it spells as a type, in code-unit order. */
export function usings(code: string): string[] {
	const text = codeOf(code)
	return Object.keys(BCL)
		.filter((namespace) =>
			(BCL[namespace] as readonly string[]).some((name) => new RegExp(`(?<![.\\w])${name}\\b`).test(text)),
		)
		.sort(compareCodeUnits)
		.map((namespace) => `using ${namespace};`)
}
