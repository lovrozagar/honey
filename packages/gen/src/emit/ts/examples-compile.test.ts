/**
 * The docs' TypeScript SDK code compiles against an SDK generated from the docs' API (bit 20): every `ts sdk` block
 * on a docs page and docs/examples/ts/example.ts, each importing the client from `./kitchen`, type-checked by tsc
 * beside the generated files.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { allBlocks, type Block, docsDocument, exampleOf, REPO } from "../shared/__fixtures__/docs-blocks.ts"
import { generateSdk } from "./sdk.ts"

const GEN = join(REPO, "packages/gen")
const TSC = join(REPO, "node_modules/typescript/bin/tsc")
const OPTIONS = {
	lib: ["ESNext", "DOM"],
	module: "ESNext",
	moduleResolution: "bundler",
	noEmit: true,
	skipLibCheck: true,
	strict: true,
	target: "ESNext",
	types: ["node"],
}

/* inside gen, so @types/node resolves from the workspace */
mkdirSync(join(GEN, ".tmp"), { recursive: true })
const scratch = mkdtempSync(join(GEN, ".tmp/docs-sdk-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

/** tsc's errors for `sources` (name → code, each a module beside the generated SDK), by source and line. */
export function sdkTypeErrors(sources: Readonly<Record<string, string>>, dir: string): string[] {
	for (const [path, text] of Object.entries(generateSdk(docsDocument(), { name: "Kitchen" }).files))
		writeFileSync(join(dir, path), text)
	writeFileSync(join(dir, "kitchen.ts"), 'export * from "./kitchen.index.gen"\n')
	for (const [name, code] of Object.entries(sources)) writeFileSync(join(dir, name), `${code}export {}\n`)
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: OPTIONS, files: Object.keys(sources) }))
	const out = spawnSync("node", [TSC, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" }).stdout
	return out.split("\n").filter((line) => / error TS\d+/.test(line))
}

/** Each `ts sdk` block as a source named after its page and line. */
const sourcesOf = (blocks: readonly Block[]) =>
	Object.fromEntries(
		blocks
			.filter((block) => block.info === "ts sdk")
			.map((block) => [`${block.at.replace(/[/:.]/g, "_")}.ts`, block.code]),
	)

describe("the docs' TypeScript SDK code", () => {
	it("type-checks every ts sdk block and the TypeScript example against the generated SDK", () => {
		const sources = { ...sourcesOf(allBlocks()), "example.ts": exampleOf("ts", "example.ts") }
		expect(Object.keys(sources).length).toBeGreaterThan(10)
		expect(sdkTypeErrors(sources, mkdtempSync(join(scratch, "docs-")))).toEqual([])
	}, 120_000)

	it("reports a block that calls an operation the SDK does not have", () => {
		const code = 'import { Kitchen } from "./kitchen"\nnew Kitchen({ baseURL: "https://x.test" }).getNothing()\n'
		const found = sdkTypeErrors({ "bogus.ts": code }, mkdtempSync(join(scratch, "fixture-")))
		expect(found.map((line) => line.split("(")[0])).toEqual(["bogus.ts"])
	}, 120_000)
})
