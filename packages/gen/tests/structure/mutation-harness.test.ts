import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../../src/emit/go/__fixtures__/go-env.ts"
import { GUARDS, guardNamed, runSuite, skippedFor, verdicts } from "./mutation-harness.ts"

/* the suite reruns whole, its fuzz included, once per guard */
const RUN = 180_000

const GO_GUARDS = ["go-cross-origin-auth", "go-auth-redaction", "go-path-param-escape"]

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

	it("holds the three Go runtime guards, each needing Go and patching the Go runtime reader", () => {
		expect(GO_GUARDS.map((id) => guardNamed(id))).toEqual(
			GO_GUARDS.map((id) =>
				expect.objectContaining({ id, module: "packages/gen/src/emit/go/http.ts", toolchain: "go" }),
			),
		)
	})

	it("skips the Go guards only where Go is absent", () => {
		expect([skippedFor(GUARDS, false), skippedFor(GUARDS, true)]).toEqual([GO_GUARDS, []])
	})

	it("counts a skipped guard as neither killed nor survived, and never runs it", () => {
		const ran: string[] = []
		const run = (id: string) => {
			ran.push(id)
			return id === "escape-bypass" ? 0 : 1
		}
		const tsIds = GUARDS.filter((g) => g.toolchain === undefined).map((g) => g.id)
		expect(verdicts(GUARDS, skippedFor(GUARDS, false), run)).toEqual({
			killed: tsIds.filter((id) => id !== "escape-bypass"),
			skipped: GO_GUARDS,
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
})
