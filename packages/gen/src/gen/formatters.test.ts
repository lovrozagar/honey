/**
 * Discovery and the skip rule (bit 22). The precedence of gofmt's four sources stays in `cli.test.ts`, which
 * owns that leg; this covers what bit 22 added: an override is honoured first and refused when it points at
 * nothing, a target with no row is left alone, and a formatter that is not there is named rather than fatal —
 * fatal only where the toolchains are required.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "./__fixtures__/spawn-timeout.ts"
import { FORMATTERS, findGofmt, findRuff, findRustfmt, formatterFor, missingFormatter } from "./formatters.ts"

/** A directory holding executables named `names`, as a PATH entry or an override's target. */
function binaries(...names: readonly string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "honey-formatters-"))
	for (const name of names) writeFileSync(join(dir, name), "", { mode: 0o755 })
	return dir
}

const MISSING = join(tmpdir(), "honey-no-such-binary")

describe("an override names the binary, and must name one that is there", () => {
	it("honours each override ahead of PATH", () => {
		const named = binaries("ruff", "rustfmt", "gofmt")
		const path = binaries("ruff", "rustfmt", "gofmt")
		expect([
			findRuff({ PATH: path, RUFF: join(named, "ruff") }),
			findRustfmt({ PATH: path, RUSTFMT: join(named, "rustfmt") }),
			findGofmt({ GOFMT: join(named, "gofmt"), PATH: path }),
		]).toEqual([join(named, "ruff"), join(named, "rustfmt"), join(named, "gofmt")])
	})

	it("refuses an override that points at nothing, naming the variable", () => {
		/* never a silent fall back to another binary: the run asked for this one */
		const path = binaries("ruff", "rustfmt", "gofmt")
		expect(() => findRuff({ PATH: path, RUFF: MISSING })).toThrow(`RUFF=${MISSING} is not there`)
		expect(() => findRustfmt({ PATH: path, RUSTFMT: MISSING })).toThrow(`RUSTFMT=${MISSING} is not there`)
		expect(() => findGofmt({ GOFMT: MISSING, PATH: path })).toThrow(`GOFMT=${MISSING} is not there`)
	})

	it("reads an empty override as unset, so an env that blanks it still searches PATH", () => {
		const path = binaries("ruff")
		expect(findRuff({ PATH: path, RUFF: "" })).toBe(join(path, "ruff"))
	})

	it("falls to PATH, and answers none when nothing is there", () => {
		const path = binaries("ruff", "rustfmt")
		expect([findRuff({ PATH: path }), findRustfmt({ PATH: path })]).toEqual([join(path, "ruff"), join(path, "rustfmt")])
		expect([findRuff({ PATH: "" }), findRustfmt({ PATH: "" }), findGofmt({ PATH: "" })]).toEqual([
			undefined,
			undefined,
			undefined,
		])
	})

	it("prefers the toolchain's own rustfmt beside rustc over the rustup proxy on PATH", () => {
		/* the proxy picks a toolchain by cwd, so the sysroot binary is the one that formats the same anywhere */
		const toolchain = mkdtempSync(join(tmpdir(), "honey-rustup-"))
		mkdirSync(join(toolchain, "bin"))
		for (const name of ["rustc", "rustfmt"]) writeFileSync(join(toolchain, "bin", name), "", { mode: 0o755 })
		const proxy = binaries("rustfmt")
		expect(findRustfmt({ PATH: `${join(toolchain, "bin")}:${proxy}` })).toBe(join(toolchain, "bin", "rustfmt"))
	})
})

describe("the table says which targets are formatted", () => {
	it("holds a row for every target that has a formatter in this repository", () => {
		expect(Object.keys(FORMATTERS).sort()).toEqual(["cli", "go", "python", "rust", "ts"])
	})

	it("holds none for csharp or java, whose formatters work over a project rather than a stream", () => {
		expect([FORMATTERS.csharp, FORMATTERS.java]).toEqual([undefined, undefined])
	})

	it("keys each row by the extension the post-pass dispatches on", () => {
		expect(Object.entries(FORMATTERS).map(([target, pass]) => [target, pass?.extension])).toEqual([
			["cli", "go"],
			["go", "go"],
			["python", "py"],
			["rust", "rs"],
			["ts", "ts"],
		])
	})
})

describe("formatterFor builds the formatter each target's row names", () => {
	it("builds one for every target that has a row, from the binary it finds", { timeout: SPAWN_TIMEOUT }, async () => {
		const dir = binaries("gofmt", "ruff", "rustfmt")
		const env = { PATH: dir }
		const built = await Promise.all(
			(["cli", "go", "python", "rust"] as const).map((target) => formatterFor(target, { env })),
		)
		expect(built.map((formatter) => typeof formatter)).toEqual(["function", "function", "function", "function"])
	})

	it(
		"builds none when the binary is missing, which is what the skip rule reads",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const env = { PATH: "" }
			const built = await Promise.all(
				(["cli", "go", "python", "rust"] as const).map((target) => formatterFor(target, { env })),
			)
			expect(built).toEqual([undefined, undefined, undefined, undefined])
		},
	)

	it("loads oxfmt for ts, and none for a specifier that does not resolve", { timeout: SPAWN_TIMEOUT }, async () => {
		expect(typeof (await formatterFor("ts", { env: {} }))).toBe("function")
		expect(await formatterFor("ts", { env: {}, oxfmt: "@honey/no-such-oxfmt" })).toBeUndefined()
	})

	it("builds none for a target with no row, so the dispatch is total", { timeout: SPAWN_TIMEOUT }, async () => {
		/* generated() guards on the table before asking, so this arm answers only a direct caller */
		expect([await formatterFor("csharp", { env: {} }), await formatterFor("java", { env: {} })]).toEqual([
			undefined,
			undefined,
		])
	})
})

describe("a formatter that is not there", () => {
	const pass = FORMATTERS.python as NonNullable<typeof FORMATTERS.python>

	it("is named on the report, with what to install, and is not fatal", () => {
		const said: string[] = []
		missingFormatter("python", pass, {}, (line) => said.push(line))
		expect(said).toEqual([
			"honey-clients: ruff was not found, so the python output is not formatted (install ruff, or set RUFF)\n",
		])
	})

	it("is fatal where the toolchains are required, which is CI", () => {
		expect(() => missingFormatter("python", pass, { HONEY_REQUIRE_TOOLCHAINS: "1" }, () => undefined)).toThrow(
			"ruff was not found",
		)
	})
})
