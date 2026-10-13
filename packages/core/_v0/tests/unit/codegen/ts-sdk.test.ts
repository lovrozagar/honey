import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ── environment probe ── */

const hasTsc = (() => {
	try {
		execSync("bunx tsc --version", { stdio: "pipe" })
		return true
	} catch {
		return false
	}
})()

/* ── tsconfig written into each tmpdir ── */

const TSCONFIG = JSON.stringify({
	compilerOptions: {
		strict: true,
		noEmit: true,
		target: "ES2022",
		module: "ESNext",
		moduleResolution: "Bundler",
		skipLibCheck: true,
		allowSyntheticDefaultImports: true,
		esModuleInterop: true,
	},
	include: ["*.ts"],
})

/* ── fixtures ── */

const FIXTURES = ["crud", "discriminated", "invalidation", "ws", "sse", "refs", "reserved-words"]

const STEM = "sdk"

/* maps GeneratedSDK.files keys → filenames written to tmpdir */
const FILE_NAMES: Record<string, string> = {
	client: `${STEM}.client.gen.ts`,
	index: `${STEM}.index.gen.ts`,
	map: `${STEM}.map.gen.ts`,
	runtime: `${STEM}.runtime.gen.ts`,
	types: `${STEM}.types.gen.ts`,
}

/* ── suite ── */

describe.skipIf(!hasTsc)("ts-sdk compile check", () => {
	for (const fixtureName of FIXTURES) {
		it(`${fixtureName} — tsc --noEmit`, () => {
			const url = new URL(`./fixtures/python/${fixtureName}.json`, import.meta.url)
			const spec = JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>

			const { files } = generateSDK(spec, { name: "TestSDK", stem: STEM })

			const dir = mkdtempSync(join(tmpdir(), "honey-ts-sdk-"))

			try {
				for (const [key, content] of Object.entries(files)) {
					if (content === null) continue
					const filename = FILE_NAMES[key]
					if (!filename) continue
					writeFileSync(join(dir, filename), content)
				}

				writeFileSync(join(dir, "tsconfig.json"), TSCONFIG)

				try {
					execSync(`bunx tsc --noEmit -p ${dir}`, { stdio: "pipe", encoding: "utf8" })
				} catch (raw) {
					const e = raw as { stdout?: string; stderr?: string }
					const output = (e.stdout ?? "") + (e.stderr ?? "")
					expect.fail(`tsc errors in fixture "${fixtureName}":\n${output}`)
				}
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
		})
	}
})
