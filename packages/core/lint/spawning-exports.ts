/**
 * The spawning exports of core's and gen's modules, derived from the code (spawners.js's AST reading, to a fixed point
 * across modules): what SPAWNING_HELPERS must equal, restricted to what a test file imports. spawners.test.ts holds it.
 */
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseSync } from "oxc-parser"
import { DEFERRED, spawnScope } from "./spawners.js"

type Program = { body: Array<Record<string, unknown> & { type: string }> }

const REPO = join(import.meta.dirname, "../../..")

/** Every tracked TypeScript or JavaScript module of core and gen, repo-relative. */
export function modules(files: readonly string[]): string[] {
	return files.filter(
		(file) =>
			/^packages\/(?:core|gen)\/.*\.(?:ts|js|mjs)$/.test(file) && !file.endsWith(".d.ts") && !file.includes("/_gen/"),
	)
}

const parsed = new Map<string, Program>()
function programOf(file: string): Program {
	let program = parsed.get(file)
	if (program === undefined) {
		program = parseSync(file, readFileSync(join(REPO, file), "utf8")).program as unknown as Program
		parsed.set(file, program)
	}
	return program
}

type Named = { declaration?: { declarations?: Array<{ id: { name?: string } }>; id?: { name?: string } } | null }
type Specifier = { exported: { name?: string; value?: string }; local: { name?: string; value?: string } }

/** An export statement's declared names: export function x, export const x = …. */
function declaredNames(statement: Named): string[] {
	const declaration = statement.declaration
	const ids = declaration?.id ? [declaration.id] : (declaration?.declarations ?? []).map((d) => d.id)
	return ids.flatMap((id) => (id.name ? [id.name] : []))
}

/** export { local as x }: exported name → local name. */
function specifiedNames(specifiers: readonly Specifier[]): Array<[string, string]> {
	return specifiers.flatMap((s) => {
		const exported = s.exported.name ?? s.exported.value
		const local = s.local.name ?? s.local.value
		return exported && local ? [[exported, local] as [string, string]] : []
	})
}

/** A module's own exports: exported name → local name (a re-export from another module is that module's). */
function exportsOf(program: Program): Map<string, string> {
	const out = new Map<string, string>()
	for (const statement of program.body) {
		if (statement.type !== "ExportNamedDeclaration" || statement.source) continue
		for (const name of declaredNames(statement as Named)) out.set(name, name)
		for (const [exported, local] of specifiedNames((statement.specifiers ?? []) as Specifier[]))
			out.set(exported, local)
	}
	return out
}

/** Module → its exports that spawn, to a fixed point over every module given; DEFERRED's left out unless `all`. */
export function spawningExports(files: readonly string[], all = false): Map<string, string[]> {
	const found = new Map<string, string[]>()
	const deferred = (file: string, name: string) => !all && DEFERRED.get(file)?.has(name) === true
	for (let grew = true; grew;) {
		grew = false
		for (const file of files) {
			if (file.endsWith(".test.ts")) continue
			const program = programOf(file)
			const scope = spawnScope(program, file, found)
			const names = [...exportsOf(program)]
				.filter(([name, local]) => scope.names.has(local) && !deferred(file, name))
				.map(([name]) => name)
			if (names.length > (found.get(file)?.length ?? 0)) {
				found.set(file, names.sort())
				grew = true
			}
		}
	}
	return found
}

type Import = { importKind?: string; source: { value: string }; specifiers: Specifier[] & { imported?: unknown }[] }

/** Of `found`, the exports some test file imports: what the rule must know of another module. */
export function importedByTests(files: readonly string[], found: Map<string, string[]>): Map<string, string[]> {
	const used = new Map<string, Set<string>>()
	for (const test of files.filter((file) => file.endsWith(".test.ts"))) {
		for (const statement of programOf(test).body) {
			if (statement.type !== "ImportDeclaration") continue
			const source = (statement as unknown as Import).source.value
			if (!source.startsWith(".")) continue
			const target = relative(REPO, join(REPO, test, "..", source)).replaceAll("\\", "/")
			const spawning = found.get(target) ?? []
			for (const s of (statement as unknown as { specifiers: Array<{ imported?: { name?: string } }> }).specifiers) {
				const name = s.imported?.name
				if (name && spawning.includes(name)) used.set(target, (used.get(target) ?? new Set()).add(name))
			}
		}
	}
	return new Map([...used].sort().map(([file, names]) => [file, [...names].sort()]))
}
