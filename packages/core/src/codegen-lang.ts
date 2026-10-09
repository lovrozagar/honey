/* Per-language naming and literal writers shared by the Go, Rust, Python and Go CLI emitters.
 *
 * Every identifier an emitter derives from spec text (operationIds, schema names, field keys,
 * param names, enum values) goes through a sanitizer here, and every spec string that lands in
 * source (string literals, comments, doc comments, struct tags) goes through a writer here. The
 * emitters never interpolate raw spec text into source.
 */

/** Code-unit ordering. `localeCompare` depends on the host locale and makes output differ across machines. */
export function cmpCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

export function sortedEntries<V>(record: Record<string, V>): Array<[string, V]> {
	return Object.entries(record).sort(([a], [b]) => cmpCodeUnit(a, b))
}

/** Splits arbitrary text into ASCII alphanumeric words: `user-id` / `user_id` / `userId` → [user, id]. */
export function words(raw: string): string[] {
	return raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter((w) => w.length > 0)
}

/** Words joined PascalCase, keeping each word's inner case: `user-id` → `UserId`, `getHTTP` → `GetHTTP`. */
export function pascalWords(raw: string): string {
	return words(raw)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join("")
}

export function snakeWords(raw: string): string {
	return words(raw)
		.map((w) => w.toLowerCase())
		.join("_")
}

export function camelWords(raw: string): string {
	const p = pascalWords(raw)
	return p.charAt(0).toLowerCase() + p.slice(1)
}

/** Hands out unique names in one scope. Collisions get a stable numeric suffix in claim order. */
export class NameScope {
	readonly #taken = new Set<string>()
	readonly #fold: (name: string) => string

	constructor(reserved: Iterable<string> = [], fold: (name: string) => string = (n) => n) {
		this.#fold = fold
		for (const r of reserved) this.#taken.add(fold(r))
	}

	has(name: string): boolean {
		return this.#taken.has(this.#fold(name))
	}

	reserve(name: string): void {
		this.#taken.add(this.#fold(name))
	}

	claim(base: string): string {
		let name = base
		for (let i = 2; this.#taken.has(this.#fold(name)); i++) name = `${base}${i}`
		this.#taken.add(this.#fold(name))
		return name
	}
}

/** Memoized `NameScope`: the same raw key always maps to the same claimed name. */
export class NameTable {
	readonly #scope: NameScope
	readonly #byKey = new Map<string, string>()

	constructor(reserved: Iterable<string> = [], fold?: (name: string) => string) {
		this.#scope = new NameScope(reserved, fold)
	}

	get(key: string, base: string): string {
		const hit = this.#byKey.get(key)
		if (hit !== undefined) return hit
		const name = this.#scope.claim(base)
		this.#byKey.set(key, name)
		return name
	}
}

function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n|\u2028|\u2029|\u0085/)
}

/** Replaces unpaired UTF-16 surrogates; no target language can encode them in source. */
function wellFormed(s: string): string {
	return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

function hex(n: number, width: number): string {
	return n.toString(16).padStart(width, "0")
}

/**
 * Text for a comment or docstring: well-formed, with every character a compiler rejects even inside
 * a comment (Go and Python refuse NUL; Go refuses a BOM) written as visible `\uXXXX` text. Tab and
 * line breaks stay; the writers split lines themselves.
 */
function commentText(s: string): string {
	return wellFormed(s).replace(
		/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/g,
		(ch) => `\\u${hex(ch.charCodeAt(0), 4)}`,
	)
}

/* ── Go ── */

export const GO_KEYWORDS = new Set([
	"break",
	"case",
	"chan",
	"const",
	"continue",
	"default",
	"defer",
	"else",
	"fallthrough",
	"for",
	"func",
	"go",
	"goto",
	"if",
	"import",
	"interface",
	"map",
	"package",
	"range",
	"return",
	"select",
	"struct",
	"switch",
	"type",
	"var",
])

/** Predeclared identifiers plus the stdlib package names generated files import. */
export const GO_PREDECLARED = new Set([
	"any",
	"append",
	"bool",
	"byte",
	"cap",
	"clear",
	"close",
	"comparable",
	"complex",
	"complex128",
	"complex64",
	"copy",
	"delete",
	"error",
	"false",
	"float32",
	"float64",
	"imag",
	"int",
	"int16",
	"int32",
	"int64",
	"int8",
	"iota",
	"len",
	"make",
	"max",
	"min",
	"new",
	"nil",
	"panic",
	"print",
	"println",
	"real",
	"recover",
	"rune",
	"string",
	"true",
	"uint",
	"uint16",
	"uint32",
	"uint64",
	"uint8",
	"uintptr",
	/* imported packages */
	"bytes",
	"context",
	"errors",
	"fmt",
	"http",
	"io",
	"iter",
	"json",
	"multipart",
	"os",
	"slices",
	"strconv",
	"strings",
	"sync",
	"textproto",
	"time",
	"url",
	"websocket",
	"cobra",
	"cli",
	"sdk",
])

/** Exported Go identifier: `user-id` → `UserId`, `2fa` → `N2fa`, `` → `X`. */
export function goExported(raw: string): string {
	const p = pascalWords(raw)
	if (p === "") return "X"
	if (/^[0-9]/.test(p)) return `N${p}`
	return p
}

/** Unexported Go identifier (locals, params). Keywords, predeclared names and imports get a `_` suffix. */
export function goLocal(raw: string): string {
	let c = camelWords(raw)
	if (c === "") c = "v"
	if (/^[0-9]/.test(c)) c = `n${c}`
	if (GO_KEYWORDS.has(c) || GO_PREDECLARED.has(c)) return `${c}_`
	return c
}

/** Go interpreted string literal. */
export function goString(s: string): string {
	let out = '"'
	for (const ch of wellFormed(s)) {
		const c = ch.codePointAt(0) ?? 0
		if (ch === "\\") out += "\\\\"
		else if (ch === '"') out += '\\"'
		else if (ch === "\n") out += "\\n"
		else if (ch === "\r") out += "\\r"
		else if (ch === "\t") out += "\\t"
		else if (c < 0x20 || c === 0x7f) out += `\\x${hex(c, 2)}`
		else if (c === 0xfeff) out += "\\ufeff"
		else out += ch
	}
	return `${out}"`
}

/** `// ` comment lines for arbitrary text; every line break in the input starts a new comment line. */
export function goComment(text: string, indent = ""): string[] {
	return splitLines(commentText(text)).map((line) => (line.trim() === "" ? `${indent}//` : `${indent}// ${line}`))
}

/** encoding/json silently ignores tag names with other characters and falls back to the field name. */
export function goJsonTagNameValid(key: string): boolean {
	if (key === "") return false
	for (const ch of key) {
		if ("!#$%&()*+-./:;<=>?@[]^_{|}~ ".includes(ch)) continue
		if (!/[\p{L}\p{N}]/u.test(ch)) return false
	}
	return true
}

/** A Go struct tag carrying a json tag. The tag is an interpreted string so any key text is representable. */
export function goJsonTag(key: string, omit: boolean | "omitzero"): string {
	const value = omit === "omitzero" ? `${key},omitzero` : omit ? `${key},omitempty` : key
	const inner = `json:${goString(value)}`
	/* raw-string form when it round-trips: keeps the common case readable */
	if (!inner.includes("`")) return `\`${inner}\``
	return goString(inner)
}

/* ── Rust ── */

export const RUST_KEYWORDS = new Set([
	"as",
	"break",
	"const",
	"continue",
	"crate",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"Self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
	"async",
	"await",
	"dyn",
	"abstract",
	"become",
	"box",
	"do",
	"final",
	"macro",
	"override",
	"priv",
	"typeof",
	"unsized",
	"virtual",
	"yield",
	"try",
	"gen",
])

/** Keywords that cannot be raw identifiers (`r#self` is invalid). */
const RUST_NON_RAW = new Set(["crate", "self", "Self", "super", "extern", "_"])

/** Prelude and std names a generated type must not shadow. */
export const RUST_PRELUDE_TYPES = new Set([
	"Box",
	"Clone",
	"Copy",
	"Default",
	"Drop",
	"Eq",
	"Err",
	"Fn",
	"From",
	"HashMap",
	"Into",
	"Iterator",
	"None",
	"Ok",
	"Option",
	"Ord",
	"PartialEq",
	"PartialOrd",
	"Result",
	"Send",
	"Sized",
	"Some",
	"String",
	"Sync",
	"ToOwned",
	"ToString",
	"Vec",
	"Deserialize",
	"Serialize",
	"Deserialize_repr",
	"Serialize_repr",
	"Stream",
	"Arc",
])

/** snake_case Rust value identifier (fields, params, fns). Keywords become raw identifiers when allowed. */
export function rustValueIdent(raw: string): string {
	let s = snakeWords(raw)
	if (s === "") s = "value"
	if (/^[0-9]/.test(s)) s = `_${s}`
	if (RUST_KEYWORDS.has(s)) return RUST_NON_RAW.has(s) ? `${s}_` : `r#${s}`
	return s
}

/** Same as `rustValueIdent` but never a raw identifier: for names joined into other names. */
export function rustPlainSnake(raw: string): string {
	let s = snakeWords(raw)
	if (s === "") s = "value"
	if (/^[0-9]/.test(s)) s = `_${s}`
	if (RUST_KEYWORDS.has(s)) return `${s}_`
	return s
}

/** PascalCase Rust type/variant identifier. */
export function rustTypeIdent(raw: string): string {
	let p = pascalWords(raw)
	if (p === "") p = "Value"
	if (/^[0-9]/.test(p)) p = `N${p}`
	if (p === "Self") return "Self_"
	return p
}

/** Rust string literal. `JSON.stringify` is not one: rustc rejects `\b`, `\f` and `\uXXXX`. */
export function rustString(s: string): string {
	let out = '"'
	for (const ch of wellFormed(s)) {
		const c = ch.codePointAt(0) ?? 0
		if (ch === "\\") out += "\\\\"
		else if (ch === '"') out += '\\"'
		else if (ch === "\n") out += "\\n"
		else if (ch === "\r") out += "\\r"
		else if (ch === "\t") out += "\\t"
		else if (ch === "\0") out += "\\0"
		else if (c < 0x20 || c === 0x7f || c === 0xfeff) out += `\\u{${hex(c, 2)}}`
		else out += ch
	}
	return `${out}"`
}

/** `/// ` doc lines; each input line break starts a new doc line so text never becomes code. */
export function rustDoc(text: string, indent = ""): string[] {
	return splitLines(commentText(text)).map((line) => (line.trim() === "" ? `${indent}///` : `${indent}/// ${line}`))
}

/** Text safe inside a `/* … *\/` block comment. */
export function blockCommentText(text: string): string {
	return commentText(text).replace(/\*\//g, "* /").replace(/\/\*/g, "/ *")
}

/* ── Python ── */

export const PY_KEYWORDS = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	/* soft keywords and names generated code relies on */
	"match",
	"case",
	"type",
	"_",
	"self",
	"cls",
])

/** snake_case Python identifier. Keywords and reserved names get a `_` suffix (PEP 8). */
export function pyIdentifier(raw: string): string {
	let s = snakeWords(raw)
	if (s === "") s = "value"
	if (/^[0-9]/.test(s)) s = `_${s}`
	if (PY_KEYWORDS.has(s)) return `${s}_`
	return s
}

/** PascalCase Python class name. */
export function pyClassName(raw: string): string {
	let p = pascalWords(raw)
	if (p === "") p = "Model"
	if (/^[0-9]/.test(p)) p = `N${p}`
	if (PY_KEYWORDS.has(p)) p = `${p}_`
	return p
}

/** Python string literal (double-quoted, escapes everything non-printable). */
export function pyString(s: string): string {
	let out = '"'
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0
		if (ch === "\\") out += "\\\\"
		else if (ch === '"') out += '\\"'
		else if (ch === "\n") out += "\\n"
		else if (ch === "\r") out += "\\r"
		else if (ch === "\t") out += "\\t"
		else if (c < 0x20 || c === 0x7f) out += `\\x${hex(c, 2)}`
		else if (c >= 0xd800 && c <= 0xdfff) out += `\\u${hex(c, 4)}`
		else if (c === 0x2028 || c === 0x2029 || c === 0x85 || c === 0xfeff) out += `\\u${hex(c, 4)}`
		else out += ch
	}
	return `${out}"`
}

/** Docstring body lines: backslashes and quotes escaped, so `"""`, a trailing `"` and `C:\users` are inert. */
export function pyDocLines(text: string): string[] {
	return splitLines(commentText(text)).map((line) => line.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))
}

/** `# ` comment lines. */
export function pyComment(text: string, indent = ""): string[] {
	return splitLines(commentText(text)).map((line) => (line.trim() === "" ? `${indent}#` : `${indent}# ${line}`))
}
