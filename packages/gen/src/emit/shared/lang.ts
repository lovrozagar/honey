/**
 * Naming shared by every emitter and the IR: words out of any identifier-ish text, joined per
 * language convention, and the one locale-free string order.
 */

/** Order by UTF-16 code unit, never by locale: the same on every machine. */
export function compareCodeUnits(a: string, b: string): number {
	if (a === b) return 0
	return a < b ? -1 : 1
}

/** The ASCII alphanumeric words of `raw`: `user-id`, `user_id` and `userId` are all [user, id]. */
export function words(raw: string): string[] {
	return raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter((word) => word.length > 0)
}

/** The words joined PascalCase, each keeping its inner case: `user-id` → `UserId`, `getHTTP` → `GetHTTP`. */
export function pascalWords(raw: string): string {
	return words(raw)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("")
}

/** The words joined snake_case, lower case: `userId` → `user_id`. */
export function snakeWords(raw: string): string {
	return words(raw)
		.map((word) => word.toLowerCase())
		.join("_")
}

/** The words joined camelCase: `user-id` → `userId`. */
export function camelWords(raw: string): string {
	const pascal = pascalWords(raw)
	return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** A record's entries in code-unit order by key: the same on every machine. */
export function sortedEntries<V>(record: Readonly<Record<string, V>>): [string, V][] {
	return Object.entries(record).sort(([a], [b]) => compareCodeUnits(a, b))
}

/** Hands out unique names in one scope; a taken name gets the next numeric suffix, in claim order. */
export class NameScope {
	readonly #taken = new Set<string>()
	readonly #fold: (name: string) => string

	/** `fold` maps names that would clash in the target (a case-insensitive file system, say) to one key. */
	constructor(reserved: Iterable<string> = [], fold: (name: string) => string = (name) => name) {
		this.#fold = fold
		for (const name of reserved) this.#taken.add(fold(name))
	}

	has(name: string): boolean {
		return this.#taken.has(this.#fold(name))
	}

	reserve(name: string): void {
		this.#taken.add(this.#fold(name))
	}

	/** `base`, else `base2`, `base3`… whichever is free first; it is taken from then on. */
	claim(base: string): string {
		let name = base
		for (let n = 2; this.has(name); n++) name = `${base}${n}`
		this.reserve(name)
		return name
	}
}

/** A `NameScope` that remembers: one raw key always gets the name it was first given. */
export class NameTable {
	readonly #scope: NameScope
	readonly #byKey = new Map<string, string>()

	constructor(reserved: Iterable<string> = [], fold?: (name: string) => string) {
		this.#scope = new NameScope(reserved, fold)
	}

	get(key: string, base: string): string {
		const named = this.#byKey.get(key) ?? this.#scope.claim(base)
		this.#byKey.set(key, named)
		return named
	}
}

/** Whether `word` is one of the space-separated `list`. */
const listed = (list: string, word: string) => ` ${list} `.includes(` ${word} `)

const GO_RESERVED =
	/* keywords */
	"break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var " +
	/* predeclared identifiers */
	"any append bool byte cap clear close comparable complex complex128 complex64 copy delete error false float32 float64 imag int int16 int32 int64 int8 iota len make max min new nil panic print println real recover rune string true uint uint16 uint32 uint64 uint8 uintptr " +
	/* the packages generated Go imports */
	"bytes context errors fmt http io iter json multipart os slices strconv strings sync textproto time url websocket cobra cli sdk"

const RUST_KEYWORDS =
	"as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen"

/* keywords that cannot be raw identifiers: `r#self` is invalid */
const RUST_NON_RAW = "crate self Self super extern _"

const RUST_PRELUDE =
	"Box Clone Copy Default Drop Eq Err Fn From HashMap Into Iterator None Ok Option Ord PartialEq PartialOrd Result Send Sized Some String Sync ToOwned ToString Vec Deserialize Serialize Deserialize_repr Serialize_repr Stream Arc"

const PY_RESERVED =
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield " +
	/* soft keywords and names generated code relies on */
	"match case type _ self cls"

/* C#'s 77 reserved keywords (contract 45 §4.1): no identifier may be one unless `@`-escaped */
const CS_RESERVED =
	"abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while"

/* C#'s contextual keywords: legal identifiers, `@`-escaped all the same so none reads as a keyword where it is one */
const CS_CONTEXTUAL =
	"add allows and args async await by descending dynamic equals extension field file from get global group init into join let managed nameof nint not notnull nuint on or orderby partial record remove required scoped select set unmanaged value var when where with yield"

/** `name` unless empty (then `empty`), prefixed by `digitPrefix` when it starts with a digit. */
function guarded(name: string, empty: string, digitPrefix: string): string {
	if (name === "") return empty
	return /^[0-9]/.test(name) ? `${digitPrefix}${name}` : name
}

/** An exported Go identifier: `user-id` → `UserId`, `2fa` → `N2fa`, nothing → `X`. */
export function goExported(raw: string): string {
	return guarded(pascalWords(raw), "X", "N")
}

/** An unexported Go identifier (a local, a parameter); a keyword, predeclared or imported name gets `_`. */
export function goLocal(raw: string): string {
	const name = guarded(camelWords(raw), "v", "n")
	return listed(GO_RESERVED, name) ? `${name}_` : name
}

/** A snake_case Rust value identifier: a keyword becomes a raw identifier, or gets `_` where it cannot be one. */
export function rustValueIdent(raw: string): string {
	const name = guarded(snakeWords(raw), "value", "_")
	if (!listed(RUST_KEYWORDS, name)) return name
	return listed(RUST_NON_RAW, name) ? `${name}_` : `r#${name}`
}

/** Like `rustValueIdent`, never a raw identifier: for names joined into other names. */
export function rustPlainSnake(raw: string): string {
	const name = guarded(snakeWords(raw), "value", "_")
	return listed(RUST_KEYWORDS, name) ? `${name}_` : name
}

/** A PascalCase Rust type or variant identifier. */
export function rustTypeIdent(raw: string): string {
	const name = guarded(pascalWords(raw), "Value", "N")
	return name === "Self" ? "Self_" : name
}

/** Whether a generated Rust type named `name` would shadow a prelude or std name. */
export function isRustPreludeType(name: string): boolean {
	return listed(RUST_PRELUDE, name)
}

/** A snake_case Python identifier; a keyword or reserved name gets `_` (PEP 8). */
export function pyIdentifier(raw: string): string {
	const name = guarded(snakeWords(raw), "value", "_")
	return listed(PY_RESERVED, name) ? `${name}_` : name
}

/** A PascalCase Python class name. */
export function pyClassName(raw: string): string {
	const name = guarded(pascalWords(raw), "Model", "N")
	return listed(PY_RESERVED, name) ? `${name}_` : name
}

/* Java's keywords (JLS 3.9), its literals, `_`, and the restricted identifiers that cannot name a type */
const JAVA_RESERVED = [
	"abstract",
	"assert",
	"boolean",
	"break",
	"byte",
	"case",
	"catch",
	"char",
	"class",
	"const",
	"continue",
	"default",
	"do",
	"double",
	"else",
	"enum",
	"extends",
	"final",
	"finally",
	"float",
	"for",
	"goto",
	"if",
	"implements",
	"import",
	"instanceof",
	"int",
	"interface",
	"long",
	"native",
	"new",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"short",
	"static",
	"strictfp",
	"super",
	"switch",
	"synchronized",
	"this",
	"throw",
	"throws",
	"transient",
	"try",
	"void",
	"volatile",
	"while",
	"true",
	"false",
	"null",
	"_",
	"var",
	"yield",
	"record",
	"sealed",
	"permits",
]

/** Whether `name` is one of Java's keywords, literals or restricted type identifiers: no bare identifier may be one. */
export const isJavaReserved = (name: string): boolean => JAVA_RESERVED.includes(name)

/** A camelCase Java identifier (a parameter, a local): a keyword suffixed `_`, a digit first `_`, nothing `value`. */
export function javaIdentifier(raw: string): string {
	const name = camelWords(raw)
	if (name === "" || name === "_") return "value"
	return /^[0-9]/.test(name) ? `_${name}` : isJavaReserved(name) ? `${name}_` : name
}

/** A PascalCase Java type name: a digit first `N`, nothing `Value`; no keyword is PascalCase. */
export function javaTypeName(raw: string): string {
	return guarded(pascalWords(raw), "Value", "N")
}

/** A camelCase C# identifier (a parameter, a local): a keyword `@`-escaped, a digit first `_`, nothing `value`. */
export function csIdentifier(raw: string): string {
	const name = camelWords(raw)
	if (name === "") return "value"
	return /^[0-9]/.test(name) ? `_${name}` : isCsReserved(name) || listed(CS_CONTEXTUAL, name) ? `@${name}` : name
}

/** Whether `name` is one of C#'s reserved keywords: no namespace segment or bare identifier may be one. */
export function isCsReserved(name: string): boolean {
	return listed(CS_RESERVED, name)
}

/** A PascalCase C# type or member name: a digit first `N`, nothing `Value`; no keyword is PascalCase. */
export function csTypeName(raw: string): string {
	return guarded(pascalWords(raw), "Value", "N")
}
