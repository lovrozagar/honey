import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { COMPLETE, checkTree, parseRows } from "./check-tree.ts"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const REPO = resolve(import.meta.dirname, "../../../..")

const TSV = [
	"# comment",
	"path\tpkg\tkind\tbit\tresponsibility\torigin",
	"src/routing/app.ts\tcore\tsrc\t01\tthe app\tindex.ts",
	"src/routing/types.ts\tcore\ttypes\t01\ttypes\ttypes.ts",
	"lint/index.js\tcore\tindex\t00\tentry\t—",
	"lint/no-v8-ignore.js\tcore\tsrc\t00\trule\t—",
	"lint/no-v8-ignore.test.ts\tcore\ttest\t00\trule test\t—",
	"tests/structure/check-tree.test.ts\tcore\ttest\t00\tgate\t—",
	"tests/e2e/apps/{compose,kitchen}\tcore\tapp\t00\tapps\te2e/apps/*",
	"src/emit/go/sdk.ts\tgen\tsrc\t12\tgo\tcodegen-go.ts",
	"src/runtime/go/*\tgen\truntime\t12\tgo runtime\tclient-go/*",
	"scripts/capture.ts\tgen\tscript\t00\tcapture\t—",
	"packages/gen/src/_tokenizer/\tgen\tcorpus\t00\ttokenizer\t—",
	"blueprint/baselines/{oracle,perf}-baseline.txt\tcore\tcorpus\t00\tbaselines\t—",
	".oxlintrc.json\tcore\tconfig\t19\tlint config\t.oxlintrc.json",
	"./scripts/pack.ts\tcore\tscript\t19\tthe packer\t—",
	"",
].join("\n")

const BIT_00_FILES = [
	"packages/core/lint/index.js",
	"packages/core/lint/no-v8-ignore.js",
	"packages/core/lint/no-v8-ignore.test.ts",
	"packages/core/tests/structure/check-tree.test.ts",
	"packages/core/tests/e2e/apps/compose/src/app.ts",
	"packages/core/tests/e2e/apps/kitchen/package.json",
	"packages/gen/scripts/capture.ts",
	"packages/gen/src/_tokenizer/o200k_base.json",
	"blueprint/baselines/oracle-baseline.txt",
	"blueprint/baselines/perf-baseline.txt",
]

const rows = parseRows(TSV)

describe("parseRows", () => {
	it("reads data rows, skipping comments, the header and blank lines", () => {
		expect(rows.map((r) => r.path)).toEqual([
			"packages/core/src/routing/app.ts",
			"packages/core/src/routing/types.ts",
			"packages/core/lint/index.js",
			"packages/core/lint/no-v8-ignore.js",
			"packages/core/lint/no-v8-ignore.test.ts",
			"packages/core/tests/structure/check-tree.test.ts",
			"packages/core/tests/e2e/apps/{compose,kitchen}",
			"packages/gen/src/emit/go/sdk.ts",
			"packages/gen/src/runtime/go/*",
			"packages/gen/scripts/capture.ts",
			"packages/gen/src/_tokenizer/",
			"blueprint/baselines/{oracle,perf}-baseline.txt",
			".oxlintrc.json",
			"scripts/pack.ts",
		])
		expect(rows[0]).toMatchObject({ bit: 1, kind: "src" })
	})
})

describe("checkTree --complete 00", () => {
	it("passes when exactly the bit-00 rows exist", () => {
		expect(checkTree(rows, BIT_00_FILES, 0)).toEqual([])
	})

	it("reports a completed row that is missing, including each brace alternative", () => {
		const files = BIT_00_FILES.filter((f) => !f.includes("kitchen") && !f.endsWith("perf-baseline.txt"))
		expect(checkTree(rows, files, 0)).toEqual([
			"missing: packages/core/tests/e2e/apps/kitchen (bit 00)",
			"missing: blueprint/baselines/perf-baseline.txt (bit 00)",
		])
	})

	it("reports a file in scope that no row lists", () => {
		const files = [...BIT_00_FILES, "packages/core/src/routing/stray.ts", "packages/gen/tests/x.test.ts"]
		expect(checkTree(rows, files, 0)).toEqual([
			"unlisted: packages/core/src/routing/stray.ts",
			"unlisted: packages/gen/tests/x.test.ts",
		])
	})

	it("reports a file born before its bit", () => {
		const files = [...BIT_00_FILES, "packages/gen/src/emit/go/sdk.ts", "packages/gen/src/runtime/go/client.go"]
		expect(checkTree(rows, files, 0)).toEqual([
			"early: packages/gen/src/emit/go/sdk.ts (bit 12, complete 00)",
			"early: packages/gen/src/runtime/go/client.go (bit 12, complete 00)",
		])
	})

	it("lets the bit in progress land file by file, but nothing past it", () => {
		const files = [...BIT_00_FILES, "packages/core/src/routing/app.ts", "packages/core/src/routing/app.test.ts"]
		expect(checkTree(rows, files, 0)).toEqual([])
	})

	it("ignores files outside the checked roots", () => {
		const files = [...BIT_00_FILES, "docs/README.md", "bench/src/run.sh", "README.md", "packages/core/package.json"]
		expect(checkTree(rows, files, 0)).toEqual([])
	})
})

describe("checkTree --complete 01", () => {
	it("needs the bit-01 rows and a colocated test for each src row", () => {
		const files = [...BIT_00_FILES, "packages/core/src/routing/app.ts", "packages/core/src/routing/types.ts"]
		expect(checkTree(rows, files, 1)).toEqual(["missing test: packages/core/src/routing/app.test.ts (bit 01)"])
	})

	it("accepts the colocated test as listed by its src row", () => {
		const files = [
			...BIT_00_FILES,
			"packages/core/src/routing/app.ts",
			"packages/core/src/routing/app.test.ts",
			"packages/core/src/routing/types.ts",
		]
		expect(checkTree(rows, files, 1)).toEqual([])
	})
})

describe("the repository", () => {
	it(`matches files.tsv up to bit ${String(COMPLETE).padStart(2, "0")}`, { timeout: SPAWN_TIMEOUT }, () => {
		const tsv = readFileSync(join(REPO, "blueprint/files.tsv"), "utf8")
		const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: REPO,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		})
			.split("\0")
			.filter((f) => f !== "")
		expect(checkTree(parseRows(tsv), files, COMPLETE)).toEqual([])
	})
})

/** gen's SDK-only grid rows, where bit 21 i2 staged the over-cap row's targets. */
const SDK_ROWS = "packages/gen/tests/integration/conformance/features-sdk.ts"
const OVER_CAP_FIX = "add the remaining SDKs to the over-cap row and delete OVER_CAP_SDKS"
const source = () => readFileSync(join(REPO, SDK_ROWS), "utf8")

/**
 * What bit 21 still owes at `complete` of the staged over-cap list: nothing before it closes; once COMPLETE reaches 21,
 * the fix while `text` (features-sdk.ts) still declares OVER_CAP_SDKS, so the list cannot outlive the bit.
 */
const overCapOwed = (complete: number, text: string) =>
	complete >= 21 && /\bOVER_CAP_SDKS\b/.test(text) ? [OVER_CAP_FIX] : []

describe("bit 21's staged over-cap list (i2)", () => {
	/* i7 deleted the list, so the leg seeds it back into today's source to prove the guard still reds on it */
	it("names its fix once the bit closes while features-sdk.ts declares it, and nothing without it", () => {
		const staged = `${source()}\nexport const OVER_CAP_SDKS = ["ts"] as const\n`
		expect([overCapOwed(21, staged), overCapOwed(21, source()), overCapOwed(20, staged)]).toEqual([
			[OVER_CAP_FIX],
			[],
			[],
		])
	})

	it(`is gone before bit 21 closes (COMPLETE is ${COMPLETE})`, () => {
		expect(overCapOwed(COMPLETE, source())).toEqual([])
	})
})
