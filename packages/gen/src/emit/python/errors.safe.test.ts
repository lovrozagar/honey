/**
 * The Python SDK's safe mode (contract 29 §5.8, G21): an error status lands in `SDKResult.error` beside its
 * `status` (v0's, restored; H4) and the `RawResponse`, and every other failure (no answer, a timeout, a cancel, an
 * undecodable 2xx) still raises. Driven through the `http-safe` driver on `AsyncSDK` and `SDK` with one expectation
 * (G17), and a `safe` consumer program on both clients.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, recordingServer, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, once, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

const MEMBERS: Call = {
	operation: "members.get",
	params: { org: "o", "user-id": "u" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
}
const USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

/** The `http-safe` SDK with the driver aimed at it (it must import), on `client`. */
function on(client: Client): { readonly client: Client; readonly sdk: DrivenPythonSdk } {
	const sdk = drivenPythonSdk("http-safe")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return { client, sdk }
}

/** `calls` on `client` under `script` against a server answering `replies`: the run and the hops. */
function drive(client: Client, replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	return served(replies, async (server) => {
		const run = await on(client).sdk.runCalls({ calls, setup: {} }, { url: server.url }, { client, script })
		return { hops: [...server.hops], run }
	})
}

/** `calls` on `client` against an origin that refuses every connection. */
async function refused(client: Client, calls: readonly Call[]) {
	const closed = await recordingServer([])
	await closed.close()
	return on(client).sdk.runCalls({ calls, setup: {} }, { url: closed.url }, { client, script: {} })
}

type Traced = Trace<PythonError>["calls"][number]
/** Where a safe-mode call's failure landed: its route, class and status, and its result's summary. */
const landed = (call: Traced | undefined) => [call?.error?.via, call?.error?.type, call?.error?.status, call?.result]
/** A safe-mode result holding an error status. */
const missed = (status: number) => ({ data: false, ok: false, response: true, status })

/** A 404 keyed `member.missing` as the trace reads it from a safe-mode result: the server's key, no member. */
const MISSING = {
	cause: null,
	chain: ["NotFoundError", "APIStatusError", "HoneyError"],
	key: "member.missing",
	keyMember: null,
	message: "gone",
	repr: expect.any(String),
	status: 404,
	text: "HTTP 404: gone",
	type: "NotFoundError",
	via: "result",
}

describe.skipIf(!PY)("safe mode: an error status in SDKResult.error, every other failure raised", SLOW, () => {
	// v0: 0eb688f708
	it.each(CLIENTS)(
		"%s: puts a 404 in the result beside its status and response; an undecodable 2xx, a timeout, a cancel and a refused connection raise",
		async (client) => {
			/* G3/G21: v0's response: httpx.Response is RawResponse; its status is kept (H4) */
			const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
			const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
			const replies: Reply[] = [{ json: { message: "m" }, status: 404 }, torn, late]
			const calls = [MEMBERS, USER, { ...MEMBERS, timeoutMs: 300 }, MEMBERS]
			const script: Script = { calls: [null, null, null, { cancel: "before" }] }
			const { hops, run } = await drive(client, replies, calls, script)
			const lost = await refused(client, [MEMBERS])
			expect(
				{
					hops: hops.length,
					landed: [...(run.trace?.calls ?? []), ...(lost.trace?.calls ?? [])].map(landed),
					observed: [run.observed, lost.observed],
				},
				run.stderr + lost.stderr,
			).toEqual({
				hops: 3,
				landed: [
					["result", "NotFoundError", 404, missed(404)],
					["return", "DecodeError", undefined, undefined],
					["return", "APITimeoutError", undefined, undefined],
					["return", "CanceledError", undefined, undefined],
					["return", "APIConnectionError", undefined, undefined],
				],
				observed: [
					[{ body: { message: "m" }, errorKey: null, kind: "error", status: 404 }, null, { kind: "timeout" }, null],
					[null],
				],
			})
		},
	)

	it.each(CLIENTS)(
		"%s: reads the server's key in a safe-mode result, no member for an API that declares none",
		async (client) => {
			/* http declares no keys: the declared-member path is errors.test.ts's, shared by both modes */
			const missing: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
			const { run } = await drive(client, [missing], [MEMBERS])
			const call = run.trace?.calls[0]
			expect({ error: call?.error, result: call?.result }, run.stderr).toEqual({ error: MISSING, result: missed(404) })
		},
	)
})

/** The `safe` consumer: users.get answered 404 then 201, on `SDK` and then on `AsyncSDK`. */
const SAFE = `section("safe")


def summary(r):
    return f"{isinstance(r, sdk.SDKResult)} {r.status} {r.data is None} {isinstance(r.error, sdk.NotFoundError)} {isinstance(r.response, sdk.RawResponse)} {r.response.status}"


def found(r):
    return f"{r.data['id'] if r.data else None} {r.error is None} {r.status} {r.response.status}"


c = client()
note(summary(c.users.get("missing")))
note(found(c.users.get("u1")))
c.close()
a = aclient()
note(summary(await a.users.get("missing")))
note(found(await a.users.get("u1")))
await a.aclose()`

const SAFE_REPLIES: readonly Reply[] = [
	{ json: { message: "not found" }, status: 404 },
	{ json: { id: "u1" }, status: 201 },
	{ json: { message: "not found" }, status: 404 },
	{ json: { id: "u1" }, status: 201 },
]

const safeRun = once(() =>
	served(SAFE_REPLIES, async (server) => {
		const run = await consume("http-safe", "safe", { base: server.url, body: SAFE })
		return { run, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
	}),
)

describe.skipIf(!PY)("SDKResult from a consumer program (http-safe)", SLOW, () => {
	// v0: 0eb688f708
	it("holds a 404 as error with its status and RawResponse, a 201 as data, on SDK and AsyncSDK", async () => {
		const { run, wire } = await safeRun()
		const answered = ["True 404 True True True 404", "u1 True 201 201"]
		expect({ ...seen(run, "safe"), wire }, run.stderr).toEqual({
			out: [...answered, ...answered],
			ran: true,
			wire: ["GET /users/missing", "GET /users/u1", "GET /users/missing", "GET /users/u1"],
		})
	})
})
