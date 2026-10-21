import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { withDotnet } from "../../src/emit/csharp/__fixtures__/csharp-env.ts"
import { runtimeFiles as csharpRuntimeFiles } from "../../src/emit/csharp/transport.ts"
import { goCacheDir, withGo } from "../../src/emit/go/__fixtures__/go-env.ts"
import { pythonCacheDir, withPython } from "../../src/emit/python/__fixtures__/python-env.ts"
import { runtimeFiles as pythonRuntimeFiles } from "../../src/emit/python/transport.ts"
import { rustCacheDir, withRust } from "../../src/emit/rust/__fixtures__/rust-env.ts"
import { runtimeFiles as rustRuntimeFiles } from "../../src/emit/rust/http.ts"
import { runSuite } from "./mutation-harness.ts"
import { GUARDS, guardNamed, SUITES, skippedFor, type Toolchain, verdicts } from "./mutation-harness.guards.ts"

/* a guard's suite reruns, its fuzz included, once per guard; a cold Rust cache pays the dependency build (Ff10) */
const RUN = 600_000

const CSHARP_GUARDS = ["csharp-cross-origin-auth", "csharp-path-param-escape", "csharp-auth-redaction"]
const GO_GUARDS = ["go-cross-origin-auth", "go-auth-redaction", "go-path-param-escape"]
const RUST_GUARDS = ["rust-cross-origin-auth", "rust-auth-redaction", "rust-path-param-escape"]
const PYTHON_GUARDS = ["python-cross-origin-auth", "python-auth-redaction", "python-path-param-escape"]

const GEN = resolve(import.meta.dirname, "../..")

/* the plain HTTP runtime, which every Rust and Python SDK ships and the guards patch */
const PLAIN = { realtime: false, ws: false }

/** The root namespace the C# reader is given: any one, since the guards only name the files they change. */
const CSHARP_ROOT = "Acme.Sdk"

/** A language's runtime reader, as its guarded module exports it: its features, then any further arguments. */
type Reader<A extends unknown[]> = (...args: A) => Record<string, string>

/** The runtime files `id`'s disabled `reader` writes, by name, given `args`. */
function disabledRuntime<A extends unknown[]>(id: string, reader: Reader<A>, ...args: A): Record<string, string> {
	const disable = guardNamed(id)?.disable ?? ((): Record<string, unknown> => ({}))
	return (disable({ runtimeFiles: reader }).runtimeFiles as Reader<A>)(...args)
}

/** For each of `ids`, the names of the runtime files its disabled `reader` changes, given `args`. */
function changedFiles<A extends unknown[]>(ids: readonly string[], reader: Reader<A>, ...args: A): string[][] {
	const plain = reader(...args)
	return ids.map((id) => {
		const files = disabledRuntime(id, reader, ...args)
		return Object.keys(plain).filter((name) => files[name] !== plain[name])
	})
}

/** The `.ts` files under gen's `dir`, repo-relative to gen, `.test.ts` ones only or none of them. */
function sources(dir: string, tests: boolean): string[] {
	return readdirSync(join(GEN, dir), { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts") && name.endsWith(".test.ts") === tests)
		.map((name) => join(dir, name))
}

/** The gen-relative paths `file` imports, statically or dynamically. */
function imports(file: string): string[] {
	const specifiers = readFileSync(join(GEN, file), "utf8").matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)
	return [...specifiers].map(([, specifier]) => relative(GEN, resolve(GEN, dirname(file), specifier ?? "")))
}

describe("the gen guard registry", () => {
	it("names each guard once, with the gen module it lives in", () => {
		const ids = GUARDS.map((g) => g.id)
		expect(new Set(ids).size).toBe(ids.length)
		expect(GUARDS.every((g) => g.module.startsWith("packages/gen/src/"))).toBe(true)
		expect(guardNamed("escape-bypass")).toMatchObject({ module: "packages/gen/src/emit/shared/escape.ts" })
	})

	it("runs the plain suite when no mutant is named, and refuses one it does not know", () => {
		expect([guardNamed(undefined), guardNamed("")]).toEqual([undefined, undefined])
		expect(() => guardNamed("escape-bypas")).toThrow(/unknown guard "escape-bypas"/)
	})
})

describe("each guard's toolchain", () => {
	it("holds the three Go runtime guards, each needing Go and patching the Go runtime reader", () => {
		expect(GO_GUARDS.map((id) => guardNamed(id))).toEqual(
			GO_GUARDS.map((id) =>
				expect.objectContaining({ id, module: "packages/gen/src/emit/go/http.ts", toolchain: "go" }),
			),
		)
	})

	it("holds the three Rust runtime guards, each needing Rust and patching the Rust runtime reader", () => {
		expect(RUST_GUARDS.map((id) => guardNamed(id))).toEqual(
			RUST_GUARDS.map((id) =>
				expect.objectContaining({ id, module: "packages/gen/src/emit/rust/http.ts", toolchain: "rust" }),
			),
		)
		expect(changedFiles(RUST_GUARDS, rustRuntimeFiles, PLAIN)).toEqual([["redirect.rs"], ["exchange.rs"], ["path.rs"]])
	})

	it("holds the three Python runtime guards, each needing Python and patching the Python runtime reader", () => {
		expect(PYTHON_GUARDS.map((id) => guardNamed(id))).toEqual(
			PYTHON_GUARDS.map((id) =>
				expect.objectContaining({ id, module: "packages/gen/src/emit/python/transport.ts", toolchain: "python" }),
			),
		)
		expect(changedFiles(PYTHON_GUARDS, pythonRuntimeFiles, PLAIN)).toEqual([
			["redirect.py"],
			["exchange.py"],
			["path.py"],
		])
	})

	it("holds the three C# runtime guards, each needing .NET and patching the C# runtime reader", () => {
		expect(CSHARP_GUARDS.map((id) => guardNamed(id))).toEqual(
			CSHARP_GUARDS.map((id) =>
				expect.objectContaining({ id, module: "packages/gen/src/emit/csharp/transport.ts", toolchain: "csharp" }),
			),
		)
		expect(changedFiles(CSHARP_GUARDS, csharpRuntimeFiles, PLAIN, CSHARP_ROOT)).toEqual([
			["Handler.cs", "Redirect.cs"],
			["Path.cs"],
			["Exchange.cs"],
		])
	})

	it("skips each toolchain's guards only where that toolchain is absent", () => {
		expect([
			skippedFor(GUARDS, { csharp: false, go: false, python: false, rust: false }),
			skippedFor(GUARDS, { csharp: false, go: true, python: false, rust: false }),
			skippedFor(GUARDS, { csharp: false, go: true, python: false, rust: true }),
			skippedFor(GUARDS, { csharp: false, go: true, python: true, rust: true }),
			skippedFor(GUARDS, { csharp: true, go: true, python: true, rust: true }),
		]).toEqual([
			[...GO_GUARDS, ...RUST_GUARDS, ...PYTHON_GUARDS, ...CSHARP_GUARDS],
			[...RUST_GUARDS, ...PYTHON_GUARDS, ...CSHARP_GUARDS],
			[...PYTHON_GUARDS, ...CSHARP_GUARDS],
			CSHARP_GUARDS,
			[],
		])
	})
})

describe("each guard's verdict", () => {
	it("runs every guard, all 19, where .NET, Go, Rust and Python are present", () => {
		const ids = GUARDS.map((g) => g.id)
		expect(verdicts(GUARDS, skippedFor(GUARDS, { csharp: true, go: true, python: true, rust: true }), () => 1)).toEqual(
			{
				killed: ids,
				skipped: [],
				survived: [],
			},
		)
		expect(ids).toHaveLength(19)
	})

	it("counts a skipped guard as neither killed nor survived, and never runs it", () => {
		const ran: string[] = []
		const run = (id: string) => {
			ran.push(id)
			return id === "escape-bypass" ? 0 : 1
		}
		const tsIds = GUARDS.filter((g) => g.toolchain === undefined).map((g) => g.id)
		expect(verdicts(GUARDS, skippedFor(GUARDS, { csharp: false, go: false, python: false, rust: false }), run)).toEqual(
			{
				killed: tsIds.filter((id) => id !== "escape-bypass"),
				skipped: [...GO_GUARDS, ...RUST_GUARDS, ...PYTHON_GUARDS, ...CSHARP_GUARDS],
				survived: ["escape-bypass"],
			},
		)
		expect(ran).toEqual(tsIds)
	})
})

describe("each toolchain guard's suite", () => {
	it("reruns a toolchain guard's own security file alone, the one that imports its language's emitter", () => {
		/* sound only while no shared module imports a language emitter: a guard's mock reaches only the files that
		 * import its module, so no other security file can see it (Ff12) */
		const security = sources("tests/security", true)
		const toolchains = Object.keys(SUITES) as Toolchain[]
		const naming = toolchains.map((toolchain) =>
			security.filter((file) => readFileSync(join(GEN, file), "utf8").includes(`src/emit/${toolchain}/`)),
		)
		expect(naming).toEqual(toolchains.map((toolchain) => [SUITES[toolchain]]))
		const language = /^src\/emit\/(?!shared\/)[^/]+\//
		const crossing = sources("src/emit/shared", false).filter((file) => imports(file).some((to) => language.test(to)))
		expect(crossing).toEqual([])
	})
})

describe("the harness where a toolchain is required", () => {
	it("fails before any suite run instead of skipping when Go is required and absent", () => {
		/* a PATH of one empty directory hides every go; the harness itself runs under this process's own runtime */
		const harness = join(import.meta.dirname, "mutation-harness.ts")
		const env = { ...process.env, HONEY_REQUIRE_GO: "1", PATH: goCacheDir("empty-path") }
		const run = spawnSync(process.execPath, [harness], { encoding: "utf8", env, timeout: 60_000 })
		expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 1, stdout: "" })
		expect(run.stderr).toMatch(/Go is required here/)
	})

	it("fails before any suite run instead of skipping when Rust is required and absent", () => {
		/* Go's flags cleared, or Go would throw first and name itself */
		const harness = join(import.meta.dirname, "mutation-harness.ts")
		const env = {
			...process.env,
			HONEY_REQUIRE_GO: "",
			HONEY_REQUIRE_RUST: "1",
			HONEY_REQUIRE_TOOLCHAINS: "",
			PATH: rustCacheDir("empty-path"),
		}
		const run = spawnSync(process.execPath, [harness], { encoding: "utf8", env, timeout: 60_000 })
		expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 1, stdout: "" })
		expect(run.stderr).toMatch(/Rust .* is required here/)
	})

	it("fails before any suite run instead of skipping when Python is required and absent", () => {
		/* Python is found through the pinned uv under HOME, never on PATH, so an empty HOME hides it (python-env) */
		const harness = join(import.meta.dirname, "mutation-harness.ts")
		const env = {
			...process.env,
			HOME: pythonCacheDir("tmp", "no-uv"),
			HONEY_REQUIRE_GO: "",
			HONEY_REQUIRE_PYTHON: "1",
			HONEY_REQUIRE_RUST: "",
			HONEY_REQUIRE_TOOLCHAINS: "",
		}
		const run = spawnSync(process.execPath, [harness], { encoding: "utf8", env, timeout: 60_000 })
		expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 1, stdout: "" })
		expect(run.stderr).toMatch(/Python .* is required here/)
	})
})

describe("the emit adversarial suite against each guard", () => {
	it(
		"passes with every guard in place",
		() => {
			expect(runSuite(undefined)).toBe(0)
		},
		RUN,
	)

	it.each(GUARDS.filter((g) => g.toolchain === undefined).map((g) => g.id))(
		"goes red with the %s guard disabled",
		(id) => {
			expect(runSuite(id)).not.toBe(0)
		},
		RUN,
	)

	describe.skipIf(!withDotnet())("the C# runtime guards", () => {
		it.each(GUARDS.filter((g) => g.toolchain === "csharp").map((g) => g.id))(
			"goes red with the %s guard disabled",
			(id) => {
				expect(runSuite(id)).not.toBe(0)
			},
			RUN,
		)
	})

	describe.skipIf(!withGo())("the Go runtime guards", () => {
		it.each(GUARDS.filter((g) => g.toolchain === "go").map((g) => g.id))(
			"goes red with the %s guard disabled",
			(id) => {
				expect(runSuite(id)).not.toBe(0)
			},
			RUN,
		)
	})

	describe.skipIf(!withRust())("the Rust runtime guards", () => {
		it.each(GUARDS.filter((g) => g.toolchain === "rust").map((g) => g.id))(
			"goes red with the %s guard disabled",
			(id) => {
				expect(runSuite(id)).not.toBe(0)
			},
			RUN,
		)
	})

	describe.skipIf(!withPython())("the Python runtime guards", () => {
		it.each(GUARDS.filter((g) => g.toolchain === "python").map((g) => g.id))(
			"goes red with the %s guard disabled",
			(id) => {
				expect(runSuite(id)).not.toBe(0)
			},
			RUN,
		)
	})
})
