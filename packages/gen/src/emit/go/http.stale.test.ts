import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, type HookTrace, type Script } from "./__fixtures__/compiled.ts"
import { check } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { served } from "./__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

type Json = Record<string, unknown>
type Invalidation = NonNullable<NonNullable<Script["config"]>["invalidation"]>

const STRING = { type: "string" }
const OK = {
	200: {
		content: { "application/json": { schema: { properties: { id: STRING }, type: "object" } } },
		description: "ok",
	},
}
const ID = { in: "path", name: "id", required: true, schema: STRING }
const read = (operationId: string, parameters: Json[] = []) => ({ operationId, parameters, responses: OK })
const mutation = (operationId: string, invalidate: string[], extra: Json = {}) => ({
	operationId,
	responses: OK,
	"x-invalidate": invalidate,
	...extra,
})
const USERS = ["GET /users", "GET /users/{id}"]

/** Users with a create and a delete that stale the list and every user, and a touch that stales /a, /b and /c. */
const STALE: Json = {
	info: { title: "Stale", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/a": { get: read("pages.a") },
		"/b": { get: read("pages.b") },
		"/c": { get: read("pages.c") },
		"/touch": { post: mutation("pages.touch", ["GET /a", "GET /b", "GET /c"]) },
		"/users": {
			get: read("users.list"),
			post: mutation("users.create", USERS, {
				requestBody: {
					content: { "application/json": { schema: { properties: { name: STRING }, type: "object" } } },
					required: true,
				},
			}),
		},
		"/users/{id}": { delete: mutation("users.delete", USERS, { parameters: [ID] }), get: read("users.get", [ID]) },
	},
}
const MODULE = "example.com/stale"

const call = (operation: string, method: string, path: string, extra: Partial<Call> = {}): Call => ({
	operation,
	route: { method, path },
	...extra,
})
const CREATE = call("users.create", "POST", "/users", { body: { kind: "json", value: { name: "n" } } })
const LIST = call("users.list", "GET", "/users")
const GET = call("users.get", "GET", "/users/{id}", { params: { id: "1" } })
const DELETE = call("users.delete", "DELETE", "/users/{id}", { params: { id: "1" } })
const TOUCH = call("pages.touch", "POST", "/touch")
const [A, B, C] = ["a", "b", "c"].map((page) => call(`pages.${page}`, "GET", `/${page}`)) as [Call, Call, Call]

let memo: DrivenSdk | undefined
/** The SDK for STALE compiled with the driver, once: it must build and vet clean. */
function staleSdk(): DrivenSdk {
	memo ??= compiledSdk(STALE, { modulePath: MODULE })
	expect({ built: memo.built, vet: memo.vet }, memo.stderr).toEqual({ built: true, vet: [] })
	return memo
}

/**
 * `calls` (each answered 200 `{}`) on one client with `invalidation` (none when absent), each delayed
 * by its `sleepMs`; every call must succeed. What each call's OnRequest hook saw.
 */
async function requests(calls: readonly Call[], invalidation?: Invalidation, sleepMs: (number | undefined)[] = []) {
	const script: Script = {
		...(invalidation === undefined ? {} : { config: { invalidation } }),
		calls: sleepMs.map((ms) => (ms === undefined ? null : { sleepMs: ms })),
	}
	const run = await served([], (server) => staleSdk().runCalls({ calls, setup: {} }, server, script))
	expect({ kinds: run.observed?.map((o) => (o as Json | null)?.kind), status: run.status }, run.stderr).toEqual({
		kinds: calls.map(() => "data"),
		status: 0,
	})
	return (run.trace?.hooks ?? []).filter((h) => h.phase === "request")
}

/** A request hook entry as `[selector, isStale, invalidatedBy]`. */
const seen = (h: HookTrace) => [h.selector, h.isStale, h.invalidatedBy]
const staleness = (hooks: readonly HookTrace[]) => hooks.map((h) => h.isStale)
/** What the reads after the first two calls were invalidated by. */
const by = (hooks: readonly HookTrace[]) => hooks.slice(2).map((h) => h.invalidatedBy)

describe("stale tracking: a successful mutation stales its x-invalidate targets for the next read", () => {
	// v0: 5cbc1880a7
	it("shows each target's read as stale, invalidated by the mutation's concrete selector", async () => {
		if (!withGo()) return
		const hooks = await requests([CREATE, LIST, GET], { staleTimeMs: 60_000 })
		expect(hooks.map(seen)).toEqual([
			["POST /users", false, []],
			["GET /users", true, ["POST /users"]],
			["GET /users/1", true, ["POST /users"]],
		])
	}, 600_000)

	// v0: b1382c5259
	it("stales every instance of a target its params cannot fill, and clears one once a read through it succeeds", async () => {
		if (!withGo()) return
		const hooks = await requests([CREATE, GET, GET], { staleTimeMs: 60_000 })
		expect(staleness(hooks)).toEqual([false, true, false])
	}, 600_000)

	// v0: 48f0de3009
	it("stops reading stale once staleTimeMs has passed since the last mark", async () => {
		if (!withGo()) return
		/* the sleep is a lower bound, so 1100 ms always outlasts the 1000 ms window; the read right
		 * after the first create has the whole window as its margin */
		const hooks = await requests([CREATE, GET, CREATE, GET], { staleTimeMs: 1000 }, [
			undefined,
			undefined,
			undefined,
			1100,
		])
		expect(staleness(hooks)).toEqual([false, true, false, false])
	}, 600_000)
})

describe("stale tracking: off without invalidation or with staleTimeMs 0", () => {
	/* V0BUG: v0's name says the tracker is nil when StaleTime is 0; it never was (a disabled non-nil
	 * tracker). The port pins the observable: no selector, nothing stale. */
	// v0: 7298c85a98
	it("reports no selector and nothing stale to the hooks after a mutation", async () => {
		if (!withGo()) return
		const [none, zero] = await Promise.all([requests([CREATE, LIST]), requests([CREATE, LIST], { staleTimeMs: 0 })])
		const off = [
			["", false, []],
			["", false, []],
		]
		expect({ none: none.map(seen), zero: zero.map(seen) }).toEqual({ none: off, zero: off })
	}, 600_000)
})

describe("stale tracking: bounded by InvalidationConfig, never by Config", () => {
	/* G1: v0's test passed on the dead Config.StaleMaxEntries; the live bound is
	 * InvalidationConfig.StaleMaxEntries, which the driver sets from `staleMaxEntries` */
	// v0: f92c465b60
	it("evicts the least recently staled down to half of staleMaxEntries once a mark passes it", async () => {
		if (!withGo()) return
		const reads = [TOUCH, A, B, C]
		const [capped, open] = await Promise.all([
			requests(reads, { staleMaxEntries: 2, staleTimeMs: 60_000 }),
			requests(reads, { staleTimeMs: 60_000 }),
		])
		expect({ capped: staleness(capped), open: staleness(open) }).toEqual({
			capped: [false, false, false, true],
			open: [false, true, true, true],
		})
	}, 600_000)

	// v0: f92c465b60
	it("has no Config.StaleMaxEntries: a client setting it does not compile", () => {
		if (!withGo()) return
		const ran = check(
			generateGoSdk(STALE, { modulePath: MODULE }).files,
			MODULE,
			"\t_ = sdk.Config{StaleMaxEntries: 1}\n",
		)
		expect({ built: ran.built, stderr: ran.stderr }).toEqual({
			built: false,
			stderr: expect.stringMatching(/unknown field StaleMaxEntries in struct literal of type sdk\.Config/),
		})
	}, 600_000)

	it("keeps at most maxSourcesPerTarget mutations per stale selector; a templated target takes the mutation's params", async () => {
		if (!withGo()) return
		const reads = [CREATE, DELETE, LIST, GET]
		const [capped, open] = await Promise.all([
			requests(reads, { maxSourcesPerTarget: 1, staleTimeMs: 60_000 }),
			requests(reads, { staleTimeMs: 60_000 }),
		])
		expect({ capped: by(capped), open: by(open) }).toEqual({
			capped: [["POST /users"], ["DELETE /users/1", "POST /users"]],
			open: [
				["POST /users", "DELETE /users/1"],
				["DELETE /users/1", "POST /users"],
			],
		})
	}, 600_000)
})
