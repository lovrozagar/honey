/**
 * Every ```ts block in README.md and packages/core/docs/*.md is type-checked against the source
 * package, and the self-contained ones are executed. A snippet that drifts from the API fails here
 * instead of in a reader's editor.
 *
 * Each snippet is checked as its own module with a small prelude: `app`, `z`, `v` and the root
 * exports are declared when the snippet uses them without declaring them. A snippet that uses
 * nothing it leaves undefined is checked in full, with `strict`. An excerpt — one that refers to
 * names from its surroundings (`withAuth`, `tracer`, `./_gen/...`) — is checked for what it can
 * still get wrong on its own: syntax, and imports from `@lovrozagar/honey/*` paths and names
 * that do not exist.
 *
 * Markers on the lines before a fence:
 * - `<!-- snippet:skip -->` — not checked (pseudo-code, shapes, config of another tool).
 * - `<!-- snippet:no-run -->` — type-checked but never executed.
 * - `<!-- snippet:name x -->` / `<!-- snippet:continue x -->` — a snippet that continues the
 *   named one is checked (and run) after it, as one module.
 * - `<!-- snippet:define x` + a fence + `-->` — setup code a reader does not need to see, hidden
 *   in an HTML comment and continued like a named snippet.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const CORE = resolve(import.meta.dirname, "../../..")
const REPO = resolve(CORE, "../..")
const TSC = join(REPO, "node_modules/.bin/tsc")
const DIR = join(CORE, "tests", `.tmp-snippets-${process.pid}`)

/** sdk.md is generated-SDK reference with four languages; its TS blocks are shapes, not programs. */
const DOCS = [
	join(REPO, "README.md"),
	...readdirSync(join(CORE, "docs"))
		.filter((f) => f.endsWith(".md") && f !== "sdk.md")
		.map((f) => join(CORE, "docs", f)),
]

/* A name or module the excerpt leaves to its surroundings. */
const UNRESOLVED_CODES = new Set(["TS2304", "TS2552", "TS18004"])
/* What an excerpt can still get wrong on its own: honey import paths and exported names. */
const HONEY_IMPORT_CODES = new Set(["TS2305", "TS2307", "TS2459", "TS2460", "TS2614", "TS2724"])

type Snippet = { code: string; file: string; id: string; line: number; prefix: number; run: boolean }

function extract(file: string): Snippet[] {
	const lines = readFileSync(file, "utf-8").split("\n")
	const out: Snippet[] = []
	const named = new Map<string, string>()
	let markers: string[] = []
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim()
		const define = /^<!-- snippet:define ([\w-]+)$/.exec(trimmed)
		if (define) {
			markers.push(`name ${define[1]}`)
			continue
		}
		if (trimmed === "-->") continue
		const marker = /^<!-- snippet:([\w-]+)(?: ([\w-]+))? -->$/.exec(trimmed)
		if (marker) {
			markers.push(marker[2] ? `${marker[1]} ${marker[2]}` : marker[1]!)
			continue
		}
		if (trimmed === "```ts") {
			let end = i + 1
			while (lines[end]!.trim() !== "```") end++
			const own = lines.slice(i + 1, end).join("\n")
			const cont = markers.find((m) => m.startsWith("continue "))?.slice("continue ".length)
			const before = cont === undefined ? "" : named.get(cont)
			if (before === undefined) throw new Error(`${file}:${i + 1}: snippet:continue ${cont} names no snippet`)
			const code = before === "" ? own : `${before}\n${own}`
			const name = markers.find((m) => m.startsWith("name "))?.slice("name ".length)
			if (name !== undefined) named.set(name, code)
			if (!markers.includes("skip")) {
				const rel = file.slice(REPO.length + 1)
				out.push({
					code,
					file: rel,
					id: `${rel.replace(/[^\w]/g, "_")}_L${i + 2}`,
					line: i + 2,
					prefix: before === "" ? 0 : before.split("\n").length,
					run: !markers.includes("no-run"),
				})
			}
			i = end
		}
		if (trimmed !== "") markers = []
	}
	return out
}

/** Prelude declarations for names a snippet uses without declaring them. */
const PRELUDE: Array<{ decl: string; name: string }> = [
	{ decl: `import { honey } from "@lovrozagar/honey"`, name: "honey" },
	{ decl: `import { createMiddleware } from "@lovrozagar/honey"`, name: "createMiddleware" },
	{ decl: `import { defineErrors } from "@lovrozagar/honey"`, name: "defineErrors" },
	{ decl: `import { HoneyError } from "@lovrozagar/honey"`, name: "HoneyError" },
	{ decl: `import * as z from "zod"`, name: "z" },
	{ decl: `import * as v from "valibot"`, name: "v" },
	{ decl: `import { honey as __honey } from "@lovrozagar/honey"\nconst app = __honey()`, name: "app" },
]

function declares(code: string, name: string): boolean {
	const n = name.replace(/\$/g, "\\$")
	return (
		new RegExp(`\\b(?:const|let|var|function|class)\\s+${n}\\b`).test(code) ||
		new RegExp(`import\\s+(?:type\\s+)?(?:\\*\\s+as\\s+${n}\\b|\\{[^}]*\\b${n}\\b[^}]*\\}|${n}\\b)`).test(code)
	)
}

function withPrelude(code: string): { prelude: number; source: string } {
	const decls = PRELUDE.filter((p) => new RegExp(`\\b${p.name}\\b`).test(code) && !declares(code, p.name)).map(
		(p) => p.decl,
	)
	const head = [...decls, "export {}"].join("\n")
	return { prelude: head.split("\n").length, source: `${head}\n${code}\n` }
}

/** Runnable: nothing left undefined, no listener, no network, no relative modules. */
function runnable(s: Snippet, unresolved: boolean): boolean {
	if (!s.run || unresolved) return false
	return !/\.serve\(|\bserve\(|\bfetch\(|Bun\.|Deno\.|process\.env|from\s+"\.{1,2}\/|import\("\.{1,2}\/|\bsetInterval\(|honey\/plugin|honey\/build|honey\/codegen|honey\/cli/.test(
		s.code,
	)
}

const snippets = DOCS.flatMap(extract)

type Diag = { code: string; line: number; message: string }
const diagnostics = new Map<string, Diag[]>()
const offsets = new Map<string, number>()

function typecheck(): void {
	rmSync(DIR, { force: true, recursive: true })
	mkdirSync(DIR, { recursive: true })
	for (const s of snippets) {
		const { prelude, source } = withPrelude(s.code)
		offsets.set(s.id, prelude)
		writeFileSync(join(DIR, `${s.id}.ts`), source)
	}
	/* tsc skips every semantic check when any file has a syntax error, so a snippet that does not
	 * parse is reported on its own and left out of the second, semantic pass */
	const broken = new Set<string>()
	for (const d of runTsc(snippets.map((s) => s.id))) {
		if (d.code.startsWith("TS1")) broken.add(d.id)
	}
	for (const d of runTsc(snippets.map((s) => s.id).filter((id) => !broken.has(id)))) {
		if (broken.has(d.id)) continue
		const list = diagnostics.get(d.id) ?? []
		list.push(d)
		diagnostics.set(d.id, list)
	}
	for (const d of runTsc([...broken])) {
		if (!d.code.startsWith("TS1")) continue
		const list = diagnostics.get(d.id) ?? []
		list.push(d)
		diagnostics.set(d.id, list)
	}
}

function runTsc(ids: string[]): Array<Diag & { id: string }> {
	if (ids.length === 0) return []
	writeFileSync(
		join(DIR, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				allowImportingTsExtensions: true,
				customConditions: ["honey-source"],
				lib: ["ESNext", "DOM", "DOM.Iterable"],
				module: "ESNext",
				moduleResolution: "bundler",
				noEmit: true,
				skipLibCheck: true,
				strict: true,
				target: "ESNext",
				types: ["node", "bun-types"],
			},
			files: ids.map((id) => `${id}.ts`),
		}),
	)
	let output = ""
	try {
		execFileSync(TSC, ["-p", DIR, "--pretty", "false"], { encoding: "utf-8", stdio: "pipe" })
	} catch (error) {
		output = String((error as { stdout?: string }).stdout ?? "")
	}
	const out: Array<Diag & { id: string }> = []
	for (const raw of output.split("\n")) {
		const m = /^(?:.*[\\/])?(\w+)\.ts\((\d+),\d+\): error (TS\d+): (.*)$/.exec(raw)
		if (!m) continue
		const [, id, line, code, message] = m as unknown as [string, string, string, string, string]
		out.push({ code, id, line: Number(line) - (offsets.get(id) ?? 0), message })
	}
	return out
}

typecheck()

afterAll(() => {
	if (!process.env.KEEP_TMP) rmSync(DIR, { force: true, recursive: true })
})

describe("documentation snippets", () => {
	it("found the snippets", () => {
		expect(snippets.length).toBeGreaterThan(50)
	})

	for (const s of snippets) {
		const label = `${s.file}:${s.line}`
		/* lines of a continued snippet belong to the one that wrote them */
		const diags = (diagnostics.get(s.id) ?? []).filter((d) => d.line > s.prefix)
		const isHoney = (d: Diag) => d.message.includes("@lovrozagar/honey")
		const unresolved = diags.some((d) => UNRESOLVED_CODES.has(d.code) || (d.code === "TS2307" && !isHoney(d)))

		it(`type-checks ${label}`, () => {
			const errors = diags
				.filter((d) => !UNRESOLVED_CODES.has(d.code) && !(d.code === "TS2307" && !isHoney(d)))
				.filter((d) => !unresolved || d.code.startsWith("TS1") || (HONEY_IMPORT_CODES.has(d.code) && isHoney(d)))
				.map((d) => `${s.file}:${s.line + d.line - s.prefix - 1} ${d.code} ${d.message}`)
			expect(errors).toEqual([])
		})

		if (runnable(s, unresolved)) {
			it(`runs ${label}`, async () => {
				await import(join(DIR, `${s.id}.ts`))
			})
		}
	}
})
