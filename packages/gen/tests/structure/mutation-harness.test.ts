import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../../src/emit/go/__fixtures__/go-env.ts"
import { rustCacheDir, withRust } from "../../src/emit/rust/__fixtures__/rust-env.ts"
import { runtimeFiles } from "../../src/emit/rust/http.ts"
import { runSuite } from "./mutation-harness.ts"
import { GUARDS, guardNamed, skippedFor, verdicts } from "./mutation-harness.guards.ts"

/* the suite reruns whole, its fuzz included, once per guard; a cold Rust cache pays the dependency build (Ff10) */
const RUN = 600_000

const GO_GUARDS = ["go-cross-origin-auth", "go-auth-redaction", "go-path-param-escape"]
const RUST_GUARDS = ["rust-cross-origin-auth", "rust-auth-redaction", "rust-path-param-escape"]

/* the plain HTTP runtime, which every Rust SDK ships and the guards patch */
const PLAIN = { realtime: false, ws: false }

/** The runtime files `id`'s disabled reader writes, by name, for a plain HTTP SDK. */
function disabledRuntime(id: string): Record<string, string> {
	const disable = guardNamed(id)?.disable ?? ((): Record<string, unknown> => ({}))
	return (disable({ runtimeFiles }).runtimeFiles as typeof runtimeFiles)(PLAIN)
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
		const plain = runtimeFiles(PLAIN)
		const changed = RUST_GUARDS.map((id) => {
			const files = disabledRuntime(id)
			return Object.keys(plain).filter((name) => files[name] !== plain[name])
		})
		expect(changed).toEqual([["redirect.rs"], ["exchange.rs"], ["path.rs"]])
	})

	it("skips each toolchain's guards only where that toolchain is absent", () => {
		expect([
			skippedFor(GUARDS, { go: false, rust: false }),
			skippedFor(GUARDS, { go: true, rust: false }),
			skippedFor(GUARDS, { go: true, rust: true }),
		]).toEqual([[...GO_GUARDS, ...RUST_GUARDS], RUST_GUARDS, []])
	})

	it("runs every guard, all 13, where Go and Rust are both present", () => {
		const ids = GUARDS.map((g) => g.id)
		expect(verdicts(GUARDS, skippedFor(GUARDS, { go: true, rust: true }), () => 1)).toEqual({
			killed: ids,
			skipped: [],
			survived: [],
		})
		expect(ids).toHaveLength(13)
	})

	it("counts a skipped guard as neither killed nor survived, and never runs it", () => {
		const ran: string[] = []
		const run = (id: string) => {
			ran.push(id)
			return id === "escape-bypass" ? 0 : 1
		}
		const tsIds = GUARDS.filter((g) => g.toolchain === undefined).map((g) => g.id)
		expect(verdicts(GUARDS, skippedFor(GUARDS, { go: false, rust: false }), run)).toEqual({
			killed: tsIds.filter((id) => id !== "escape-bypass"),
			skipped: [...GO_GUARDS, ...RUST_GUARDS],
			survived: ["escape-bypass"],
		})
		expect(ran).toEqual(tsIds)
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
})
