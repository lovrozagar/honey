/**
 * The conformance grid itself, in the default run (it spawns nothing): its shape, what each target
 * runs, `compareCell`'s rules in both directions, and that the opt-in harness stays opt-in.
 */
import { existsSync } from "node:fs"
import { join, matchesGlob } from "node:path"
import { describe, expect, it } from "vitest"
import config, { HARNESS } from "../../../vitest.config.ts"
import { FEATURES } from "./features.ts"
import {
	type Cell,
	cellsFor,
	compareCell,
	type Expected,
	type Hop,
	type Json,
	type Observed,
	TARGETS,
	type WireHop,
} from "./matrix.ts"

const SHARED_ROWS = [
	"auth",
	"binary-request",
	"binary-response",
	"json-status",
	"overrides",
	"raw-response",
	"reconnect",
	"request-id",
	"response-headers",
	"sse",
	"typed-errors",
	"verbs",
]

const TS_CELLS = [
	"auth/api-key-on-origin",
	"auth/bearer-on-origin",
	"auth/cross-origin-redirect-drops",
	"binary-request/octet-stream",
	"binary-response/bytes",
	"json-status/created-201",
	"json-status/no-content-204",
	"json-status/ok-200",
	"overrides/base-url",
	"overrides/headers",
	"overrides/timeout",
	"raw-response/status-headers-body",
	"reconnect/sse-from-start",
	"reconnect/sse-last-event-id",
	"reconnect/ws-reconnect-token",
	"request-id/explicit",
	"request-id/generated",
	"response-headers/declared-only",
	"sse/typed-events",
	"typed-errors/conflict-409",
	"typed-errors/declared-404",
	"typed-errors/validation-400",
	"verbs/delete",
	"verbs/get",
	"verbs/list-query",
	"verbs/patch",
	"verbs/post",
	"verbs/reference-request",
]

/** Members the emitted SDK instance or a thenable check owns: no operationId segment may shadow them. */
const RESERVED = new Set(["constructor", "dispose", "state", "then", "toString"])

const UUID = "0b7e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d"
/** The expected hop of a one-call cell: GET /v1/items/1 on the primary origin, headers and body unlisted. */
const AT: Hop = { method: "GET", origin: "primary", url: "/v1/items/1" }
const EMPTY = { contentType: null, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 0 }

/** A cell with one GET call per expectation, and the expected hops when given. */
function cell(expected: readonly Expected[], wire?: readonly Hop[]): Cell {
	const call = { operation: "items.get", route: { method: "GET", path: "/v1/items/:id" } }
	const scenario = { calls: expected.map(() => call), expect: expected, feature: "f", id: "s", key: "f/s" }
	return wire ? { ...scenario, wire } : scenario
}

/** A hop the app received: GET /v1/items/1 on the primary origin, with `headers`. */
function hop(headers: Record<string, string>, at: Partial<WireHop> = {}): WireHop {
	return { body: EMPTY, headers, method: "GET", origin: "primary", url: "/v1/items/1", ...at }
}

/** Whether `compareCell` found the cell broken, one flag per observation. */
function reds(target: Cell, runs: readonly (readonly Observed[])[], wire: readonly WireHop[] = []): boolean[] {
	return runs.map((observed) => compareCell(target, observed, wire).length > 0)
}

/** The ts cell keyed `key`. */
const tsCell = (key: string) => cellsFor("ts").find((c) => c.key === key)

/** A row's targets are all eight, or a CLI-only or MCP-only row's own. */
const ownTargets = (targets: readonly string[]) =>
	targets.join() === TARGETS.join() || targets.join() === "cli" || targets.join() === "mcp"

/** The cells `target` should get: each scenario of every row that lists it, keyed feature/scenario. */
const cellsOfRows = (target: (typeof TARGETS)[number]) =>
	FEATURES.filter((f) => f.targets.includes(target)).flatMap((f) =>
		f.scenarios.map((s) => ({ ...s, feature: f.id, key: `${f.id}/${s.id}` })),
	)

/** One data observation. */
const data = (value: Json, status = 200): Observed[] => [{ data: value, kind: "data", status }]

/** One error observation. */
const error = (status: number, errorKey: string | null, body: Json): Observed[] => [
	{ body, errorKey, kind: "error", status },
]

/** One raw-response observation. */
const raw = (headers: Record<string, string>, body = "x", status = 200): Observed[] => [
	{ body, headers, kind: "raw", status },
]

/** One event-stream observation of a single `tick`. */
const tick = (n: number, id = "1"): Observed[] => [{ events: [{ data: { n }, event: "tick", id }], kind: "events" }]

/** Whether a file is in the opt-in harness run. */
/** gen's root, where the harness globs are relative to */
const GEN = join(import.meta.dirname, "../../..")

const inHarness = (file: string) => HARNESS.some((glob) => matchesGlob(file, glob))

/** A target's conformance runner, gen-relative. */
const runner = (target: string) => `tests/integration/conformance/${target}.test.ts`

const OK: Observed[] = [{ data: null, kind: "data", status: 200 }]
const EXPECT_OK: Expected[] = [{ data: null, kind: "data", status: 200 }]

describe("the grid's shape", () => {
	it("lists the eight targets, keys every cell once and gives every feature a scenario", () => {
		const keys = FEATURES.flatMap((f) => f.scenarios.map((s) => `${f.id}/${s.id}`))
		expect([
			TARGETS,
			keys.filter((key, i) => keys.indexOf(key) !== i),
			FEATURES.filter((f) => f.scenarios.length === 0).map((f) => f.id),
		]).toEqual([["ts", "go", "rust", "python", "csharp", "java", "cli", "mcp"], [], []])
	})

	it("targets a shared row at all eight, and a CLI or MCP row at itself alone", () => {
		expect([
			FEATURES.filter((f) => !ownTargets(f.targets)).map((f) => f.id),
			FEATURES.filter((f) => f.targets.length === TARGETS.length)
				.map((f) => f.id)
				.sort(),
		]).toEqual([[], SHARED_ROWS])
	})

	it("gives each scenario one expectation per call", () => {
		const scenarios = FEATURES.flatMap((f) => f.scenarios.map((s) => ({ key: `${f.id}/${s.id}`, s })))
		expect(scenarios.filter(({ s }) => s.expect.length !== s.calls.length).map(({ key }) => key)).toEqual([])
	})

	it("survives a JSON round trip unchanged, so a non-TS runner reads every cell from stdin", () => {
		expect(JSON.parse(JSON.stringify(FEATURES))).toStrictEqual(FEATURES)
	})

	it("names no operation by a member the SDK instance owns", () => {
		const operations = FEATURES.flatMap((f) => f.scenarios.flatMap((s) => s.calls.map((c) => c.operation)))
		expect(operations.filter((op) => op.split(".").some((segment) => RESERVED.has(segment)))).toEqual([])
	})
})

describe("cellsFor", () => {
	it("gives each target exactly the scenarios of the rows that list it", () => {
		expect(TARGETS.map((t) => cellsFor(t))).toEqual(TARGETS.map(cellsOfRows))
	})

	it("holds the TS cells of the shared rows, keyed feature/scenario", () => {
		expect(
			cellsFor("ts")
				.map((c) => c.key)
				.sort(),
		).toEqual(TS_CELLS)
	})

	it("pins the reference request: the encoded param and query on the hop, the decoded id in the data", () => {
		const reference = tsCell("verbs/reference-request")
		expect([
			reference?.calls[0]?.params,
			reference?.wire?.map((h) => [h.origin, h.method, h.url]),
			reference?.expect[0],
		]).toEqual([
			{ id: "a b/ü" },
			[["primary", "PUT", "/v1/items/a%20b%2F%C3%BC?flag=true&limit=3&q=h%C3%A9%26llo&ratio=0.5&tags=x&tags=y+z"]],
			expect.objectContaining({ data: { id: "a b/ü", n: 2, name: "n" }, kind: "data", status: 200 }),
		])
	})

	it("resumes the reference log after Last-Event-ID 2 with events 3, 4 and 5", () => {
		const resume = tsCell("reconnect/sse-last-event-id")
		const events = (resume?.expect[0] as { events?: readonly { id?: string }[] } | undefined)?.events
		expect([
			resume?.calls[0]?.lastEventId,
			resume?.calls[0]?.take,
			events?.map((e) => e.id),
			resume?.wire?.[0]?.headers?.["last-event-id"],
		]).toEqual(["2", 3, ["3", "4", "5"], "2"])
	})
})

describe("compareCell on data", () => {
	it("compares data strictly and writes one line per mismatch naming the call, the hop and the path", () => {
		const target = cell([{ data: { id: "1", name: "a" }, kind: "data", status: 200 }], [AT])
		const moved = [hop({}, { url: "/v1/items/2" })]
		expect(
			reds(
				target,
				[
					data({ id: "1", name: "a" }),
					data({ id: "1", name: "a", x: "1" }),
					data({ id: "1" }),
					data({ id: "1", name: "a" }, 201),
				],
				[hop({})],
			),
		).toEqual([false, true, true, true])
		expect(compareCell(target, data({ id: "2", name: "a" }), moved)).toEqual([
			expect.stringMatching(/call 0\b.*\bid\b/),
			expect.stringMatching(/hop 0\b.*\burl\b/),
		])
	})

	it("lets a matcher stand anywhere: $any present, $uuid a UUID, $absent missing", () => {
		const target = cell([
			{
				data: { items: [{ at: { $uuid: true }, id: { $any: true }, secret: { $absent: true } }] },
				kind: "data",
				status: 200,
			},
		])
		const items = (item: Json) => data({ items: [item] })
		expect(
			reds(target, [
				items({ at: UUID, id: 7 }),
				items({ at: "not-a-uuid", id: 7 }),
				items({ at: UUID }),
				items({ at: UUID, id: 7, secret: "s" }),
			]),
		).toEqual([false, true, true, true])
	})

	it("is red when a call has no result, an extra one, or another kind: the grid is complete or red", () => {
		const target = cell([{ data: null, kind: "data", status: 204 }])
		const ok: Observed = { data: null, kind: "data", status: 204 }
		expect(reds(target, [[ok], [], [ok, ok], [{ kind: "timeout" }], error(204, null, null)])).toEqual([
			false,
			true,
			true,
			true,
			true,
		])
	})
})

describe("compareCell on errors and raw responses", () => {
	it("compares an error on status and key, and its body only by the keys the expectation lists", () => {
		const bare = cell([{ errorKey: "item_not_found", kind: "error", status: 404 }])
		const listed = cell([
			{ body: { fields: { name: { $any: true } } }, errorKey: "invalid_input", kind: "error", status: 400 },
		])
		expect(
			reds(bare, [
				error(404, "item_not_found", { message: "gone" }),
				error(404, "not_found", {}),
				error(410, "item_not_found", {}),
				error(404, null, {}),
			]),
		).toEqual([false, true, true, true])
		expect(
			reds(listed, [
				error(400, "invalid_input", { error_key: "invalid_input", fields: { name: "required" }, message: "m" }),
				error(400, "invalid_input", { fields: {}, message: "m" }),
			]),
		).toEqual([false, true])
	})

	it("compares a raw response's listed headers only, by name in any case, with its status and body", () => {
		const target = cell([{ body: "x", headers: { "X-Item-Version": "3" }, kind: "raw", status: 200 }])
		expect(
			reds(target, [
				raw({ "content-type": "text/plain", "x-item-version": "3", "x-internal": "1" }),
				raw({ "x-item-version": "4" }),
				raw({}),
				raw({ "x-item-version": "3" }, "y"),
				raw({ "x-item-version": "3" }, "x", 201),
			]),
		).toEqual([false, true, true, true, true])
	})
})

describe("compareCell on streams, sockets, bytes and timeouts", () => {
	it("compares events, frames, bytes and a timeout as observed", () => {
		const events = cell([{ events: [{ data: { n: 1 }, event: "tick", id: "1" }], kind: "events" }])
		const frames = cell([{ frames: [{ id: 4 }, { id: 5 }], kind: "frames" }])
		const bytes = cell([{ kind: "bytes", sha256: EMPTY.sha256, size: 0, status: 200 }])
		const timeout = cell([{ kind: "timeout" }])
		expect([
			reds(events, [tick(1), tick(2), tick(1, "2"), [{ events: [], kind: "events" }]]),
			reds(frames, [
				[{ frames: [{ id: 4 }, { id: 5 }], kind: "frames" }],
				[{ frames: [{ id: 5 }, { id: 4 }], kind: "frames" }],
			]),
			reds(bytes, [
				[{ kind: "bytes", sha256: EMPTY.sha256, size: 0, status: 200 }],
				[{ kind: "bytes", sha256: "0", size: 0, status: 200 }],
			]),
			reds(timeout, [[{ kind: "timeout" }], data(null)]),
		]).toEqual([
			[false, true, true, true],
			[false, true],
			[false, true],
			[false, true],
		])
	})
})

describe("compareCell on the wire", () => {
	it("compares a hop's listed headers only, by name in any case, and $absent must not arrive", () => {
		const target = cell(EXPECT_OK, [
			{ ...AT, headers: { Authorization: "Bearer tok", "x-api-key": { $absent: true } } },
		])
		const wire = (headers: Record<string, string>, at: Partial<WireHop> = {}) =>
			compareCell(target, OK, [hop(headers, at)]).length > 0
		expect([
			wire({ authorization: "Bearer tok", "x-request-id": "r" }),
			wire({ authorization: "Bearer tok", "x-api-key": "k" }),
			wire({ authorization: "Bearer other" }),
			wire({}),
			wire({ authorization: "Bearer tok" }, { origin: "alt" }),
			wire({ authorization: "Bearer tok" }, { method: "PUT" }),
			wire({ authorization: "Bearer tok" }, { url: "/v1/items/2" }),
		]).toEqual([false, true, true, true, true, true, true])
	})

	it("compares hops in order and their count, and leaves the wire alone when a cell expects none", () => {
		const first: Hop = { method: "GET", origin: "primary", url: "/v1/redirect/cross-origin" }
		const second: Hop = { method: "GET", origin: "alt", url: "/v1/echo" }
		const a = hop({}, { url: first.url })
		const b = hop({}, { origin: "alt", url: second.url })
		const target = cell(EXPECT_OK, [first, second])
		expect([
			reds(target, [OK], [a, b]),
			reds(target, [OK], [b, a]),
			reds(target, [OK], [a]),
			reds(target, [OK], [a, b, b]),
			reds(cell(EXPECT_OK), [OK], [a, b]),
		]).toEqual([[false], [true], [true], [true], [false]])
	})

	it("compares a hop body only when the hop lists one", () => {
		const sent = { contentType: "application/json", json: { n: 2 }, sha256: "ab", size: 7 }
		expect([
			reds(cell(EXPECT_OK, [AT]), [OK], [hop({}, { body: sent })]),
			reds(
				cell(EXPECT_OK, [{ ...AT, body: { json: { n: 2 } } }]),
				[OK],
				[hop({}, { body: { ...sent, json: { n: 3 } } })],
			),
		]).toEqual([[false], [true]])
	})
})

describe("the opt-in harness", () => {
	it("keeps every runner and harness file out of the default run, and the grid's own test in it", () => {
		expect(typeof config).toBe("function")
		type Resolved = { test: { exclude?: string[]; include?: string[]; projects?: { test: { include: string[] } }[] } }
		const resolve = config as unknown as (env: { command: "serve"; mode: string }) => Resolved
		const harness = resolve({ command: "serve", mode: "harness" }).test
		/* harness mode runs through its toolchain projects (00-rules:118): the union of their includes */
		const union = (harness.projects ?? []).flatMap(({ test }) => test.include)
		const runs = (file: string) => union.some((glob) => matchesGlob(file, glob))
		expect([
			HARNESS.filter((glob) => !resolve({ command: "serve", mode: "test" }).test.exclude?.includes(glob)),
			[harness.include, union.filter((glob) => !inHarness(glob))],
			TARGETS.filter((t) => !inHarness(runner(t))),
			TARGETS.filter((t) => existsSync(join(GEN, runner(t))) !== runs(runner(t))),
			["tests/integration/ts-harness.test.ts", "tests/integration/ts-harness.pipeline.test.ts"].map(runs),
			inHarness("tests/integration/conformance/matrix.test.ts"),
		]).toEqual([[], [undefined, []], [], [], [true, true], false])
	})
})
