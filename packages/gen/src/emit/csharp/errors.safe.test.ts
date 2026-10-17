/**
 * The C# SDK's safe mode (contract 47 §5.9, Python's `errors.safe.test.ts` analog): an error status lands in
 * `SdkResult.Error` beside its `Status` and the `RawResponse`, and every other failure (no answer, a timeout, the
 * caller's token, an undecodable 2xx, a throwing hook) still throws. Driven through the `http-safe` driver on C#'s
 * one async client, and a `safe` consumer program reading `SdkResult<T>` as a caller does.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, recordingServer, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
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

/** The `http-safe` SDK with the driver aimed at it (it must build). */
function safe(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("http-safe")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` under `script` against a server answering `replies`: the run and the hops. */
function drive(replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	return served(replies, async (server) => {
		const run = await safe().runCalls({ calls, setup: {} }, { url: server.url }, { script })
		return { hops: [...server.hops], run }
	})
}

/** `calls` against an origin that refuses every connection. */
async function refused(calls: readonly Call[]) {
	const closed = await recordingServer([])
	await closed.close()
	return safe().runCalls({ calls, setup: {} }, { url: closed.url }, { script: {} })
}

type Traced = Trace<CsError>["calls"][number]
/**
 * Where a safe-mode call's failure landed: its route, class (`canceled` for the caller's token, which .NET throws
 * as either cancel type) and status, and its result's summary.
 */
const landed = (call: Traced | undefined) => {
	const error = call?.error
	return [error?.via, error?.canceled ? "canceled" : error?.type, error?.status, call?.result]
}
/** A safe-mode result holding an error status. */
const missed = (status: number) => ({ data: false, ok: false, response: true, status })

/** A 404 keyed `member.missing` as the trace reads it from a safe-mode result: the server's key, no member. */
const MISSING = {
	canceled: false,
	chain: ["NotFoundException", "ApiStatusException", "HoneyException"],
	display: expect.any(String),
	inner: null,
	key: "member.missing",
	keyMember: null,
	message: "gone",
	status: 404,
	text: "HTTP 404: gone",
	type: "NotFoundException",
	via: "result",
}

describe.skipIf(!DOTNET)("safe mode: an error status in SdkResult.Error, every other failure thrown", SLOW, () => {
	/* ported from python/errors.safe.test.ts:73, with a throwing hook (contract 47 §5.9) */
	it("puts a 404 in the result beside its status and response; an undecodable 2xx, a timeout, a cancel, a refused connection and a hook throw", async () => {
		const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
		const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
		const replies: Reply[] = [{ json: { message: "m" }, status: 404 }, torn, late]
		const calls = [MEMBERS, USER, { ...MEMBERS, timeoutMs: 300 }, MEMBERS]
		const script: Script = { calls: [null, null, null, { cancel: "before" }] }
		const { hops, run } = await drive(replies, calls, script)
		const lost = await refused([MEMBERS])
		const hooked = await drive([], [MEMBERS], { hooks: { request: [{ fail: "boom" }] } })
		const traces = [run, lost, hooked.run].flatMap((r) => r.trace?.calls ?? [])
		expect(
			{
				hops: [hops.length, hooked.hops.length],
				landed: traces.map(landed),
				observed: [run.observed, lost.observed, hooked.run.observed],
			},
			run.stderr + lost.stderr + hooked.run.stderr,
		).toEqual({
			hops: [3, 0],
			landed: [
				["result", "NotFoundException", 404, missed(404)],
				["return", "DecodeException", undefined, undefined],
				["return", "ApiTimeoutException", undefined, undefined],
				["return", "canceled", undefined, undefined],
				["return", "ApiConnectionException", undefined, undefined],
				["return", "HookException", undefined, undefined],
			],
			observed: [
				[{ body: { message: "m" }, errorKey: null, kind: "error", status: 404 }, null, { kind: "timeout" }, null],
				[null],
				[null],
			],
		})
	})

	/* ported from python/errors.safe.test.ts:108: http declares no keys, so the declared-member path is
	 * errors.test.ts's, shared by both modes */
	it("reads the server's key in a safe-mode result, no member for an API that declares none", async () => {
		const missing: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
		const { run } = await drive([missing], [MEMBERS])
		const call = run.trace?.calls[0]
		expect({ error: call?.error, result: call?.result }, run.stderr).toEqual({ error: MISSING, result: missed(404) })
	})
})

/** The `safe` consumer: users.get answered 404, then 201, each `SdkResult<T>` read through its members. */
const SAFE = `Section("safe");
using var c = Client();
var r = await c.Users.GetAsync("missing");
Note($"{r.Status} {r.Data is null} {r.Error is NotFoundException} {r.Response.Status} {r.IsSuccess} {r.Error?.Message}");
var found = await c.Users.GetAsync("u1");
Note($"{found.Status} {found.Data?.Id} {found.Error is null} {found.Response.Status} {found.IsSuccess}");`

const SAFE_REPLIES: readonly Reply[] = [
	{ json: { message: "gone" }, status: 404 },
	{ json: { id: "u1" }, status: 201 },
]

describe.skipIf(!DOTNET)("SdkResult<T> from a consumer program (http-safe)", SLOW, () => {
	/* ported from python/errors.safe.test.ts:157 */
	it("holds a 404 as Error with its status, RawResponse and message, a 201 as Data", async () => {
		const { run, wire } = await served(SAFE_REPLIES, async (server) => {
			const ran = await consume("http-safe", "safe", { base: server.url, body: SAFE })
			return { run: ran, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
		})
		expect({ ...seen(run, "safe"), wire }, run.stderr).toEqual({
			out: ["404 True True 404 False HTTP 404: gone", "201 u1 True 201 True"],
			ran: true,
			wire: ["GET /users/missing", "GET /users/u1"],
		})
	})
})
