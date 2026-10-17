/**
 * Stale tracking (contract 47 §5.7, Python's `http.stale.test.ts` analog): a 2xx mutation stales its
 * `x-invalidate` targets for the next read, which a read through them clears; off without
 * `ClientConfig.Invalidation` or with a zero `StaleTime`; a mark lapsing after the stale window (the monotonic
 * clock); and bounded by `InvalidationConfig`: `StaleMaxEntries` evicts the least recently staled to half,
 * `MaxSourcesPerTarget` caps what a selector was invalidated by. Driven against `http` (documents-http.ts), whose
 * `users.create`/`users.delete` stale `GET /users` and `GET /users/{id}`, and `pages.touch` `/a`, `/b`, `/c`, on
 * C#'s one async client. The tracker is internal, so two consumer programs reach it through the public surface, a
 * request hook reading `RequestContext.IsStale`: a colon-pattern target on `fixtures` (invalidation.json's
 * `GET /users/:id`), and a lookup's cost against the entry count on `http-safe`, whose 404 reads keep their keys.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen as notes } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

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

/** The `http` SDK with the driver aimed at it: it must build. */
function staleSdk(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** How a run goes: each call's wait before it, and the server's replies (200 `{}` past them). */
type Options = { readonly replies?: readonly Reply[]; readonly sleepMs?: readonly (number | undefined)[] }

/**
 * `calls` with `invalidation` (none when absent), each delayed by its `sleepMs`: each call's observed kind, what
 * each call's request hook saw, the exit status and stderr.
 */
async function traced(calls: readonly Call[], invalidation?: Invalidation, options: Options = {}) {
	const script: Script = {
		...(invalidation === undefined ? {} : { config: { invalidation } }),
		calls: (options.sleepMs ?? []).map((ms) => (ms === undefined ? null : { sleepMs: ms })),
	}
	const sdk = staleSdk()
	const run = await served(options.replies ?? [], (server) =>
		sdk.runCalls({ calls, setup: {} }, { url: server.url }, { script }),
	)
	return {
		hooks: (run.trace?.hooks ?? []).filter((h) => h.phase === "request"),
		kinds: run.observed?.map((o) => (o as { kind?: string } | null)?.kind),
		status: run.status,
		stderr: run.stderr,
	}
}

/** `traced` where every call must succeed: what each call's request hook saw. */
async function requests(calls: readonly Call[], invalidation?: Invalidation, options: Options = {}) {
	const { hooks, kinds, status, stderr } = await traced(calls, invalidation, options)
	expect({ kinds, status }, stderr).toEqual({ kinds: calls.map(() => "data"), status: 0 })
	return hooks
}

/** A request hook entry as `[selector, isStale, invalidatedBy]`. */
const seen = (h: HookTrace) => [h.selector, h.isStale, h.invalidatedBy]
const staleness = (hooks: readonly HookTrace[]) => hooks.map((h) => h.isStale)
/** What the reads after the first two calls were invalidated by. */
const by = (hooks: readonly HookTrace[]) => hooks.slice(2).map((h) => h.invalidatedBy)

const OPEN: Invalidation = { staleTimeMs: 60_000 }

describe.skipIf(!DOTNET)(
	"stale tracking: a 2xx mutation stales its x-invalidate targets for the next read",
	SLOW,
	() => {
		/* ported from python/http.stale.test.ts:88 */
		it("shows each target's read as stale, invalidated by the mutation's selector", async () => {
			const hooks = await requests([CREATE, LIST, GET], OPEN)
			expect(hooks.map(seen)).toEqual([
				["POST /users", false, []],
				["GET /users", true, ["POST /users"]],
				["GET /users/1", true, ["POST /users"]],
			])
		})

		/* ported from python/http.stale.test.ts:97 */
		it("marks nothing for a mutation answered with an error, nor one without targets", async () => {
			const failed: Reply = { json: { message: "boom" }, status: 500 }
			const order: Reply = { json: { id: "o1" }, status: 201 }
			const [refused, untargeted] = await Promise.all([
				traced([CREATE, LIST], OPEN, { replies: [failed] }),
				requests([ORDER, LIST], OPEN, { replies: [order] }),
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
		})

		/* ported from python/http.stale.test.ts:127 */
		it("a param-less mutation stales every instance of the templated read; one read clears it", async () => {
			const hooks = await requests([CREATE, GET, GET], OPEN)
			expect(staleness(hooks)).toEqual([false, true, false])
		})

		/* ported from python/http.stale.test.ts:139. The sleep is a lower bound, so 1100 ms always outlasts the
		 * 1000 ms window; the read right after the first create has the whole window as its margin */
		it("stops reading stale once StaleTime has passed since the last mark", async () => {
			const sleepMs = [undefined, undefined, undefined, 1100]
			const hooks = await requests([CREATE, GET, CREATE, GET], { staleTimeMs: 1000 }, { sleepMs })
			expect(staleness(hooks)).toEqual([false, true, false, false])
		})
	},
)

describe.skipIf(!DOTNET)("stale tracking: off without Invalidation or with a zero StaleTime", SLOW, () => {
	/* ported from python/http.stale.test.ts:150 */
	it("reports no selector and nothing stale to the hooks after a mutation", async () => {
		const [none, zero] = await Promise.all([requests([CREATE, LIST]), requests([CREATE, LIST], { staleTimeMs: 0 })])
		const off = [
			["", false, []],
			["", false, []],
		]
		expect({ none: none.map(seen), zero: zero.map(seen) }).toEqual({ none: off, zero: off })
	})
})

describe.skipIf(!DOTNET)("stale tracking: bounded by InvalidationConfig", SLOW, () => {
	/* ported from python/http.stale.test.ts:167: Go's eviction, the least recently staled first (mark order),
	 * down to half the cap, even within one mutation's targets */
	it("evicts the least recently staled down to half of StaleMaxEntries", async () => {
		const reads = [TOUCH, A, B, C]
		const [capped, open] = await Promise.all([
			requests(reads, { staleMaxEntries: 2, staleTimeMs: 60_000 }),
			requests(reads, OPEN),
		])
		expect({ capped: staleness(capped), open: staleness(open) }).toEqual({
			capped: [false, false, false, true],
			open: [false, true, true, true],
		})
	})

	/* ported from python/http.stale.test.ts:180 */
	it("keeps at most MaxSourcesPerTarget mutations per stale selector", async () => {
		const reads = [CREATE, DELETE, LIST, GET]
		const [capped, open] = await Promise.all([
			requests(reads, { maxSourcesPerTarget: 1, staleTimeMs: 60_000 }),
			requests(reads, OPEN),
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
 * A client staling `GET /invalidation/users/:id` as a pattern (`users.create` has no `id`), then reading users 42
 * and 9 and the list: each request hook's selector, staleness and sources as one note.
 */
const PATTERN = `Section("pattern");
var window = new InvalidationConfig { StaleTime = TimeSpan.FromMinutes(10) };
var lines = new List<string>();
using var c = Client(new ClientConfig
{
    Invalidation = window,
    OnRequest = [(ctx, _) =>
    {
        lines.Add($"{ctx.Selector} {ctx.IsStale} [{string.Join(", ", ctx.InvalidatedBy)}]");
        return Task.CompletedTask;
    }],
});
await c.Invalidation.Users.CreateAsync(new InvalidationUserCreateInput { Email = "e" });
await c.Invalidation.Users.GetByIdAsync("42");
await c.Invalidation.Users.GetByIdAsync("9");
await c.Invalidation.Users.ListAsync();
foreach (var line in lines)
{
    Note(line);
}`

const USER = (id: string): Reply => ({ json: { email: "e", id }, status: 200 })
const PATTERN_REPLIES: readonly Reply[] = [
	{ json: { email: "e", id: "u1" }, status: 201 },
	USER("42"),
	USER("9"),
	{ json: [], status: 200 },
]

/**
 * `users.delete` of ids 0…size-1 stales each `GET /users/<id>` as an exact key (16, then 16,384); per size, the best
 * mean of five rounds of 2,000 `users.get` reads through those keys (each answered 404, so no read clears its key)
 * of the time from the call to its request hook: the path, the URL, the tracker's lookup, the header fold and the
 * context, never the wire; and the stale reads the last round's hook counted.
 */
const BUDGET = `Section("budget");
var stale = 0;
var sent = 0L;
var spent = 0.0;
using var c = Client(new ClientConfig
{
    Invalidation = new InvalidationConfig { StaleTime = TimeSpan.FromMinutes(10), StaleMaxEntries = 100_000 },
    OnRequest = [(ctx, _) =>
    {
        spent += System.Diagnostics.Stopwatch.GetElapsedTime(sent).TotalMicroseconds;
        stale += ctx.IsStale ? 1 : 0;
        return Task.CompletedTask;
    }],
});
var marked = 0;
var best = new List<double>();
foreach (var size in new[] { 16, 16_384 })
{
    for (; marked < size; marked++)
    {
        await c.Users.DeleteAsync($"{marked}");
    }
    var fastest = double.MaxValue;
    for (var round = 0; round < 5; round++)
    {
        stale = 0;
        spent = 0;
        for (var i = 0; i < 2000; i++)
        {
            sent = System.Diagnostics.Stopwatch.GetTimestamp();
            await c.Users.GetAsync($"{i * 7919 % size}");
        }
        fastest = Math.Min(fastest, spent / 2000);
    }
    Note($"{size} keys: {stale} of 2000 stale");
    best.Add(fastest);
}
Note($"ratio {(best[1] / best[0]).ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}");`

/** BUDGET's replies in its order: per size, the deletes that mark its new keys answered 200, then its reads 404. */
const BUDGET_REPLIES: readonly Reply[] = [16, 16_384 - 16].flatMap((marks) => [
	...Array.from({ length: marks }, (): Reply => ({ json: { id: "d" }, status: 200 })),
	...Array.from({ length: 5 * 2000 }, (): Reply => ({ json: { message: "m" }, status: 404 })),
])

describe.skipIf(!DOTNET)("stale tracking through the public surface (consumer programs)", SLOW, () => {
	/* ported from python/http.stale.test.ts:243 (runtime_check.py's "pattern target kept", "pattern still
	 * matches" and "clear drops the pattern"), through a request hook: the tracker is internal */
	it("keeps a colon-templated target as a pattern every concrete read matches; a read through it clears only it", async () => {
		const { run, wire } = await served(PATTERN_REPLIES, async (server) => {
			const ran = await consume("fixtures", "stale", { base: server.url, body: PATTERN })
			return { run: ran, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
		})
		expect({ ...notes(run, "pattern"), wire }, run.stderr).toEqual({
			out: [
				"POST /invalidation/users False []",
				"GET /invalidation/users/42 True [POST /invalidation/users]",
				"GET /invalidation/users/9 False []",
				"GET /invalidation/users True [POST /invalidation/users]",
			],
			ran: true,
			wire: [
				"POST /invalidation/users",
				"GET /invalidation/users/42",
				"GET /invalidation/users/9",
				"GET /invalidation/users",
			],
		})
	})

	/* ported from python/http.stale.test.ts:256 (runtime_check.py timed 2,000 lookups over 20,000 keys against
	 * 0.5 s). A lookup bounded by the pattern keys costs about the same over 16 keys as over 16,384, one that scans
	 * every entry grows with them, even by string equality alone; timed from the call to its request hook, no wire
	 * cost hides that (honey-a8's redesign), and a ratio needs no machine's absolute speed */
	it("looks a selector up without scanning every stale entry: 16,384 entries cost the work before the request hook under 4× what 16 do", async () => {
		const run = await served(BUDGET_REPLIES, (server) =>
			consume("http-safe", "stale-budget", { base: server.url, body: BUDGET }),
		)
		const budget = run.out?.budget ?? []
		const ratio = Number(/^ratio (\S+)$/.exec(budget.at(-1) ?? "")?.[1])
		expect({ ran: run.ran, stale: budget.slice(0, -1) }, run.stderr).toEqual({
			ran: true,
			stale: ["16 keys: 2000 of 2000 stale", "16384 keys: 2000 of 2000 stale"],
		})
		expect(ratio, budget.join("\n")).toBeLessThan(4)
	})
})
