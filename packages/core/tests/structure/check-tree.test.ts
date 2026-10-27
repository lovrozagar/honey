import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { COMPLETE, checkTree, parseRows } from "./check-tree.ts"

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
	"_v0/\t—\tlegacy\t00\tv0\tpackages/core/*",
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
	"_v0/src/index.ts",
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
			"_v0/",
			".oxlintrc.json",
			"scripts/pack.ts",
		])
		expect(rows[0]).toMatchObject({ bit: 1, kind: "src" })
		expect(rows[12]).toMatchObject({ bit: 0, kind: "legacy" })
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
		const files = [
			...BIT_00_FILES,
			"_v0/tests/x.test.ts",
			"bench/src/run.sh",
			"README.md",
			"packages/core/package.json",
		]
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
	it(`matches files.tsv up to bit ${String(COMPLETE).padStart(2, "0")}`, () => {
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
