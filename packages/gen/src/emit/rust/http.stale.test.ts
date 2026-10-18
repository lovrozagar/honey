/**
 * Stale tracking (contract 19 §5.5, the Go `http.stale.test.ts` analog): a 2xx mutation stales its
 * `x-invalidate` targets for the next read, which a read through them clears; off without invalidation or
 * with a zero stale time; a mark lapsing after the stale window; and bounded by `InvalidationConfig`, never by
 * `ClientConfig`: `stale_max_entries` evicts even when one mutation marks more targets than the cap, and
 * `max_sources_per_target` caps what a selector was invalidated by; a lookup's cost bounded by the pattern
 * keys, never a scan of every stale entry (contract 20 §6, edee99d992). Driven against `http` (documents-http.ts),
 * whose `users.create`/`users.delete` stale `GET /users` and `GET /users/{id}`, and `pages.touch` `/a`, `/b`, `/c`.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { consume, sections } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

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

let memo: DrivenRustSdk | undefined
/** The `http` SDK compiled with the driver, once: it must build. */
function staleSdk(): DrivenRustSdk {
	memo ??= drivenRustSdk("http")
	expect(memo.built, memo.stderr).toBe(true)
	return memo
}

/** How a run goes: each call's wait before it, and the server's replies (200 `{}` past them). */
type Options = { readonly replies?: readonly Reply[]; readonly sleepMs?: readonly (number | undefined)[] }

/**
 * `calls` on one client with `invalidation` (none when absent), each delayed by its `sleepMs`: each call's
 * observed kind, what each call's on_request hook saw, the exit status and stderr.
 */
async function traced(calls: readonly Call[], invalidation?: Invalidation, options: Options = {}) {
	const script: Script = {
		...(invalidation === undefined ? {} : { config: { invalidation } }),
		calls: (options.sleepMs ?? []).map((ms) => (ms === undefined ? null : { sleepMs: ms })),
	}
	const run = await served(options.replies ?? [], (server) => staleSdk().runCalls({ calls, setup: {} }, server, script))
	return {
		hooks: (run.trace?.hooks ?? []).filter((h) => h.phase === "request"),
		kinds: run.observed?.map((o) => (o as { kind?: string } | null)?.kind),
		status: run.status,
		stderr: run.stderr,
	}
}

/** `traced` where every call must succeed: what each call's on_request hook saw. */
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

/**
 * The lookup budget: a client staling `GET /users/{id}` as a pattern (a create) and each deleted user's
 * concrete `GET /users/<id>`, uncapped; its reads end in their request hook, which reports what the lookup
 * found, so a read sends nothing. Per size, the best per-lookup time of five rounds of 256 reads.
 */
const BUDGET = sections({
	budget: `    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        invalidation: Some(sdk::InvalidationConfig {
            stale_time: std::time::Duration::from_secs(600),
            stale_max_entries: 100_000,
            ..Default::default()
        }),
        on_request: vec![std::sync::Arc::new(read_ends)],
        ..Default::default()
    })?;
    c.users().create(&sdk::UsersCreateBody { name: None }, &sdk::UsersCreateOpts::default()).await?;
    let (mut marked, mut best) = (0usize, Vec::new());
    for size in [16usize, 16_384] {
        while marked < size {
            c.users().delete(&marked.to_string(), &sdk::UsersDeleteOpts::default()).await?;
            marked += 1;
        }
        let (mut fastest, mut stale) = (f64::MAX, 0);
        for _ in 0..5 {
            let started = std::time::Instant::now();
            stale = 0;
            for i in 0..256usize {
                let id = (i * 7919 % size).to_string();
                let read = c.users().get(&id, &sdk::UsersGetOpts::default()).await;
                stale += usize::from(read.is_err_and(|e| e.to_string() == "config: stale"));
            }
            fastest = fastest.min(started.elapsed().as_secs_f64() / 256.0);
        }
        n.note(format!("{size} keys: {stale} of 256 stale"));
        best.push(fastest);
        eprintln!("{size} keys: {:.1} us a lookup", fastest * 1e6);
    }
    n.note(format!("ratio {:.2}", best[1] / best[0]));`,
})

/** A read ends in its request hook with what its lookup found; any other request goes out. */
const READ_ENDS = `fn read_ends(ctx: &mut sdk::RequestContext) -> sdk::HookFuture<'_> {
    let found = if ctx.is_stale { "stale" } else { "fresh" };
    let read = ctx.method == reqwest::Method::GET;
    Box::pin(async move { if read { Err(sdk::Error::Config(found.into())) } else { Ok(()) } })
}`

describe.skipIf(!RUST)("stale tracking: a 2xx mutation stales its x-invalidate targets for the next read", () => {
	// v0: 81f27bd592
	it("shows each target's read as stale, invalidated by the mutation's concrete selector", async () => {
		const hooks = await requests([CREATE, LIST, GET], OPEN)
		expect(hooks.map(seen)).toEqual([
			["POST /users", false, []],
			["GET /users", true, ["POST /users"]],
			["GET /users/1", true, ["POST /users"]],
		])
	}, 600_000)

	// v0: 81f27bd592
	it("marks nothing for a mutation answered with an error, nor for one that declares no targets", async () => {
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
	}, 600_000)

	// v0: 8d5a852ecb
	// v0: eddb465d18
	it("stales every instance of a target its params cannot fill, and clears one once a read through it succeeds", async () => {
		const hooks = await requests([CREATE, GET, GET], OPEN)
		expect(staleness(hooks)).toEqual([false, true, false])
	}, 600_000)

	// v0: 9305b4c83b
	it("stops reading stale once staleTimeMs has passed since the last mark", async () => {
		/* the sleep is a lower bound, so 1100 ms always outlasts the 1000 ms window; the read right after the
		 * first create has the whole window as its margin */
		const hooks = await requests(
			[CREATE, GET, CREATE, GET],
			{ staleTimeMs: 1000 },
			{
				sleepMs: [undefined, undefined, undefined, 1100],
			},
		)
		expect(staleness(hooks)).toEqual([false, true, false, false])
	}, 600_000)
})

describe.skipIf(!RUST)("stale tracking: off without invalidation or with staleTimeMs 0", () => {
	/* v0 grepped client.rs for the `inv.stale_time > 0` guard; the port pins the observable: no selector,
	 * nothing stale */
	// v0: 2e7d165a01
	it("reports no selector and nothing stale to the hooks after a mutation", async () => {
		const [none, zero] = await Promise.all([requests([CREATE, LIST]), requests([CREATE, LIST], { staleTimeMs: 0 })])
		const off = [
			["", false, []],
			["", false, []],
		]
		expect({ none: none.map(seen), zero: zero.map(seen) }).toEqual({ none: off, zero: off })
	}, 600_000)
})

describe.skipIf(!RUST)("stale tracking: bounded by InvalidationConfig, never by ClientConfig", () => {
	/* phase-b defect: the tracker stamped every target of one mutation alike, so a mark of three targets kept
	 * all three past a cap of 2; the port pins Go's eviction, the least recently staled first (mark order) */
	// v0: 7ec4544c22
	it("evicts the least recently staled down to half of staleMaxEntries, even within one mutation's targets", async () => {
		const reads = [TOUCH, A, B, C]
		const [capped, open] = await Promise.all([
			requests(reads, { staleMaxEntries: 2, staleTimeMs: 60_000 }),
			requests(reads, OPEN),
		])
		expect({ capped: staleness(capped), open: staleness(open) }).toEqual({
			capped: [false, false, false, true],
			open: [false, true, true, true],
		})
	}, 600_000)

	// v0: 7ec4544c22
	it("has no ClientConfig.stale_max_entries: a client setting it does not compile", async () => {
		const body = 'let _ = sdk::ClientConfig { stale_max_entries: 1, ..Default::default() };\n    n.note("built");'
		const run = await consume("http", "stale-cap", { body })
		expect({ built: run.built, stderr: run.stderr }).toEqual({
			built: false,
			stderr: expect.stringMatching(/error\[E0560\]: struct `ClientConfig` has no field named `stale_max_entries`/),
		})
	}, 600_000)

	/* v0 timed 2000 lookups over 20,000 keys against 500 ms; the port compares a lookup's cost over 16 keys
	 * and over 16,384 (1024× the keys) in one process, the best of five rounds each: a lookup bounded by the
	 * pattern keys costs the same at both sizes, one that scans every entry grows with the keys, so the guard
	 * allows 4× growth (an exact-key scan measured over 30×) and needs no machine's absolute speed */
	// v0: edee99d992
	it("looks a selector up without scanning every stale entry: 1024× the entries cost a lookup under 4× more", async () => {
		const run = await served([], (server) =>
			consume("http", "stale-budget", { ...BUDGET, base: server.url, decls: `${BUDGET.decls}\n\n${READ_ENDS}` }),
		)
		const notes = run.out?.budget ?? []
		const ratio = Number(/^ratio (\S+)$/.exec(notes.at(-1) ?? "")?.[1])
		expect({ built: run.built, stale: notes.slice(0, -1) }, run.stderr).toEqual({
			built: true,
			stale: ["16 keys: 256 of 256 stale", "16384 keys: 256 of 256 stale"],
		})
		expect(ratio, notes.join("\n")).toBeLessThan(4)
	}, 600_000)

	it("keeps at most maxSourcesPerTarget mutations per stale selector; a templated target takes the mutation's params", async () => {
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
	}, 600_000)
})
