/**
 * Every TypeScript code block in docs/ compiles against `@lovrozagar/honey` (bit 20), and every `ts run` block runs to
 * its `// prints:` lines. A block's info string says what it is: `ts` type-checks, `ts run` type-checks and runs,
 * `ts v0`, `sh v0` and `text v0` are v0 "before" blocks shown as text only, and `sh`, `json`, `yaml`, `text` and `http`
 * are shown as they are.
 * The SDK and per-language blocks are compiled by gen's examples-compile tests, against the SDKs they call.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { allBlocks, type Block, blocksOf, REPO } from "../../../gen/src/emit/shared/__fixtures__/docs-blocks.ts"

const CORE = join(REPO, "packages/core")
const TSC = join(REPO, "node_modules/typescript/bin/tsc")
/* the block languages c compiles here, the SDK and per-language ones gen compiles, and the ones shown as text */
const COMPILED = new Set(["ts", "ts run"])
const ELSEWHERE = new Set(["ts sdk", "go", "rust", "python", "csharp", "java"])
const SHOWN = new Set(["ts v0", "sh v0", "text v0", "sh", "json", "yaml", "text", "http"])

/* inside core, so `@lovrozagar/honey` resolves through the workspace link with core's honey-source condition */
mkdirSync(join(CORE, ".tmp"), { recursive: true })
const scratch = mkdtempSync(join(CORE, ".tmp/docs-blocks-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

/** A block as its own module: `export {}` keeps two blocks' top-level names apart. */
const moduleOf = (block: Block) => `${block.code}export {}\n`

/** Where `block`'s code line `line` (1-based) sits on its page. */
function pageLine(block: Block, line: number): string {
	const [page, fence] = block.at.split(":") as [string, string]
	return `${page}:${Number(fence) + line}`
}

/** tsc's errors for `blocks`, each at its page and line; [] when every block type-checks. */
export function typeErrors(blocks: readonly Block[], dir: string): string[] {
	if (blocks.length === 0) return []
	const files = blocks.map((block, index) => {
		writeFileSync(join(dir, `b${index}.ts`), moduleOf(block))
		return `b${index}.ts`
	})
	/* the blocks alone: core's own include would type-check its whole tree as well */
	const config = { extends: join(CORE, "tsconfig.json"), files, include: [] }
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config))
	const out = spawnSync("node", [TSC, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" }).stdout
	return out
		.split("\n")
		.map((line) => /^b(\d+)\.ts\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line))
		.filter((match) => match !== null)
		.map(([, index, line, code, text]) => `${pageLine(blocks[Number(index)] as Block, Number(line))} ${code} ${text}`)
}

/** Each `ts run` block run by Node from source: how it failed (an exit, a missing `// prints:` line), or nothing. */
export function runFailures(blocks: readonly Block[], dir: string): string[] {
	return blocks.flatMap((block, index) => {
		const file = join(dir, `run${index}.ts`)
		writeFileSync(file, moduleOf(block))
		const ran = spawnSync("node", ["--conditions=honey-source", "--no-warnings", file], {
			cwd: dir,
			encoding: "utf8",
			timeout: 20_000,
		})
		if (ran.status !== 0) return [`${block.at} exited ${ran.status}: ${ran.stderr.split("\n")[0]}`]
		const wanted = [...block.code.matchAll(/\/\/ prints: (.*)$/gm)].map(([, text]) => (text as string).trim())
		return wanted.filter((text) => !ran.stdout.includes(text)).map((text) => `${block.at} did not print ${text}`)
	})
}

const blocks = allBlocks()
const compiled = blocks.filter((block) => COMPILED.has(block.info))

describe("the docs' TypeScript blocks", () => {
	// v0: e3d67d19ae
	it("finds the docs' blocks, each one a language the docs compile or show", () => {
		expect(compiled.length).toBeGreaterThan(30)
		const known = (info: string) => COMPILED.has(info) || ELSEWHERE.has(info) || SHOWN.has(info)
		expect(blocks.filter((block) => !known(block.info)).map(({ at, info }) => `${at} ${info}`)).toEqual([])
	})

	// v0: 164118034d
	it("type-checks every ts block against @lovrozagar/honey", () => {
		const dir = mkdtempSync(join(scratch, "check-"))
		expect(typeErrors(compiled, dir)).toEqual([])
	}, 120_000)

	// v0: 9c8455e471
	it("runs every ts run block to its // prints: lines", () => {
		const dir = mkdtempSync(join(scratch, "run-"))
		expect(
			runFailures(
				compiled.filter((block) => block.info === "ts run"),
				dir,
			),
		).toEqual([])
	}, 120_000)
})

describe("the docs' streaming pattern", () => {
	// v0: 015b482d5f
	// v0: eb559d11d0
	it("runs: an SSE producer with defaultRetry ends in its finally when the client leaves", () => {
		const page = "docs/streaming.md"
		const pattern = existsSync(join(REPO, page)) ? allBlocks([page]).filter((block) => block.info === "ts run") : []
		const dir = mkdtempSync(join(scratch, "stream-"))
		expect([pattern.length > 0, runFailures(pattern, dir)]).toEqual([true, []])
	}, 60_000)
})

describe("the docs' compile check itself", () => {
	it("reports a block with a type error and one missing an import, each at its page and line", () => {
		const page = [
			"Text.",
			"```ts",
			'const count: number = "three"',
			"```",
			"```ts",
			'const app = honey().get("/").handler((ctx) => ctx.res.text("ok", "hi"))',
			"```",
			"```ts",
			'import { honey } from "@lovrozagar/honey"',
			'honey().get("/").handler((ctx) => ctx.res.text("ok", "hi"))',
			"```",
		].join("\n")
		const dir = mkdtempSync(join(scratch, "fixture-"))
		const found = typeErrors(blocksOf("fixture.md", page), dir)
		/* the lines reported, once each: the valid third block reports none */
		expect([...new Set(found.map((line) => line.split(" ")[0]))]).toEqual(["fixture.md:3", "fixture.md:6"])
		expect(found.filter((line) => / TS2322 | TS2304 /.test(line)).map((line) => line.split(" ")[1])).toEqual([
			"TS2322",
			"TS2304",
		])
	}, 120_000)

	it("reports a run block that does not print what it says", () => {
		const page = ["```ts run", 'console.log("hello")', "// prints: goodbye", "```"].join("\n")
		const dir = mkdtempSync(join(scratch, "fixture-run-"))
		expect(runFailures(blocksOf("fixture.md", page), dir)).toEqual(["fixture.md:1 did not print goodbye"])
	}, 60_000)
})
