/**
 * The BCL names the vendored C# runtime spells unqualified are all in `BCL` (types-names.ts), the set that claims
 * names away from emitted types (§4.7). Nothing is listed by hand here: the runtime's spelled names are derived by
 * scanning `src/runtime/csharp/*.cs`, with comments, literals and member sites set aside, and the names the runtime
 * declares itself, its namespaces and its generic parameters taken out. A copy of `BCL` missing one present entry
 * must come out red, so the check is shown to bite.
 */
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BCL, RUNTIME_BCL } from "../../src/emit/csharp/types-names.ts"

type Sets = Readonly<Record<string, readonly string[]>>

const RUNTIME = new URL("../../src/runtime/csharp/", import.meta.url)

/* the words a C# expression or statement may put after a capitalized name, which make it no type */
const KEYWORDS = new Set([
	"and",
	"as",
	"await",
	"case",
	"else",
	"in",
	"is",
	"new",
	"not",
	"or",
	"return",
	"when",
	"with",
])

/* comments and string and char literals out, so only code spells names */
const codeOf = (source: string): string =>
	source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)'/g, "''")

/* the names `code` declares as types, namespaces and generic parameters: the runtime's own, not the BCL's */
function declaredIn(code: string): Set<string> {
	const declared = new Set<string>()
	for (const match of code.matchAll(/\b(?:class|struct|record|interface|enum)\s+([A-Z]\w*)/g))
		declared.add(match[1] ?? "")
	for (const match of code.matchAll(/\b(?:using|namespace)\s+([\w.]+)/g)) {
		for (const segment of (match[1] ?? "").split(".")) declared.add(segment)
	}
	for (const match of code.matchAll(/\b\w+\s*<\s*([A-Z]\w*(?:\s*,\s*[A-Z]\w*)*)\s*>\s*\(/g))
		for (const param of (match[1] ?? "").split(",")) declared.add(param.trim())
	for (const match of code.matchAll(/\b(?:class|struct|record|interface)\s+\w+\s*<([^>]*)>/g))
		for (const param of (match[1] ?? "").split(",")) declared.add(param.trim())
	return declared
}

/*
 * Runtime members a `.` reaches as instance receivers, which the scan would otherwise read as BCL static sites. Each is
 * a runtime member, not a BCL type, so it is set aside here by name.
 */
const RECEIVER_RESIDUE: readonly string[] = [
	"ClosedBy", // Ws.cs: a `WsClose?` property, read as `ClosedBy.Status`
	"Empty", // Envelope.cs: a runtime class, read as `Empty.Fields`
	"OpenLimit", // RealtimeLoop.cs: a `TimeSpan` field, read as `OpenLimit.Ticks`
	"Safe", // Handler.cs: a runtime set field, read as `Safe.Contains(...)`
]

/* the capitalized members the runtime declares (properties, fields, methods): `Config.Timeout` is a member, not a type */
function memberNamesIn(code: string): Set<string> {
	const modifier =
		/\b(?:public|internal|private|protected|static|override|virtual|abstract|sealed|readonly|async|const|partial|required|event)\b[^;{=()]*?\s([A-Z]\w*)\s*(?:<[^>]*>)?\s*[({;=]/g
	return new Set([...code.matchAll(modifier)].map((match) => match[1] ?? ""))
}

/* whether the capitalized name at `start` (ending at `end`) is a type where it stands: generic or array, nullable
 * before a declared name, followed by a declared name, or after `new`, `is`, `as` or `typeof(` */
function isTypeSite(code: string, start: number, end: number): boolean {
	const after = code.slice(end, end + 60)
	const before = code.slice(Math.max(0, start - 8), start)
	const word = after.trim().split(/\s+/)[0] ?? ""
	const generic = /^\s*</.test(after) && !/^\s*<[^()]*?>\s*\(/.test(after)
	return (
		/^\s*\[/.test(after) ||
		/^\??\[\]/.test(after) ||
		generic ||
		/^\?\s+[A-Za-z_]/.test(after) ||
		(/^\s+[A-Za-z_]\w*/.test(after) && !KEYWORDS.has(word)) ||
		/(new|is|as)\s+$/.test(before) ||
		before.endsWith("typeof(")
	)
}

/** The capitalized names `code` spells unqualified as types, minus the ones it declares itself, in code-unit order. */
function spelledUnqualified(code: string): string[] {
	const declared = new Set([...declaredIn(code), ...RECEIVER_RESIDUE])
	const members = memberNamesIn(code)
	const spelled = new Set<string>()
	for (const match of code.matchAll(/(?<![.\w])([A-Z]\w*)/g)) {
		const name = match[1] ?? ""
		const start = match.index ?? 0
		const end = start + name.length
		if (declared.has(name)) continue
		const accessed = /^\.(\w+)/.exec(code.slice(end))?.[1]
		const staticAccess = accessed !== undefined && !members.has(accessed)
		if (staticAccess || isTypeSite(code, start, end)) spelled.add(name)
	}
	return [...spelled].sort()
}

/** Every name `sets` lists, flattened. */
const flatten = (sets: Sets): Set<string> => new Set(Object.values(sets).flat())

/** The names of `spelled` that no entry of `listed` covers, in code-unit order. */
const unlisted = (spelled: readonly string[], listed: Set<string>): string[] =>
	spelled.filter((name) => !listed.has(name))

const runtimeSource = (): string =>
	readdirSync(RUNTIME)
		.filter((file) => file.endsWith(".cs"))
		.sort()
		.map((file) => readFileSync(new URL(file, RUNTIME), "utf8"))
		.join("\n")

const spelled = spelledUnqualified(codeOf(runtimeSource()))

describe("the vendored C# runtime's BCL names (§4.7)", () => {
	const listed = new Set([...flatten(BCL), ...RUNTIME_BCL])

	it("lists every BCL type name the runtime spells unqualified in BCL or RUNTIME_BCL", () => {
		expect(unlisted(spelled, listed)).toEqual([])
	})

	it("keeps BCL and RUNTIME_BCL disjoint, so a name emitted text spells stays in BCL alone", () => {
		expect(RUNTIME_BCL.filter((name) => flatten(BCL).has(name))).toEqual([])
	})

	it("finds spelled names in the runtime to check at all", () => {
		expect(spelled.length).toBeGreaterThan(0)
	})

	it.each(["Task", "Timeout"])("goes red for a copy of the union that lacks %s, naming it", (name) => {
		const without = new Set([...listed].filter((listedName) => listedName !== name))
		expect(unlisted(spelled, without)).toContain(name)
	})
})
