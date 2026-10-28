import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../gen/src/gen/__fixtures__/spawn-timeout.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"
import { MESSAGES, rule } from "./spawn-timeout.js"

const FILE = "packages/core/src/build/x.test.ts"
const SHARED_IMPORT = 'import { SPAWN_TIMEOUT } from "../../../gen/src/gen/__fixtures__/spawn-timeout.ts"\n'
const VITEST = 'import { afterAll, beforeAll, describe, expect, it, test, vi } from "vitest"\n'
const CHILD = 'import { spawnSync } from "node:child_process"\n'
const SPAWNS = '() => { expect(spawnSync("git", ["status"]).status).toBe(0) }'

/** The rule's messages for one test file at `path` holding `code`. */
const messages = (code: string, path = FILE) => reportsOf(rule, { [path]: code }).map((r) => r.message)

describe("honey/spawn-timeout: a test that spawns", () => {
	it("is refused without a timeout, with the shared constant named as the fix", () => {
		expect(messages(`${VITEST}${CHILD}it("spawns", ${SPAWNS})\n`)).toEqual([MESSAGES.test])
		expect(MESSAGES.test).toContain("SPAWN_TIMEOUT (packages/gen/src/gen/__fixtures__/spawn-timeout.ts)")
	})

	it("passes a timeout of its own: trailing, as options, or as a named options object", () => {
		const own = [
			`it("a", ${SPAWNS}, 60_000)`,
			`it("b", { timeout: SPAWN_TIMEOUT }, ${SPAWNS})`,
			`it("c", ${SPAWNS}, { timeout: 60_000 })`,
			`const SLOW = { timeout: 600_000 }\nit("d", SLOW, ${SPAWNS})`,
			`it.each([1, 2])("e %s", { timeout: SPAWN_TIMEOUT }, ${SPAWNS})`,
			`it.skipIf(false)("f", ${SPAWNS}, SPAWN_TIMEOUT)`,
		]
		expect(messages(`${VITEST}${CHILD}${SHARED_IMPORT}${own.join("\n")}\n`)).toEqual([])
	})

	it("is found through it.each, it.skipIf, test, and a callback passed by name", () => {
		const chains = [
			`it.each([1])("a %s", ${SPAWNS})`,
			`it.skipIf(false)("b", ${SPAWNS})`,
			`test("c", ${SPAWNS})`,
			`const run = ${SPAWNS}\nit("d", run)`,
		]
		expect(messages(`${VITEST}${CHILD}${chains.join("\n")}\n`)).toEqual(Array(4).fill(MESSAGES.test))
	})

	it("is found through Bun.spawn, a child_process namespace, a file-local function and a listed helper", () => {
		const helper = 'import { run } from "../../tests/build/fixture/packed.ts"\n'
		const ways = [
			'it("a", () => { Bun.spawnSync(["git"]) })',
			'it("b", () => { cp.execFileSync("git") })',
			'const local = () => spawnSync("git")\nfunction twice() { local() }\nit("c", () => { twice() })',
			'it("d", () => { run("git", [], ".") })',
		]
		const code = `${VITEST}${CHILD}import * as cp from "node:child_process"\n${helper}${ways.join("\n")}\n`
		expect(messages(code)).toEqual(Array(4).fill(MESSAGES.test))
	})

	it("is not one when nothing it reaches spawns: a plain leg, honey()'s held hooks, a function kept in an object", () => {
		const quiet = [
			'it("a", () => { expect(1).toBe(1) })',
			'it("b", () => { expect(honey({ app: "x" })).toHaveLength(1) })',
			'it("c", () => { const hooks = { start() { spawnSync("git") } }; expect(hooks).toBeDefined() })',
		]
		const code = `${VITEST}${CHILD}import { honey } from "../../src/build/plugin.ts"\n${quiet.join("\n")}\n`
		expect(messages(code, "packages/core/tests/build/x.test.ts")).toEqual([])
	})
})

describe("honey/spawn-timeout: an inherited bound", () => {
	it("covers a test under a describe whose timeout is SPAWN_TIMEOUT", () => {
		const code = `${VITEST}${CHILD}${SHARED_IMPORT}describe("d", { timeout: SPAWN_TIMEOUT }, () => {\n\tit("a", ${SPAWNS})\n})\n`
		expect(messages(code)).toEqual([])
	})

	it("covers a test inside a file-local describe wrapper that gives a timeout", () => {
		const wrapper =
			"const CARGO = 600_000\nconst rustDescribe = (name, legs) => describe(name, { timeout: CARGO }, legs)\n"
		expect(messages(`${VITEST}${CHILD}${wrapper}rustDescribe("r", () => {\n\tit("a", ${SPAWNS})\n})\n`)).toEqual([])
	})

	it("refuses a describe whose timeout is a bare number, and lets its tests inherit it", () => {
		const bare = `describe("d", { timeout: 300_000 }, () => {\n\tit("a", ${SPAWNS})\n})\n`
		const named = `const PYTHON = 300_000\ndescribe("e", { timeout: PYTHON }, () => {\n\tit("b", ${SPAWNS})\n})\n`
		expect(messages(`${VITEST}${CHILD}${bare}${named}`)).toEqual([MESSAGES.suite])
	})

	it("refuses a file-scope vi.setConfig whose timeout is a bare number", () => {
		const code = `${VITEST}${CHILD}vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 })\nit("a", ${SPAWNS})\n`
		expect(messages(code)).toEqual([MESSAGES.config("hookTimeout"), MESSAGES.config("testTimeout")])
	})

	it("covers tests and hooks from a file-scope vi.setConfig of SPAWN_TIMEOUT", () => {
		const config = "vi.setConfig({ hookTimeout: SPAWN_TIMEOUT, testTimeout: SPAWN_TIMEOUT })\n"
		expect(messages(`${VITEST}${CHILD}${SHARED_IMPORT}${config}beforeAll(${SPAWNS})\nit("a", ${SPAWNS})\n`)).toEqual([])
	})
})

describe("honey/spawn-timeout: a hook that spawns", () => {
	it("is refused without a timeout of its own", () => {
		const code = `${VITEST}${CHILD}beforeAll(${SPAWNS})\nafterAll(${SPAWNS})\n`
		expect(messages(code)).toEqual([MESSAGES.hook, MESSAGES.hook])
	})

	it("passes with its own timeout", () => {
		expect(messages(`${VITEST}${CHILD}${SHARED_IMPORT}beforeAll(${SPAWNS}, SPAWN_TIMEOUT)\n`)).toEqual([])
	})

	it("is not covered by its describe's timeout, which bounds tests only", () => {
		const code = `${VITEST}${CHILD}${SHARED_IMPORT}describe("d", { timeout: SPAWN_TIMEOUT }, () => {\n\tbeforeAll(${SPAWNS})\n})\n`
		expect(messages(code)).toEqual([MESSAGES.hook])
	})
})

describe("honey/spawn-timeout: scope", () => {
	it("is vitest's API only: a local suite() or it() helper is no test", () => {
		const code = `${CHILD}const it = (name, fn) => fn()\nit("a", ${SPAWNS})\n`
		expect(messages(code)).toEqual([])
	})

	it("reads core's and gen's test files, not core's e2e (bun test, Playwright) nor a non-test module", () => {
		const code = `${VITEST}${CHILD}it("a", ${SPAWNS})\n`
		const files = {
			"packages/core/src/a.test.ts": code,
			"packages/core/src/b.ts": code,
			"packages/core/tests/e2e/apps/x/c.test.ts": code,
			"packages/gen/tests/d.test.ts": code,
		}
		expect(reportsOf(rule, files).map((r) => r.file)).toEqual([
			"packages/core/src/a.test.ts",
			"packages/gen/tests/d.test.ts",
		])
	})

	it("fails oxlint through the honey plugin entry", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = { [FILE]: `${VITEST}${CHILD}it("spawns", ${SPAWNS})\n`, "packages/core/src/y.test.ts": VITEST }
		expect(oxlintReports("spawn-timeout", fixture)).toEqual([{ file: FILE, message: MESSAGES.test }])
	})
})
