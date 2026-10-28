/**
 * The Python gate fixture and test driver (contract 28 §6, Fb8/Fb11/Fb14): a registry package is gated once per
 * content hash and a second gate spawns nothing; programs run against the package as written; mypy runs once per
 * package dir and a consumer check once per program, each on a private copy of a base cache; the floor gates
 * under PY_FLOOR in a dir of its own; the emitter's call plans name what the fixed reflection driver walks; and
 * the driver sends one cell on both clients against the recording server, observing an operation with no typed
 * answer by its raw body.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledPython } from "./__fixtures__/compiled.ts"
import { program } from "./__fixtures__/consumer.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { drivenPythonSdk } from "./__fixtures__/driven.ts"
import { PY_FLOOR, withPython } from "./__fixtures__/python-env.ts"
import type { PythonCallPlan } from "./sdk-plan.ts"
import { pythonCallPlans } from "./sdk.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

/* every spawn counted, so a gate the cache answers is shown to start no process at all */
vi.mock("node:child_process", async (original) => {
	const real = await original<typeof import("node:child_process")>()
	return { ...real, spawn: vi.fn(real.spawn), spawnSync: vi.fn(real.spawnSync) }
})

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
const FLOOR = withPython(PY_FLOOR)

const spawns = () => vi.mocked(spawn).mock.calls.length + vi.mocked(spawnSync).mock.calls.length

const OP = "orgs.members.notes.create"

const CLIENTS = ["async", "sync"] as const

/** The NOTES op's plan, in the emitter's names: two path params in path order, a query and a header param, a JSON body. */
const NOTES: PythonCallPlan = {
	accessors: ["orgs", "members", "notes"],
	body: "json",
	headers: { "X-Trace": "x_trace" },
	idempotencyKey: null,
	method: "create",
	operation: OP,
	pathParams: ["org", "member"],
	query: { tag: "tag" },
	required: [],
	response: "json",
	responseHeaders: null,
	stream: null,
	sync: true,
}

/** A program over the dependency-free `cache` package: its `one()` and the stdin it was given. */
const PROBE =
	"import sys\n\nsys.path.insert(0, sys.argv[1])\nfrom cache_probe import one\n\nprint(one(), sys.stdin.read().strip())\n"

/** Every file under `dir`, relative, sorted. */
const filesUnder = (dir: string) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort()

describe.skipIf(!PY)("the gate cache: one gate per content hash", { timeout: SPAWN_TIMEOUT }, () => {
	it("gates a registry package once: a second gate reads its marker and spawns nothing", () => {
		const first = compiledPython("cache")
		expect({ complete: existsSync(join(first.dir, ".complete")), imported: first.imported }, first.stderr).toEqual({
			complete: true,
			imported: true,
		})
		const before = spawns()
		const second = compiledPython("cache")
		expect({ dir: second.dir, fresh: second.fresh, imported: second.imported, spawned: spawns() - before }).toEqual({
			dir: first.dir,
			fresh: false,
			imported: true,
			spawned: 0,
		})
	})

	it("writes the package exactly as given, beside its markers", () => {
		const sdk = compiledPython("cache")
		const own = filesUnder(sdk.dir).filter((file) => !/^(?:\.complete|\.mypy|checks\/|programs\/)/.test(file))
		expect({ own, package: sdk.package, root: sdk.root }).toEqual({
			own: Object.keys(FIXTURES.cache.files).sort(),
			package: "cache_probe",
			root: join(sdk.dir, "src"),
		})
	})

	it("runs a program with the package root as argv[1] and its input on stdin, however large an unread input", async () => {
		const sdk = compiledPython("cache")
		expect(await sdk.exec(PROBE, "hi\n")).toEqual({ status: 0, stderr: "", stdout: "1 hi\n" })
		/* more than a pipe holds: the program exits before the write ends, which must not surface as EPIPE */
		expect(await sdk.exec("print(3)\n", "x".repeat(4 << 20))).toEqual({ status: 0, stderr: "", stdout: "3\n" })
	})

	it("reports mypy's findings once per package dir, and a consumer check's once per program", () => {
		const sdk = compiledPython("cache")
		const bad = "from cache_probe import one\n\nx: str = one()\n"
		const findings = sdk.check(bad)
		expect({ good: sdk.check("from cache_probe import one\n\nx: int = one()\n"), mypy: sdk.mypy() }).toEqual({
			good: [],
			mypy: [],
		})
		expect(findings.join("\n")).toContain(
			'error: Incompatible types in assignment (expression has type "int", variable has type "str")  [assignment]',
		)
		const before = spawns()
		expect({ again: sdk.check(bad), mypy: sdk.mypy(), spawned: spawns() - before }).toEqual({
			again: findings,
			mypy: [],
			spawned: 0,
		})
	})
})

describe.skipIf(!PY)("the gate options: the floor interpreter and its constraints", () => {
	it.skipIf(!FLOOR)(
		"gates under the floor interpreter in a dir of its own: 3.11.4 lacks itertools.batched",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const floor = compiledPython("canary", { python: "floor" })
			expect({ imported: floor.imported, rejected: floor.stderr.includes("batched") }, floor.stderr).toEqual({
				imported: false,
				rejected: true,
			})
			const cache = compiledPython("cache", { python: "floor" })
			expect(cache.imported, cache.stderr).toBe(true)
			expect(new Set([floor.dir, cache.dir, compiledPython("canary").dir, compiledPython("cache").dir]).size).toBe(4)
		},
	)
})

describe("program: a consumer body indented into main", () => {
	it("indents every line of the body, imports the package as sdk, and keeps an empty body valid", () => {
		const text = program("acme_sdk", "calls", 'section("a")\nnote(1)\n\nnote(2)')
		expect(text).toContain("import acme_sdk as sdk\n")
		expect(text).toContain('async def main() -> None:\n    section("a")\n    note(1)\n\n    note(2)\n')
		expect(program("acme_sdk", "empty", "")).toContain("async def main() -> None:\n    pass\n")
	})
})

describe("pythonCallPlans: each operation's call plan, in the emitter's own names", () => {
	it("names the accessors, the method, the path params in signature order and every keyword", () => {
		expect(pythonCallPlans(FIXTURES.surface.document(), FIXTURES.surface.options)[OP]).toEqual(NOTES)
	})
})

/** The create call the smoke sends: path params needing escapes, a query, the header param, a JSON body. */
const CREATE: Call = {
	body: { kind: "json", value: { tags: ["a"], text: "hi" } },
	headers: { "x-trace": "t-1" },
	operation: OP,
	params: { member: "m?1", org: "a/b c" },
	route: { method: "POST", path: "/orgs/{org}/members/{member}/notes" },
	search: { tag: "x&y z" },
}

describe.skipIf(!PY)("the Python test driver, against the recording server", () => {
	it("sends a nested POST by its call plan on both clients, which observe the same", async () => {
		const sdk = drivenPythonSdk("surface")
		expect(sdk.imported, sdk.stderr).toBe(true)
		const setup = { auth: { kind: "bearer", token: "tok" } } as const
		const reply = { json: { id: "n1", text: "hi" }, status: 200 } as const
		const [runs, hops] = await served([reply, reply], async (server) => {
			/* the surface's own server has a base path: the hop shows it kept */
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
		expect(runs[0]?.observed).toEqual(runs[1]?.observed)
		const hop = {
			body: { contentType: "application/json", json: { tags: ["a"], text: "hi" } },
			headers: { authorization: "Bearer tok", "x-trace": "t-1" },
			method: "POST",
			url: "/v1/orgs/a%2Fb%20c/members/m%3F1/notes?tag=x%26y+z",
		}
		expect(hops).toMatchObject([hop, hop])
	}, 120_000)
})

/** `orders.close`: a 204 with no typed answer (its plan's `response: "none"`), the SDK's return `None`. */
const CLOSE: Call = { operation: "orders.close", route: { method: "POST", path: "/a" } }

/** What a 2xx answer to an untyped operation carries: JSON, nothing, then text. */
const UNTYPED: readonly Reply[] = [
	{ json: { a: 1 }, status: 200 },
	{ status: 204 },
	{ headers: { "content-type": "text/plain" }, status: 200, text: "t" },
]

describe.skipIf(!PY)("the Python test driver: an answer the SDK does not type", () => {
	/* the grid's raw box (TS, Go and Rust read it so): JSON, else text, else null, whatever the SDK returns */
	it.each(CLIENTS)(
		"%s: observes the raw body as JSON, as null when empty, else as text",
		async (client) => {
			const sdk = drivenPythonSdk("errors")
			expect(sdk.imported, sdk.stderr).toBe(true)
			const [run, hops] = await served(UNTYPED, async (server) => {
				const cell = { calls: [CLOSE, CLOSE, CLOSE], setup: {} }
				return [await sdk.runCalls(cell, { url: server.url }, { client }), server.hops] as const
			})
			expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
				observed: [
					{ data: { a: 1 }, kind: "data", status: 200 },
					{ data: null, kind: "data", status: 204 },
					{ data: "t", kind: "data", status: 200 },
				] satisfies Observed[],
				status: 0,
			})
			expect(hops.map((hop) => `${hop.method} ${hop.url}`)).toEqual(["POST /a", "POST /a", "POST /a"])
		},
		120_000,
	)
})
