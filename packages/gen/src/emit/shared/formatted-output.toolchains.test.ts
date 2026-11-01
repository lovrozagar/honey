/**
 * What the shipped pipeline hands back is already formatted (bit 22). The gate drives `generated()` — the one
 * function both the bin and a module-API caller go through — and runs each formatter's own `--check` over the
 * files it returns. It never formats anything itself: `emit/python/__fixtures__/ruff-gate.ts` does that, which
 * proves ruff's output is ruff-clean and says nothing about whether honey ever calls ruff. That gap shipped
 * `--target python` output with a 623-character import line through rc.9.
 *
 * Runs where the toolchains are; `HONEY_REQUIRE_TOOLCHAINS=1` (CI's test and harness jobs) makes a missing
 * toolchain fail this leg rather than skip it. The product's own strictness is a different variable,
 * `HONEY_REQUIRE_FORMATTERS`, so CI setting the first one never turns an incidental generation fatal.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { generated } from "../../cli.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import { ruffPath, runRuff, withPython } from "../python/__fixtures__/python-env.ts"
import { rustfmtPath, runRustfmt, withRust } from "../rust/__fixtures__/rust-env.ts"

/* enough operations that an unformatted import block runs past any line width */
const document = {
	info: { title: "Shop", version: "1" },
	openapi: "3.1.0",
	paths: Object.fromEntries(
		Array.from({ length: 14 }, (_, i) => [
			`/things/${String(i)}`,
			{
				get: {
					operationId: `thing.list${String(i)}`,
					responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "" } },
				},
			},
		]),
	),
} as unknown as Record<string, unknown>

/** The files one target's generation returns, written to a directory a formatter can check. */
async function generatedInto(
	target: "python" | "rust",
	extension: string,
): Promise<{ dir: string; written: string[] }> {
	/* the pinned binaries, named through the env honey's discovery reads: PATH must not decide a test */
	const env = { ...process.env, RUFF: ruffPath(), RUSTFMT: rustfmtPath() }
	const files = await generated({ targets: [target] }, document, { env, report: () => undefined })
	const dir = mkdtempSync(join(tmpdir(), `honey-formatted-${target}-`))
	const written: string[] = []
	for (const [name, text] of Object.entries(files[target] ?? {})) {
		if (!name.endsWith(extension)) continue
		/* at their real relative paths: rustfmt follows `mod` declarations, so a flattened tree cannot parse */
		const at = join(dir, name)
		mkdirSync(dirname(at), { recursive: true })
		writeFileSync(at, text)
		written.push(at)
	}
	return { dir, written }
}

describe.skipIf(!withPython())("the python target comes back ruff-formatted (bit 22)", () => {
	it("is already formatted when the pipeline returns it, by ruff's own check", { timeout: SPAWN_TIMEOUT }, async () => {
		const { dir } = await generatedInto("python", ".py")
		/* the flags the pipeline's own pass uses, so the check and the pass cannot disagree */
		const checked = runRuff(["format", "--isolated", "--target-version", "py311", "--check", dir])
		/* --check exits 1 and names each file it would rewrite; it prints a count either way */
		expect({ status: checked.status, would: /would be reformatted/.test(checked.stdout) }).toEqual({
			status: 0,
			would: false,
		})
	})

	it("sorts its imports, which is the same pass", { timeout: SPAWN_TIMEOUT }, async () => {
		const { dir } = await generatedInto("python", ".py")
		const checked = runRuff(["check", "--isolated", "--select", "I", dir])
		expect(checked.status).toBe(0)
	})
})

describe.skipIf(!withRust())("the rust target comes back rustfmt-formatted (bit 22)", () => {
	it("is already formatted when the pipeline returns it", { timeout: SPAWN_TIMEOUT }, async () => {
		const { written } = await generatedInto("rust", ".rs")
		/* rustfmt takes files, never a directory, and follows `mod`, so the tree keeps its real paths */
		expect(written.length).toBeGreaterThan(0)
		const checked = runRustfmt(["--edition", "2024", "--config-path", "/dev/null", "--check", ...written])
		/* --check prints a diff and exits 1 when it would rewrite anything */
		expect({ status: checked.status, diff: checked.stdout.trim() }).toEqual({ status: 0, diff: "" })
	})
})

describe("a formatter that is not there", () => {
	it("leaves the files as emitted and names the skip, rather than failing", { timeout: SPAWN_TIMEOUT }, async () => {
		const reported: string[] = []
		const files = await generated({ targets: ["python"] }, document, {
			env: { PATH: "" },
			report: (line) => reported.push(line),
		})
		expect(Object.keys(files.python ?? {}).length).toBeGreaterThan(0)
		expect(reported).toEqual([
			"honey-clients: ruff was not found, so the python output is not formatted (install ruff, or set RUFF)\n",
		])
	})

	it("refuses an override that points at nothing, naming the variable", { timeout: SPAWN_TIMEOUT }, async () => {
		/* a stale RUFF would otherwise spawn-fail inside the pass, which formatFiles raises as a parse error,
		   and falling back to another ruff would ignore what the run explicitly asked for */
		const missing = join(tmpdir(), "honey-no-such-ruff")
		await expect(
			generated({ targets: ["python"] }, document, {
				env: { PATH: "", RUFF: missing },
				report: () => undefined,
			}),
		).rejects.toThrow(`RUFF=${missing} is not there`)
	})

	it("fails instead under HONEY_REQUIRE_FORMATTERS", { timeout: SPAWN_TIMEOUT }, async () => {
		await expect(
			generated({ targets: ["python"] }, document, {
				env: { HONEY_REQUIRE_FORMATTERS: "1", PATH: "" },
				report: () => undefined,
			}),
		).rejects.toThrow("ruff was not found")
	})
})

describe("a target with no formatter", () => {
	it("comes back exactly as the emitter wrote it", { timeout: SPAWN_TIMEOUT }, async () => {
		/* csharp has no formatter in this repository, so its files must pass through untouched */
		const files = await generated({ targets: ["csharp"] }, document, {
			env: process.env,
			report: () => undefined,
		})
		expect(Object.keys(files.csharp ?? {}).length).toBeGreaterThan(0)
	})
})
