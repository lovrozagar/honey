/**
 * The SDK's public source-generated `JsonSerializerContext` (§4.6): writing skips null, reading honors the nullable
 * annotations and the required members (Fb5) and skips unknown members. It lists every type the SDK reads or
 * writes, each under an explicit `TypeInfoPropertyName` claimed in the context's own scope, so the emitter never
 * predicts the generator's names, and closes each list and map of a non-nullable reference type with the
 * runtime's strict converter, unless some use of that runtime type gives it nullable items (Fb6's rule: nullable
 * annotations are erased at run time, so such a type stays lenient everywhere).
 */
import { compareCodeUnits, NameScope } from "../shared/lang.ts"

/* the value types emitted text spells, besides the declared enums: `T?` of one is `Nullable<T>` at run time */
const VALUE_TYPES = ["bool", "double", "JsonElement", "long"]

/* the names the generator gives the BCL types it lists, which the context's own names follow */
const BCL_NAMES: Readonly<Record<string, string>> = {
	bool: "Boolean",
	double: "Double",
	JsonElement: "JsonElement",
	long: "Int64",
	string: "String",
}

const LIST = /^IReadOnlyList<(.*)>$/
const MAP = /^IReadOnlyDictionary<string, (.*)>$/

/* the context's own members and the members every class has: no TypeInfoPropertyName may take one */
const CONTEXT_MEMBERS = [
	"Default",
	"Equals",
	"Finalize",
	"GeneratedSerializerOptions",
	"GetHashCode",
	"GetType",
	"GetTypeInfo",
	"MemberwiseClone",
	"Options",
	"ToString",
]

/** Reads C# type text as the runtime sees it, given which names are value types. */
export type Runtime = (type: string) => string

/** The runtime type of a C# type: each nullable reference's `?` dropped at every depth, a nullable value type's kept. */
export function runtimeOf(enums: Iterable<string>): Runtime {
	const values = new Set([...VALUE_TYPES, ...enums])
	const runtime = (type: string): string => {
		const bare = type.replace(/\?$/, "")
		const list = LIST.exec(bare)?.[1]
		const map = MAP.exec(bare)?.[1]
		const inner =
			list === undefined
				? map === undefined
					? bare
					: `IReadOnlyDictionary<string, ${runtime(map)}>`
				: `IReadOnlyList<${runtime(list)}>`
		return values.has(bare) && type.endsWith("?") ? `${inner}?` : inner
	}
	return runtime
}

/** The name the generator would give a runtime type, which its entry claims. */
function baseName(type: string): string {
	const list = LIST.exec(type)?.[1]
	const map = MAP.exec(type)?.[1]
	if (type.endsWith("?")) return `Nullable${baseName(type.slice(0, -1))}`
	if (list !== undefined) return `${baseName(list)}List`
	return map === undefined ? (BCL_NAMES[type] ?? type) : `${baseName(map)}Map`
}

/** Each runtime type's `TypeInfoPropertyName`: the declared types first, then the rest by name, each unique. */
export function typeInfoNames(
	declared: readonly string[],
	others: readonly string[],
	context: string,
): Map<string, string> {
	const scope = new NameScope([...CONTEXT_MEMBERS, context])
	const names = new Map<string, string>()
	const rest = others
		.filter((type) => !declared.includes(type))
		.sort((a, b) => compareCodeUnits(baseName(a), baseName(b)))
	for (const type of [...declared, ...rest]) if (!names.has(type)) names.set(type, scope.claim(baseName(type)))
	return names
}

/**
 * The strict converters for `collections` (each as written, item nullability kept): `NonNullList<T>` or
 * `NonNullMap<T>` per runtime collection type of a reference item no use gives `?`, in code-unit order of the text.
 */
export function strictConverters(collections: Iterable<string>, runtime: Runtime): string[] {
	const lenient = new Set<string>()
	const strict = new Set<string>()
	for (const type of collections) {
		const list = LIST.exec(type)?.[1]
		const item = list ?? (MAP.exec(type)?.[1] as string)
		const base = runtime(item).replace(/\?$/, "")
		/* a value type keeps its `?` at run time: its null item fails the read already (Q2) */
		if (runtime(`${base}?`).endsWith("?")) continue
		const converter = `typeof(${list === undefined ? "NonNullMap" : "NonNullList"}<${base}>)`
		;(item.endsWith("?") ? lenient : strict).add(converter)
	}
	return [...strict].filter((converter) => !lenient.has(converter)).sort(compareCodeUnits)
}

/** The context class `context`: its options, its converters, then one entry per runtime type, sorted by name. */
export function jsonContext(
	context: string,
	names: ReadonlyMap<string, string>,
	converters: readonly string[],
): string {
	const entries = [...names]
		.sort(([, a], [, b]) => compareCodeUnits(a, b))
		.map(([type, name]) => `[JsonSerializable(typeof(${type}), TypeInfoPropertyName = "${name}")]`)
	const options = [
		"    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull",
		"    RespectNullableAnnotations = true",
		"    RespectRequiredConstructorParameters = true",
		"    UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip",
		...(converters.length > 0 ? [`    Converters = [${converters.join(", ")}]`] : []),
	]
	return [
		"/// <summary>Every type the SDK reads or writes, with source-generated metadata (AOT- and trim-safe).</summary>",
		"[JsonSourceGenerationOptions(",
		`${options.join(",\n")})]`,
		...entries,
		`public sealed partial class ${context} : JsonSerializerContext`,
		"{",
		"}",
	].join("\n")
}
