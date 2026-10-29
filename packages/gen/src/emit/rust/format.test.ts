/**
 * The emitted crate through the rustfmt post-pass, the pinned build, clippy and the floor check (contract 18
 * §8.7). Every crate here is a registry entry (`FIXTURES`, Fb5): `fixtures` is a4673b6e42's nine v0 specs merged
 * into one document, both styles in one crate (bit 21 i4). That the floor legs can fail at all is the canary's
 * to prove, and `sdk.driver.test.ts` ("the compile options: clippy, and the floor toolchain") proves it: 1.85.0
 * rejects `Vec::pop_if` with E0658, and clippy reports it under `incompatible_msrv`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { devNull } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Formatter, formatFiles } from "../shared/format.ts"
import { rustfmtFormatter } from "../shared/rustfmt.ts"
import { compiledRust } from "./__fixtures__/compiled.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { RUST_FLOOR, runRustfmt, rustCacheDir, rustfmtPath, withRust } from "./__fixtures__/rust-env.ts"
import { runtimeFiles } from "./http.ts"
import { generateRustSdk } from "./sdk.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()
const FLOOR = withRust(RUST_FLOOR)

/** The merged fixtures' crate, as emitted. */
const emitted = () => generateRustSdk(FIXTURES.fixtures.document()).files

/** `files`' `.rs` entries. */
const rustOf = (files: Readonly<Record<string, string>>) =>
	Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith(".rs")))

/** `files` written into a fresh dir under the Rust cache, each path absolute. */
function written(files: Readonly<Record<string, string>>): string[] {
	const dir = mkdtempSync(join(rustCacheDir("tmp"), "fmt-"))
	return Object.entries(files).map(([name, text]) => {
		const path = join(dir, name)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, text)
		return path
	})
}

describe("the emitted Rust SDK through the rustfmt pass", () => {
	it("goes out as emitted without a rustfmt", async () => {
		const files = emitted()
		expect(await formatFiles(files, {})).toEqual(files)
	})

	// v0: e098b959c6
	it.skipIf(!RUST)(
		"leaves rustfmt --check nothing to change after the pass, and a second pass changes nothing",
		async () => {
			const rs = rustOf(await formatFiles(emitted(), { rs: rustfmtFormatter(rustfmtPath()) }))
			expect(Object.keys(rs).length).toBeGreaterThan(0)
			expect(await formatFiles(rs, { rs: rustfmtFormatter(rustfmtPath()) })).toEqual(rs)
			const check = runRustfmt(["--edition", "2024", "--config-path", devNull, "--check", ...written(rs)])
			expect({ status: check.status, stdout: check.stdout }, check.stderr).toEqual({ status: 0, stdout: "" })
		},
		600_000,
	)

	it.skipIf(!RUST)("ships a runtime the rustfmt pass leaves as it is", { timeout: SPAWN_TIMEOUT }, async () => {
		const runtime = rustOf(runtimeFiles({ realtime: true, ws: true }))
		expect(Object.keys(runtime).length).toBeGreaterThan(0)
		expect(await formatFiles(runtime, { rs: rustfmtFormatter(rustfmtPath()) })).toEqual(runtime)
	})
})

describe("the long-name crate through the rustfmt pass (bit 21 i7a)", () => {
	// bit 21 i7a: red-first clean
	it.skipIf(!RUST)(
		"leaves rustfmt --check nothing to change over every file, both styles' client and the types, and builds as emitted",
		async () => {
			const files = generateRustSdk(FIXTURES.long.document()).files
			const reached: string[] = []
			const rustfmt = rustfmtFormatter(rustfmtPath())
			const counting: Formatter = (name, source, options) => {
				reached.push(name)
				return rustfmt(name, source, options)
			}
			const rs = rustOf(await formatFiles(files, { rs: counting }))
			/* not vacuous: the pass reaches every .rs file, and the client (one impl per resource, both styles) and the types run past 100 */
			const long = (name: string) => (files[name] ?? "").split("\n").filter((line) => line.length > 100).length
			const styled = [...(files["src/client.rs"] ?? "").matchAll(/^impl<S: Style> \w+Resource<'_, S> \{$/gm)].length
			expect({
				client: long("src/client.rs") > 0,
				reached: reached.sort(),
				styled,
				types: long("src/types.rs") > 0,
			}).toEqual({
				client: true,
				reached: Object.keys(rustOf(files)).sort(),
				styled: 11,
				types: true,
			})
			expect(await formatFiles(rs, { rs: rustfmtFormatter(rustfmtPath()) })).toEqual(rs)
			const check = runRustfmt(["--edition", "2024", "--config-path", devNull, "--check", ...written(rs)])
			expect({ status: check.status, stdout: check.stdout }, check.stderr).toEqual({ status: 0, stdout: "" })
			const sdk = compiledRust("long")
			expect(sdk.built, sdk.stderr).toBe(true)
		},
		600_000,
	)
})

describe("the emitted Rust SDK under the pinned toolchain", () => {
	// v0: a4673b6e42
	it.skipIf(!RUST)(
		"builds the nine v0 fixtures, merged into one crate, as emitted",
		() => {
			const sdk = compiledRust("fixtures")
			expect(sdk.built, sdk.stderr).toBe(true)
		},
		600_000,
	)

	// v0: ade06d74b8
	it.skipIf(!RUST)(
		"builds one crate for both styles: Client's members and every resource in the client's style, as emitted",
		() => {
			const sdk = compiledRust("fixtures")
			expect(sdk.built, sdk.stderr).toBe(true)
			/* v0's safe-mode crate is client.safe() now: no resource or Client member outside `S: Style` but new */
			const client = generateRustSdk(FIXTURES.fixtures.document()).files["src/client.rs"] ?? ""
			const heads = [...client.matchAll(/^impl(?:<[^>]*>)? \w+(?:<[^>]*>)? \{$/gm)].map(([head]) => head)
			expect({ plain: heads.filter((head) => !head.includes("S: Style")), styled: heads.length > 10 }).toEqual({
				plain: ["impl Client {"],
				styled: true,
			})
		},
		600_000,
	)

	it.skipIf(!RUST)(
		"is clippy clean under -D warnings, and -D clippy::incompatible_msrv holds both styles to the floor",
		() => {
			const sdk = compiledRust("fixtures")
			expect(sdk.built ? sdk.clippy() : sdk.stderr).toEqual([])
		},
		600_000,
	)
})

describe("the emitted Rust SDK under the RUST_FLOOR toolchain", () => {
	it.skipIf(!FLOOR)(
		"checks clean under the floor toolchain itself",
		() => {
			const floor = compiledRust("fixtures", { check: true, toolchain: RUST_FLOOR })
			expect(floor.built, floor.stderr).toBe(true)
		},
		600_000,
	)
})
