/**
 * Stale tracking (contract 29 §5.6, Rust's `http.stale.test.ts` analog): a 2xx mutation stales its
 * `x-invalidate` targets for the next read, which a read through them clears; off without invalidation or with
 * a zero stale time; a mark lapsing after the stale window (the monotonic clock); and bounded by
 * `InvalidationConfig`: `stale_max_entries` evicts the least recently staled, `max_sources_per_target` caps what a
 * selector was invalidated by. Driven against `http` (documents-http.ts), whose `users.create`/`users.delete`
 * stale `GET /users` and `GET /users/{id}`, and `pages.touch` `/a`, `/b`, `/c`, every driver leg on `AsyncSDK` and
 * `SDK` with one expectation (G17). A consumer program on `fixtures` drives the one tracker both clients share
 * (`_honey.stale.StaleTracker`) directly: a pattern key, its clear, and a lookup's cost against the entry count.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, once } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

type Invalidation = NonNullable<NonNullable<Script["config"]>["invalidation"]>

const call = (operation: string, method: string, path: string, extra: Partial<Call> = {}): Call => ({
	operation,
	route: { method, path },
	...extra,
})
const CREATE = call("users.create", "POST", "/users", { body: { kind: "json", value: { name: "n" } } })
const LIST = call("users.list", "GET", "/users")
const GET = call("users.get", "GET", "/users/{id}", { params: { id: "1" } })
const DELETE = call("users.delete", "DELETE", "/users/{id}", { params: { id: "1" } })
const ORDER = call("orders.create", "POST", "/orders", { body: { kind: "json", value: { sku: "s" } } })
const TOUCH = call("pages.touch", "POST", "/touch")
const [A, B, C] = ["a", "b", "c"].map((page) => call(`pages.${page}`, "GET", `/${page}`)) as [Call, Call, Call]

/** The `http` SDK with the driver aimed at it: it must import. */
function staleSdk(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("http")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** How a run goes: each call's wait before it, and the server's replies (200 `{}` past them). */
type Options = { readonly replies?: readonly Reply[]; readonly sleepMs?: readonly (number | undefined)[] }

/**
 * `calls` on `client` with `invalidation` (none when absent), each delayed by its `sleepMs`: each call's observed
 * kind, what each call's request hook saw, the exit status and stderr.
 */
async function traced(client: Client, calls: readonly Call[], invalidation?: Invalidation, options: Options = {}) {
	const script: Script = {
		...(invalidation === undefined ? {} : { config: { invalidation } }),
		calls: (options.sleepMs ?? []).map((ms) => (ms === undefined ? null : { sleepMs: ms })),
	}
	const sdk = staleSdk()
	const run = await served(options.replies ?? [], (server) =>
		sdk.runCalls({ calls, setup: {} }, { url: server.url }, { client, script }),
	)
	return {
		hooks: (run.trace?.hooks ?? []).filter((h) => h.phase === "request"),
		kinds: run.observed?.map((o) => (o as { kind?: string } | null)?.kind),
		status: run.status,
		stderr: run.stderr,
	}
}

/** `traced` where every call must succeed: what each call's request hook saw. */
async function requests(client: Client, calls: readonly Call[], invalidation?: Invalidation, options: Options = {}) {
	const { hooks, kinds, status, stderr } = await traced(client, calls, invalidation, options)
	expect({ kinds, status }, stderr).toEqual({ kinds: calls.map(() => "data"), status: 0 })
	return hooks
}

/** A request hook entry as `[selector, isStale, invalidatedBy]`. */
const seen = (h: HookTrace) => [h.selector, h.isStale, h.invalidatedBy]
const staleness = (hooks: readonly HookTrace[]) => hooks.map((h) => h.isStale)
/** What the reads after the first two calls were invalidated by. */
const by = (hooks: readonly HookTrace[]) => hooks.slice(2).map((h) => h.invalidatedBy)

const OPEN: Invalidation = { staleTimeMs: 60_000 }

describe.skipIf(!PY)("stale tracking: a 2xx mutation stales its x-invalidate targets for the next read", SLOW, () => {
	it.each(CLIENTS)("%s: shows each target's read as stale, invalidated by the mutation's selector", async (client) => {
		const hooks = await requests(client, [CREATE, LIST, GET], OPEN)
		expect(hooks.map(seen)).toEqual([
			["POST /users", false, []],
			["GET /users", true, ["POST /users"]],
			["GET /users/1", true, ["POST /users"]],
		])
	})

	it.each(CLIENTS)(
		"%s: marks nothing for a mutation answered with an error, nor one without targets",
		async (client) => {
			const failed: Reply = { json: { message: "boom" }, status: 500 }
			const order: Reply = { json: { id: "o1" }, status: 201 }
			const [refused, untargeted] = await Promise.all([
				traced(client, [CREATE, LIST], OPEN, { replies: [failed] }),
				requests(client, [ORDER, LIST], OPEN, { replies: [order] }),
			])
			expect(
				{ refused: [refused.kinds, refused.status, refused.hooks.map(seen)], untargeted: untargeted.map(seen) },
				refused.stderr,
			).toEqual({
				refused: [
					["error", "data"],
					0,
					[
						["POST /users", false, []],
						["GET /users", false, []],
					],
				],
				untargeted: [
					["POST /orders", false, []],
					["GET /users", false, []],
				],
			})
		},
	)

	// v0: 2047dada86
	it.each(CLIENTS)(
		"%s: a param-less mutation stales every instance of the templated read; one read clears it",
		async (client) => {
			const hooks = await requests(client, [CREATE, GET, GET], OPEN)
			expect(staleness(hooks)).toEqual([false, true, false])
		},
	)

	/* v0 grepped _invalidation.py for time.monotonic; the port pins the observable window. The sleep is a lower
	 * bound, so 1100 ms always outlasts the 1000 ms window; the read right after the first create has the whole
	 * window as its margin */
	// v0: ccbd2e636b
	it.each(CLIENTS)("%s: stops reading stale once staleTimeMs has passed since the last mark", async (client) => {
		const sleepMs = [undefined, undefined, undefined, 1100]
		const hooks = await requests(client, [CREATE, GET, CREATE, GET], { staleTimeMs: 1000 }, { sleepMs })
		expect(staleness(hooks)).toEqual([false, true, false, false])
	})
})

describe.skipIf(!PY)("stale tracking: off without invalidation or with staleTimeMs 0", SLOW, () => {
	/* v0 grepped _invalidation.py for the `stale_time == 0` guard; the port pins the observable: no selector,
	 * nothing stale */
	// v0: f8bd838da4
	it.each(CLIENTS)("%s: reports no selector and nothing stale to the hooks after a mutation", async (client) => {
		const [none, zero] = await Promise.all([
			requests(client, [CREATE, LIST]),
			requests(client, [CREATE, LIST], { staleTimeMs: 0 }),
		])
		const off = [
			["", false, []],
			["", false, []],
		]
		expect({ none: none.map(seen), zero: zero.map(seen) }).toEqual({ none: off, zero: off })
	})
})

describe.skipIf(!PY)("stale tracking: bounded by InvalidationConfig", SLOW, () => {
	/* v0 grepped _invalidation.py for stale_max_entries and an eviction; the port pins Go's eviction, the least
	 * recently staled first (mark order), down to half the cap, even within one mutation's targets */
	// v0: 98bfb47f5a
	it.each(CLIENTS)("%s: evicts the least recently staled down to half of staleMaxEntries", async (client) => {
		const reads = [TOUCH, A, B, C]
		const [capped, open] = await Promise.all([
			requests(client, reads, { staleMaxEntries: 2, staleTimeMs: 60_000 }),
			requests(client, reads, OPEN),
		])
		expect({ capped: staleness(capped), open: staleness(open) }).toEqual({
			capped: [false, false, false, true],
			open: [false, true, true, true],
		})
	})

	// v0: 98bfb47f5a
	it.each(CLIENTS)("%s: keeps at most maxSourcesPerTarget mutations per stale selector", async (client) => {
		const reads = [CREATE, DELETE, LIST, GET]
		const [capped, open] = await Promise.all([
			requests(client, reads, { maxSourcesPerTarget: 1, staleTimeMs: 60_000 }),
			requests(client, reads, OPEN),
		])
		expect({ capped: by(capped), open: by(open) }).toEqual({
			capped: [["POST /users"], ["DELETE /users/1", "POST /users"]],
			open: [
				["POST /users", "DELETE /users/1"],
				["DELETE /users/1", "POST /users"],
			],
		})
	})
})

/**
 * The tracker both clients share, driven directly (it sends nothing): a pattern target and its clear, then the
 * lookup budget. A client staling `GET /users/{id}` as a pattern and each of `size` users' concrete
 * `GET /users/<i>`, uncapped; per size, the best per-lookup time of five rounds of 2,000 `begin` lookups.
 */
const TRACKER = `import gc
import importlib
import time

stale = importlib.import_module(f"{sdk.__name__}._honey.stale")
open_window = sdk.InvalidationConfig(stale_time=600, stale_max_entries=100_000)

section("pattern")
t = stale.StaleTracker(open_window)
t.settle(t.begin("POST", "/x"), ("GET /users/{user-id}", "GET /items/{id}"), {})
meta = t.begin("GET", "/users/42")
note(f"users/42 {meta.is_stale} {meta.invalidated_by}")
t.settle(meta, (), {})
note(f"after the read: users/9 {t.begin('GET', '/users/9').is_stale}, items/3 {t.begin('GET', '/items/3').is_stale}")

section("budget")
t = stale.StaleTracker(open_window)
t.settle(t.begin("POST", "/users"), ("GET /users/{id}",), {})
marked, best = 0, []
gc.disable()
for size in (16, 16_384):
    while marked < size:
        t.settle(t.begin("DELETE", f"/users/{marked}"), ("GET /users/{id}",), {"id": str(marked)})
        marked += 1
    fastest, found = float("inf"), 0
    for _ in range(5):
        found = 0
        started = time.perf_counter()
        for i in range(2000):
            found += t.begin("GET", f"/users/{i * 7919 % size}").is_stale
        fastest = min(fastest, (time.perf_counter() - started) / 2000)
    note(f"{size} keys: {found} of 2000 stale, {len(t.entries)} entries")
    best.append(fastest)
gc.enable()
note(f"ratio {best[1] / best[0]:.2f}")`

/** The tracker program, run once against `fixtures`. */
const tracker = once(() => consume("fixtures", "stale", { body: TRACKER }))

describe.skipIf(!PY)("stale tracking: the tracker both clients share", SLOW, () => {
	/* runtime_check.py's "pattern target kept", "pattern still matches" and "clear drops the pattern" */
	// v0: 31aba57f46
	it("keeps a templated target as a pattern every concrete read matches; a read through it clears only it", async () => {
		const run = await tracker()
		expect({ out: run.out?.pattern, ran: run.ran }, run.stderr).toEqual({
			out: ["users/42 True ['POST /x']", "after the read: users/9 False, items/3 True"],
			ran: true,
		})
	})

	/* runtime_check.py timed 2,000 lookups over 20,000 keys against 0.5 s; the port compares a lookup's cost over
	 * 16 keys and over 16,384 (1024× the keys) in one process, the best of five rounds each: a lookup bounded by
	 * the pattern keys costs about the same at both sizes, one that scans every entry grows with them, so the guard
	 * allows 16× growth and needs no machine's absolute speed */
	// v0: 31aba57f46
	it("looks a selector up without scanning every stale entry: 1024× the entries cost a lookup under 16× more", async () => {
		const run = await tracker()
		const notes = run.out?.budget ?? []
		const ratio = Number(/^ratio (\S+)$/.exec(notes.at(-1) ?? "")?.[1])
		expect({ ran: run.ran, stale: notes.slice(0, -1) }, run.stderr).toEqual({
			ran: true,
			stale: ["16 keys: 2000 of 2000 stale, 17 entries", "16384 keys: 2000 of 2000 stale, 16385 entries"],
		})
		expect(ratio, notes.join("\n")).toBeLessThan(16)
	})
})
