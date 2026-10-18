import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import type { HookTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { check, consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

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

/**
 * Users with a create and a delete that stale the list and every user, a touch that stales /a, /b and /c, an
 * operation cancel that stales its own `{id}:cancel` read, and a flush that stales the literal /ops/1:cancel.
 */
const STALE: Json = {
	info: { title: "Stale", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/a": { get: read("pages.a") },
		"/b": { get: read("pages.b") },
		"/c": { get: read("pages.c") },
		"/ops/flush": { post: mutation("ops.flush", ["GET /ops/1:cancel"]) },
		"/ops/{id}:cancel": {
			get: read("ops.cancelled", [ID]),
			post: mutation("ops.cancel", ["GET /ops/{id}:cancel"], { parameters: [ID] }),
		},
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
const CANCEL = call("ops.cancel", "POST", "/ops/{id}:cancel", { params: { id: "7" } })
const FLUSH = call("ops.flush", "POST", "/ops/flush")
const cancelled = (id: string) => call("ops.cancelled", "GET", "/ops/{id}:cancel", { params: { id } })
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

goDescribe("stale tracking: a successful mutation stales its x-invalidate targets for the next read", () => {
	// v0: 5cbc1880a7
	it("shows each target's read as stale, invalidated by the mutation's concrete selector", async () => {
		const hooks = await requests([CREATE, LIST, GET], { staleTimeMs: 60_000 })
		expect(hooks.map(seen)).toEqual([
			["POST /users", false, []],
			["GET /users", true, ["POST /users"]],
			["GET /users/1", true, ["POST /users"]],
		])
	}, 600_000)

	// v0: b1382c5259
	it("stales every instance of a target its params cannot fill, and clears one once a read through it succeeds", async () => {
		const hooks = await requests([CREATE, GET, GET], { staleTimeMs: 60_000 })
		expect(staleness(hooks)).toEqual([false, true, false])
	}, 600_000)

	// v0: 48f0de3009
	it("stops reading stale once staleTimeMs has passed since the last mark", async () => {
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

goDescribe("stale tracking: a target's placeholders", () => {
	/* v0's TestInvalidationPatterns: `{id}` fills inside a segment and leaves the `:cancel` after it as text, and a
	 * colon inside a segment of a literal target is no placeholder; the `{user-id}` half is the read above. /ops/8
	 * reads before /ops/7, whose stale read would clear a target left a pattern */
	// v0: 0c1872f081
	it("fills {id}:cancel to the one /ops/7:cancel, and keeps a literal /ops/1:cancel from staling /ops/2:cancel", async () => {
		const hooks = await requests([CANCEL, cancelled("8"), cancelled("7"), FLUSH, cancelled("2"), cancelled("1")], {
			staleTimeMs: 60_000,
		})
		expect(hooks.map(seen)).toEqual([
			["POST /ops/7:cancel", false, []],
			["GET /ops/8:cancel", false, []],
			["GET /ops/7:cancel", true, ["POST /ops/7:cancel"]],
			["POST /ops/flush", false, []],
			["GET /ops/2:cancel", false, []],
			["GET /ops/1:cancel", true, ["POST /ops/flush"]],
		])
	}, 600_000)
})

goDescribe("stale tracking: off without invalidation or with staleTimeMs 0", () => {
	/* V0BUG: v0's name says the tracker is nil when StaleTime is 0; it never was (a disabled non-nil
	 * tracker). The port pins the observable: no selector, nothing stale. */
	// v0: 7298c85a98
	it("reports no selector and nothing stale to the hooks after a mutation", async () => {
		const [none, zero] = await Promise.all([requests([CREATE, LIST]), requests([CREATE, LIST], { staleTimeMs: 0 })])
		const off = [
			["", false, []],
			["", false, []],
		]
		expect({ none: none.map(seen), zero: zero.map(seen) }).toEqual({ none: off, zero: off })
	}, 600_000)
})

goDescribe("stale tracking: bounded by InvalidationConfig, never by Config", () => {
	/* G1: v0's test passed on the dead Config.StaleMaxEntries; the live bound is
	 * InvalidationConfig.StaleMaxEntries, which the driver sets from `staleMaxEntries` */
	// v0: f92c465b60
	it("evicts the least recently staled down to half of staleMaxEntries once a mark passes it", async () => {
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

/**
 * `Users.Delete` of ids 0…size-1 stales each `GET /users/<id>` as an exact key (16, then 16,384); per size, the
 * median over five rounds of 2,000 `Users.Get` reads through those keys (each answered 404 in process, so no read
 * clears its key) of the time from the call to its request hook: the path, the URL, the tracker's lookup and the
 * context, never the wire; and the stale reads the last round's hook counted. A median, not a round's mean: a read
 * the scheduler preempts is an outlier, never the middle, while a scan slows every read.
 */
const BUDGET = `	section("budget")
	var (
		sent  time.Time
		took  time.Duration
		stale int
	)
	c := sdk.NewClient(sdk.Config{
		BaseURL:      "http://stale.test",
		HTTPClient:   &http.Client{Transport: quiet{}},
		Invalidation: &sdk.InvalidationConfig{StaleTime: 600_000, StaleMaxEntries: 100_000},
		OnRequest: []func(*sdk.RequestContext) error{func(rc *sdk.RequestContext) error {
			took = time.Since(sent)
			if rc.IsStale {
				stale++
			}
			return nil
		}},
	})
	marked, medians := 0, []float64{}
	for _, size := range []int{16, 16_384} {
		for ; marked < size; marked++ {
			if _, err := c.Users.Delete(ctx, strconv.Itoa(marked), nil); err != nil {
				note("delete:", err)
			}
		}
		reads := make([]time.Duration, 0, 5*2000)
		for range 5 {
			stale = 0
			for i := range 2000 {
				sent = time.Now()
				_, _ = c.Users.Get(ctx, strconv.Itoa(i*7919%size), nil)
				reads = append(reads, took)
			}
		}
		slices.Sort(reads)
		note(fmt.Sprintf("%d keys: %d of 2000 stale", size, stale))
		medians = append(medians, float64(reads[len(reads)/2]))
	}
	note(fmt.Sprintf("ratio %.2f", medians[1]/medians[0]))`

/** BUDGET's transport: a DELETE answered 200 `{}`, a GET 404, in process. */
const QUIET = `type quiet struct{}

func (quiet) RoundTrip(req *http.Request) (*http.Response, error) {
	status, body := 200, "{}"
	if req.Method == http.MethodGet {
		status, body = 404, \`{"message":"m"}\`
	}
	return &http.Response{
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": {"application/json"}},
		Request:    req,
		StatusCode: status,
	}, nil
}`

goDescribe("stale tracking: the lookup's cost", () => {
	/* v0's TestStaleLookupScale timed 2,000 lookups over 20,000 keys against 500 ms; the port compares the cost
	 * over 16 keys and over 16,384 in one process, as csharp/http.stale.test.ts does. A lookup bounded by the
	 * pattern keys costs about the same at both sizes, one that scans every entry grows with them, even by string
	 * equality alone (measured 52× and more under load); timed from the call to its request hook, no wire cost hides
	 * that */
	// v0: 0c1872f081
	it("looks a selector up without scanning every stale entry: 16,384 entries cost the work before the request hook under 4× what 16 do", async () => {
		const files = generateGoSdk(STALE, { modulePath: MODULE }).files
		const run = await consume(files, MODULE, { body: BUDGET, decls: QUIET, imports: ["slices", "strconv", "time"] })
		const budget = run.out?.budget ?? []
		const ratio = Number(/^ratio (\S+)$/.exec(budget.at(-1) ?? "")?.[1])
		expect({ built: run.built, stale: budget.slice(0, -1), vet: run.vet }, run.stderr).toEqual({
			built: true,
			stale: ["16 keys: 2000 of 2000 stale", "16384 keys: 2000 of 2000 stale"],
			vet: [],
		})
		expect(ratio, budget.join("\n")).toBeLessThan(4)
	}, 600_000)
})
