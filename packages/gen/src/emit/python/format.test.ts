/**
 * The emitted Python package through the ruff post-pass and Fb9's rule list, byte-compiled and imported under the
 * pinned interpreter and under PY_FLOOR at the dependency floors (G10.2, Fb11), and mypy under Fb10's flags
 * (contract 28 §7.4). Every package here is a registry entry (`FIXTURES`, Fb14): `fixtures` is v0's Python specs
 * and the realtime ones merged into one document, `fixtures-safe` the same in safe mode. That the floor and mypy
 * legs can fail at all is the canary's to prove: 3.11 has no `itertools.batched`.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { formatFiles } from "../shared/format.ts"
import { compiledPython } from "./__fixtures__/compiled.ts"
import { checked } from "./__fixtures__/consumer.ts"
import { FIXTURES, type PythonFixture } from "./__fixtures__/documents.ts"
import { drivenPythonSdk } from "./__fixtures__/driven.ts"
import { PY_FLOOR, runRuff, withPython } from "./__fixtures__/python-env.ts"
import { CLEAN, formatted, pythonNames, ruffGate, ruffGates, written } from "./__fixtures__/ruff-gate.ts"
import { allOrder, isortMembers } from "./sdk-imports.ts"
import { generatePythonSdk } from "./sdk.ts"
import { runtimeFiles } from "./transport.ts"

/** Whether Python is here: a missing toolchain fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
const FLOOR = withPython(PY_FLOOR)

/** Both throw modes of the merged fixtures. */
const MODES = ["fixtures", "fixtures-safe"] as const
type Mode = (typeof MODES)[number]

/** `key`'s package, as emitted. */
function emitted(key: Mode): Readonly<Record<string, string>> {
	const fixture: PythonFixture = FIXTURES[key]
	if (!("document" in fixture)) throw new Error(`${key} is not a document fixture`)
	return generatePythonSdk(fixture.document(), fixture.options).files
}

describe("the emitted Python package through the ruff pass", () => {
	it("goes out as emitted without a ruff", async () => {
		const files = emitted("fixtures")
		expect(await formatFiles(files, {})).toEqual(files)
	})

	// v0: 97a65d64db
	it.skipIf(!PY)(
		"leaves ruff format --check and the Fb9 rule list nothing to report after the pass, both modes, zero noqa",
		async () => {
			/* V0BUG: v0 pushed a blanket `# ruff: noqa: E501` into client.py and types.py (codegen-python.ts:222,835) */
			const results = await Promise.all(
				MODES.map(async (key) => {
					const files = emitted(key)
					const expected = { ...CLEAN, reached: pythonNames(files), suppressed: [] }
					return { actual: await ruffGate(files), expected, key }
				}),
			)
			expect(results.every(({ expected }) => expected.reached.length > 0)).toBe(true)
			expect(Object.fromEntries(results.map(({ actual, key }) => [key, actual]))).toEqual(
				Object.fromEntries(results.map(({ expected, key }) => [key, expected])),
			)
		},
		300_000,
	)

	it.skipIf(!PY)("ships a runtime the ruff pass leaves as it is, clean under the same rule list", async () => {
		const runtime: Readonly<Record<string, string>> = runtimeFiles({ realtime: true, ws: true })
		const pass = await formatted(runtime)
		expect({ reached: pass.seen, unchanged: pass.files }).toEqual({ reached: pythonNames(runtime), unchanged: runtime })
		expect(pass.seen.length).toBeGreaterThan(0)
		const dir = written(
			"runtime",
			Object.fromEntries(Object.entries(runtime).map(([name, text]) => [join("_honey", name), text])),
		)
		expect(ruffGates(dir)).toEqual(CLEAN)
	})

	it.skipIf(!PY)("keeps the test driver formatted and clean under the same rule list", () => {
		const driver = join(import.meta.dirname, "__fixtures__", "driver")
		const files = Object.fromEntries(
			readdirSync(driver)
				.filter((name) => name.endsWith(".py"))
				.map((name) => [name, readFileSync(join(driver, name), "utf8")]),
		)
		expect(Object.keys(files).length).toBeGreaterThan(0)
		expect(ruffGates(written("driver", files))).toEqual(CLEAN)
	})
})

/* every member name class ruff orders differently: constants, classes, the rest; `_` against a letter; digits;
 * a one-letter capital, which ruff counts a class (a constant has two or more characters) */
const NAMES = [
	"Zebra",
	"SDK",
	"AsyncSDK",
	"aio",
	"Item10",
	"Item2",
	"HTTPError",
	"_private",
	"CONST_X",
	"TypeAlias",
	"Any",
	"item",
	"Ab",
	"aB",
	"AB",
	"A_B",
	"ZZ",
	"Z9",
	"A",
	"I",
]

describe("the import and __all__ orders, against the pinned ruff", () => {
	it.skipIf(!PY)("orders import members as I001 and __all__ as RUF022 rewrite them", () => {
		const source = `from x import (${NAMES.join(", ")})\n\n__all__ = [${NAMES.map((name) => `"${name}"`).join(", ")}]\n`
		const fixed = runRuff(
			[
				"check",
				"--isolated",
				"--target-version",
				"py311",
				"--select",
				"I,RUF022",
				"--fix",
				"--stdin-filename",
				"order.py",
				"-",
			],
			{ input: source },
		)
		expect(fixed.status, fixed.stderr).toBe(0)
		const block = /from x import \(([^)]*)\)/.exec(fixed.stdout)?.[1] ?? ""
		const all = /^__all__ = \[(.*)\]$/m.exec(fixed.stdout)?.[1] ?? ""
		const ruff = {
			all: [...all.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
			imports: block
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean),
		}
		/* the fixture bites: the two orders differ, and only on `_` against a letter */
		expect(ruff.imports.slice(0, 2)).toEqual(["A_B", "AB"])
		expect(ruff.all.slice(0, 2)).toEqual(["AB", "A_B"])
		/* and a one-letter capital opens the classes, right after the last constant */
		for (const order of [ruff.imports, ruff.all]) expect(order.indexOf("A")).toBe(order.indexOf("ZZ") + 1)
		expect({ all: allOrder(NAMES), imports: isortMembers(NAMES) }).toEqual(ruff)
	})
})

describe("the emitted Python package under the pinned interpreter and PY_FLOOR", () => {
	// v0: 9932087b67
	it.skipIf(!PY || !FLOOR)(
		"byte-compiles and imports under the pin and under PY_FLOOR at the dependency floors",
		() => {
			/* V0BUG: v0 declared no floor: no requires-python, and its surface failed to import on 3.10 (survey 14) */
			const pin = compiledPython("fixtures")
			const floor = compiledPython("fixtures", { python: "floor" })
			const canary = compiledPython("canary", { python: "floor" })
			expect({
				canary: { imported: canary.imported, rejected: canary.stderr.includes("batched") },
				floor: floor.imported || floor.stderr,
				pin: pin.imported || pin.stderr,
			}).toEqual({ canary: { imported: false, rejected: true }, floor: true, pin: true })
		},
		300_000,
	)
})

describe.skipIf(!PY)("the emitted Python package under mypy", () => {
	// v0: 3105a53d79
	it("is clean under mypy --strict at 3.11 with Fb10's codes on every gated SDK, both modes", () => {
		const keys = ["fixtures", "fixtures-safe", "types", "surface"] as const
		const findings = Object.fromEntries(
			keys.map((key) => {
				const sdk = compiledPython(key)
				return [key, sdk.imported ? sdk.mypy() : [sdk.stderr]]
			}),
		)
		expect(findings).toEqual({ fixtures: [], "fixtures-safe": [], surface: [], types: [] })
		/* the leg can fail: --python-version 3.11 rejects a 3.12 stdlib name the pinned interpreter has */
		expect(compiledPython("canary").mypy().join("\n")).toContain('Module "itertools" has no attribute "batched"')
	}, 300_000)

	// v0: bd0bef251f
	it("types an array alias precisely: mypy rejects x: Tags = [1] and takes a list of str", () => {
		expect(checked("types", 'from honey_sdk import Tags\n\nx: Tags = ["a"]\n')).toEqual([])
		expect(checked("types", "from honey_sdk import Tags\n\nx: Tags = [1]\n").join("\n")).toContain(
			'List item 0 has incompatible type "int"; expected "str"',
		)
	}, 300_000)
})

/** The create call the smoke sends (sdk.driver.test.ts's): path params needing escapes, a query, the header param, a JSON body. */
const CREATE: Call = {
	body: { kind: "json", value: { tags: ["a"], text: "hi" } },
	headers: { "x-trace": "t-1" },
	operation: "orgs.members.notes.create",
	params: { member: "m?1", org: "a/b c" },
	route: { method: "POST", path: "/orgs/{org}/members/{member}/notes" },
	search: { tag: "x&y z" },
}

describe.skipIf(!PY || !FLOOR)("the light floor: the driver smoke under PY_FLOOR and httpx2 at its floor", () => {
	it("sends the nested POST on both clients, which observe what they do under the pins", async () => {
		const sdk = drivenPythonSdk("surface", { python: "floor" })
		expect(sdk.imported, sdk.stderr).toBe(true)
		const setup = { auth: { kind: "bearer", token: "tok" } } as const
		const reply = { json: { id: "n1", text: "hi" }, status: 200 } as const
		const [runs, hops] = await served([reply, reply], async (server) => {
			const origins = { url: `${server.url}/v1` }
			const cell = { calls: [CREATE], setup }
			const both = [
				await sdk.runCalls(cell, origins, { client: "async" }),
				await sdk.runCalls(cell, origins, { client: "sync" }),
			]
			return [both, server.hops] as const
		})
		const expected = { observed: [{ data: { id: "n1", text: "hi" }, kind: "data", status: 200 }] satisfies Observed[] }
		for (const run of runs)
			expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({ ...expected, status: 0 })
		const hop = {
			body: { contentType: "application/json", json: { tags: ["a"], text: "hi" } },
			headers: { authorization: "Bearer tok", "x-trace": "t-1" },
			method: "POST",
			url: "/v1/orgs/a%2Fb%20c/members/m%3F1/notes?tag=x%26y+z",
		}
		expect(hops).toMatchObject([hop, hop])
	}, 300_000)
})
