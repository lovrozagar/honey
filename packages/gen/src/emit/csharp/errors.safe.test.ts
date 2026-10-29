/**
 * The C# SDK's safe mirror (contract 47 §5.9; bit 21 i5): on `client.Safe` an answer is a `Result` Err holding the
 * `SdkException` the normal call throws for it (an error status, declared or not, as its `ApiStatusException`; an
 * undecodable 2xx or one past the cap as a `DecodeException`) beside its `RawResponse`, and only a failure without
 * an answer still throws (a timeout, the caller's token, a refused connection, a throwing hook: f2). Driven through
 * the `http` and `lenient` drivers in the safe style, the driver reading each `Result` strictly (Observe.Settle); a
 * consumer program reads every member of `Result` as a caller does, and the removed safe mode's pattern fails to
 * compile (R-i4).
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const MEMBERS: Call = {
	operation: "members.get",
	params: { org: "o", "user-id": "u" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
}
const USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

/** The registry SDK `key` with the driver aimed at it (it must build). */
function driven(key: "http" | "lenient"): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk(key)
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup; readonly safe?: boolean }

/** `calls` on `sdk` (its `client.Safe` unless `safe` is false) under `options`, against a server answering `replies`. */
function drive(sdk: DrivenCSharpSdk, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { script: options.script ?? {} }, options.safe ?? true)
		return { hops: server.hops.length, run }
	})
}

/** `calls` on `client.Safe` against an origin that refuses every connection. */
const refused = (sdk: DrivenCSharpSdk, calls: readonly Call[]) =>
	sdk.runCalls({ calls, setup: {} }, { url: REFUSED_URL }, { script: {} }, true)

type Traced = Trace<CsError>["calls"][number]
/** An error status as the driver observes it, for a `{"message": "m"}` body. */
const failed = (status: number) => ({ body: { message: "m" }, errorKey: null, kind: "error", status })
const answer = (status: number): Reply => ({ json: { message: "m" }, status })
/** A safe call's Err: no value, its response its answer's. */
const missed = (status: number) => ({ data: false, ok: false, response: true, status })
/** A 2xx whose JSON body is cut short. */
const TORN: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }

/**
 * Where a call's failure landed: its route ("result" for a Result Err), class (`canceled` for the caller's token,
 * which .NET throws as either cancel type), whether it is the `SdkException` base, its status, and its result's summary.
 */
const landed = (call: Traced | undefined) => {
	const error = call?.error
	const answered = error === undefined ? undefined : error.chain.includes("SdkException")
	return [error?.via, error?.canceled ? "canceled" : error?.type, answered, error?.status, call?.result]
}

describe.skipIf(!DOTNET)("client.Safe: an answer a Result Err with its response, only no answer thrown", SLOW, () => {
	it("answers a 404 and an undeclared 418 (the SdkException base) as Err, a refused connection thrown", async () => {
		const sdk = driven("http")
		const { run } = await drive(sdk, [answer(404), answer(418)], [MEMBERS, MEMBERS])
		const lost = await refused(sdk, [MEMBERS])
		const [found, teapot, gone] = [...(run.trace?.calls ?? []), ...(lost.trace?.calls ?? [])].map(landed)
		expect({ found, gone, observed: [run.observed, lost.observed], teapot }, run.stderr + lost.stderr).toEqual({
			found: ["result", "NotFoundException", true, 404, missed(404)],
			gone: ["return", "ApiConnectionException", false, undefined, undefined],
			observed: [[failed(404), failed(418)], [null]],
			teapot: ["result", "UnexpectedStatusException", true, 418, missed(418)],
		})
	})
})

describe.skipIf(!DOTNET)(
	"client.Safe: an undecodable or over-cap 2xx an Err, a timeout, a cancel and a hook throw thrown",
	SLOW,
	() => {
		/* R-i1 and the i1 carry-in: an undecodable 2xx and one past the cap are answers; a timeout, a cancel and a hook throw are none (f2) */
		it("answers an undecodable or over-cap 2xx as Err(DecodeException), and throws a timeout, a cancel and a hook throw", async () => {
			const sdk = driven("http")
			const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
			const calls = [USER, { ...MEMBERS, timeoutMs: 300 }, MEMBERS]
			const script: Script = { calls: [null, null, { cancel: "before" }] }
			const { hops, run } = await drive(sdk, [TORN, late], calls, { script })
			const big: Reply = { json: { id: "u", name: "a name past the cap" }, status: 200 }
			const capped = await drive(sdk, [big], [USER], { setup: { maxResponseBytes: 16 } })
			const hooked = await drive(sdk, [], [MEMBERS], { script: { hooks: { request: [{ fail: "boom" }] } } })
			const traces = [run, capped.run, hooked.run].flatMap((r) => r.trace?.calls ?? [])
			expect(
				{
					hops: [hops, capped.hops, hooked.hops],
					landed: traces.map(landed),
					observed: [run.observed, capped.run.observed, hooked.run.observed],
				},
				run.stderr + capped.run.stderr + hooked.run.stderr,
			).toEqual({
				hops: [2, 1, 0],
				landed: [
					["result", "DecodeException", true, undefined, missed(200)],
					["return", "ApiTimeoutException", false, undefined, undefined],
					["return", "canceled", false, undefined, undefined],
					["result", "DecodeException", true, undefined, missed(200)],
					["return", "HookException", false, undefined, undefined],
				],
				observed: [
					[{ kind: "decode", status: 200 }, { kind: "timeout" }, null],
					[{ kind: "decode", status: 200 }],
					[null],
				],
			})
		})

		/* ported from python/errors.safe.test.ts:108: http declares no keys, so the declared-member path is errors.test.ts's */
		it("reads the server's key in a safe call's Err, no member for an API that declares none", async () => {
			const missing: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
			const { run } = await drive(driven("http"), [missing], [MEMBERS])
			const call = run.trace?.calls[0]
			expect({ error: call?.error, result: call?.result }, run.stderr).toEqual({
				error: {
					canceled: false,
					chain: ["NotFoundException", "ApiStatusException", "SdkException", "HoneyException"],
					display: expect.any(String),
					inner: null,
					key: "member.missing",
					keyMember: null,
					message: "gone",
					status: 404,
					text: "HTTP 404: gone",
					type: "NotFoundException",
					via: "result",
				},
				result: missed(404),
			})
		})
	},
)

/* lenient's three operations: answers a fallback (a default JsonElement, a null) would fit */
const LENIENT: readonly Call[] = [
	{ operation: "any.get", route: { method: "GET", path: "/any" } },
	{ operation: "count.get", route: { method: "GET", path: "/count" } },
	{ operation: "maybe.get", route: { method: "GET", path: "/maybe" } },
]

describe.skipIf(!DOTNET)(
	"a decode failure is never Ok, whatever the answer type would accept (the runtime's, not the type's)",
	SLOW,
	() => {
		it.each([
			["the client: DecodeException thrown", false],
			["client.Safe: Err(DecodeException)", true],
		] as const)(
			"answers an undecodable 2xx to a JsonElement, a long? and a nullable object op as its decode error, on %s",
			async (_, safe) => {
				const { run } = await drive(driven("lenient"), [TORN, TORN, TORN], LENIENT, { safe })
				const decoded = safe
					? ["result", "DecodeException", true, undefined, missed(200)]
					: ["return", "DecodeException", true, undefined, undefined]
				expect({ landed: run.trace?.calls.map(landed), observed: run.observed }, run.stderr).toEqual({
					landed: [decoded, decoded, decoded],
					observed: Array.from({ length: 3 }, () => (safe ? { kind: "decode", status: 200 } : null)),
				})
			},
		)
	},
)

describe.skipIf(!DOTNET)("client.Safe: each Result its own", SLOW, () => {
	/* the grid runs one process per cell: two Ok answers on one client prove each holds its own value and response */
	it("holds each Ok's own value and response across calls on one client", async () => {
		const replies: Reply[] = [
			{ json: { id: "1" }, status: 200 },
			{ json: { id: "2" }, status: 201 },
		]
		const { run } = await drive(driven("http"), replies, [USER, { ...USER, params: { id: "2" } }])
		expect({ observed: run.observed, results: run.trace?.calls.map((c) => c.result) }, run.stderr).toEqual({
			observed: [
				{ data: { id: "1" }, kind: "data", status: 200 },
				{ data: { id: "2" }, kind: "data", status: 201 },
			],
			results: [
				{ data: true, ok: true, response: true, status: 200 },
				{ data: true, ok: true, response: true, status: 201 },
			],
		})
	})
})

/**
 * The `result` consumer: users.get answered 404, then 201, each `Result<T>` read through every member, the wrong
 * arm's accessor included (it throws InvalidOperationException, never a silent null).
 */
const RESULT = `Section("result");
using var c = Client();
var missing = await c.Safe.Users.GetAsync("missing");
Note($"{missing.IsOk} {missing.Error is NotFoundException} {missing.Error is SdkException} {missing.Response.Status} {missing.Error.Message}");
Note($"{missing.TryGetValue(out var none)} {none is null} {missing.Match(v => "ok", e => $"err {e.GetType().Name}")}");
try { Note(missing.Value.Id); } catch (InvalidOperationException e) { Note(e.Message); }
var found = await c.Safe.Users.GetAsync("u1");
Note($"{found.IsOk} {found.Value.Id} {found.Response.Status} {found.TryGetValue(out var user)} {user?.Id} {found.Match(v => $"ok {v.Id}", e => "err")}");
try { Note(found.Error.Message); } catch (InvalidOperationException e) { Note(e.Message); }
Result gone = await c.Safe.Users.GetAsync("u1");
Note($"{gone.IsOk} {gone.Match(() => "ok", e => "err")}");`

const RESULT_REPLIES: readonly Reply[] = [
	{ json: { message: "gone" }, status: 404 },
	{ json: { id: "u1" }, status: 201 },
	{ json: { id: "u1" }, status: 200 },
]

describe.skipIf(!DOTNET)("Result<T> from a consumer program (http)", SLOW, () => {
	it("holds a 404 as its Err, a 201 as its Ok, and throws on the wrong arm's accessor", async () => {
		const { run, wire } = await served(RESULT_REPLIES, async (server) => {
			const ran = await consume("http", "result", { base: server.url, body: RESULT })
			return { run: ran, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
		})
		expect({ ...seen(run, "result"), wire }, run.stderr).toEqual({
			out: [
				"False True True 404 HTTP 404: gone",
				"False True err NotFoundException",
				"Value read on an Err result: HTTP 404: gone",
				"True u1 201 True u1 ok u1",
				"Error read on an Ok result: HTTP 201",
				"True ok",
			],
			ran: true,
			wire: ["GET /users/missing", "GET /users/u1", "GET /users/u1"],
		})
	})
})

/** The removed safe mode's pattern, unchanged (R-i4): its type, its members, and a normal call read as a result. */
const OLD = `// consumer old-safe: a test program, never shipped
using System.Threading.Tasks;
using HoneySdk;

internal static class Program
{
    private static async Task Main()
    {
        using var c = new HoneySdkClient(new ClientConfig { BaseUrl = "http://127.0.0.1:9" });
        SdkResult<UsersGetResponse> old = await c.Users.GetAsync("1");
        var plain = await c.Users.GetAsync("1");
        var safe = await c.Safe.Users.GetAsync("1");
        System.Console.WriteLine($"{old} {plain.IsSuccess} {safe.Status} {safe.Data}");
    }
}
`

describe.skipIf(!DOTNET)("the removed safe mode (R-i4)", SLOW, () => {
	it("refuses its pattern at compile time: SdkResult is gone, and neither a normal call nor a Result reads as one", () => {
		const errors = checked("http", OLD).map((line) => /error (CS\d{4}): (.*)$/.exec(line)?.slice(1).join(" ") ?? line)
		expect(errors).toEqual([
			expect.stringMatching(/^CS0246 .*'SdkResult<>'/),
			expect.stringMatching(/^CS1061 '(HoneySdk\.)?UsersGetResponse' .*'IsSuccess'/),
			expect.stringMatching(/^CS1061 '(HoneySdk\.)?Result<(HoneySdk\.)?UsersGetResponse>' .*'Status'/),
			expect.stringMatching(/^CS1061 '(HoneySdk\.)?Result<(HoneySdk\.)?UsersGetResponse>' .*'Data'/),
		])
	})
})
