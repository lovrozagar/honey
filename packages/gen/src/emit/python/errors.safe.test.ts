/**
 * The Python SDK's safe mirror (bit 21 i2; contract 29 §5.8, G21): `client.safe.<group>.<op>` answers `Ok(data,
 * response)` or `Err(error, response)`. The Err holds the error the normal call raises for an answer: an error
 * status (its status error, the body at `.body`), or a 2xx that does not decode or is past the size cap
 * (`DecodeError`, R-i1); its response is the call's `RawResponse`. Every failure with no answer (a timeout, a cancel,
 * a refused connection) still raises (f2). Driven through the `http` driver's `safe` mirror on `AsyncSDK` and `SDK`
 * with one expectation (G17), and a `safe` consumer program narrowing with `match` on both clients.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
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

/** The `http` SDK with the driver aimed at it (it must import). */
function driven(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("http")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` through `client`'s safe mirror under `script` against a server answering `replies`: the run and the hops. */
function drive(client: Client, replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	return served(replies, async (server) => {
		const run = await driven().runCalls({ calls, setup: {} }, { url: server.url }, { client, safe: true, script })
		return { hops: [...server.hops], run }
	})
}

/** `calls` through `client`'s safe mirror against an origin that refuses every connection. */
async function refused(client: Client, calls: readonly Call[]) {
	return driven().runCalls({ calls, setup: {} }, { url: REFUSED_URL }, { client, safe: true, script: {} })
}

type Traced = Trace<PythonError>["calls"][number]
/** Where a safe call's failure landed: its route, class and status, and its result's summary. */
const landed = (call: Traced | undefined) => [call?.error?.via, call?.error?.type, call?.error?.status, call?.result]
/** An Err, its response on `status`. */
const err = (status: number) => ({ data: false, ok: false, response: true, status })

/** A 404 keyed `member.missing` as the trace reads it from an Err: the server's key, no member. */
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

describe.skipIf(!PY)("client.safe: an answer in the Err, every failure with no answer raised", SLOW, () => {
	// v0: 0eb688f708
	it.each(CLIENTS)(
		"%s: a 404, an undecodable 2xx and one past the cap are each an Err with its response; a timeout, a cancel and a refused connection raise",
		async (client) => {
			/* G3/G21: v0's response: httpx.Response is RawResponse; its status is kept (H4) */
			const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
			const big: Reply = { json: { id: "u", name: "x".repeat(64) }, status: 200 }
			const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
			const replies: Reply[] = [{ json: { message: "m" }, status: 404 }, torn, big, late]
			const calls = [MEMBERS, USER, USER, { ...MEMBERS, timeoutMs: 300 }, MEMBERS]
			const script: Script = { calls: [null, null, null, null, { cancel: "before" }], config: { maxResponseBytes: 32 } }
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
				hops: 4,
				landed: [
					["result", "NotFoundError", 404, err(404)],
					["result", "DecodeError", undefined, err(200)],
					["result", "DecodeError", undefined, err(200)],
					["return", "APITimeoutError", undefined, undefined],
					["return", "CanceledError", undefined, undefined],
					["return", "APIConnectionError", undefined, undefined],
				],
				observed: [
					[
						{ body: { message: "m" }, errorKey: null, kind: "error", status: 404 },
						{ kind: "decode", status: 200 },
						{ kind: "decode", status: 200 },
						{ kind: "timeout" },
						null,
					],
					[{ kind: "transport" }],
				],
			})
		},
	)
})

describe.skipIf(!PY)("client.safe: what an Ok and an Err hold", SLOW, () => {
	it.each(CLIENTS)("%s: each Ok holds its own answer's data, never an earlier call's", async (client) => {
		const users = [
			{ id: "u1", name: "a" },
			{ id: "u2", name: "b" },
		]
		const { run } = await drive(
			client,
			users.map((json) => ({ json, status: 200 })),
			[USER, USER],
		)
		expect(run.observed, run.stderr).toEqual(users.map((data) => ({ data, kind: "data", status: 200 })))
	})

	it.each(CLIENTS)("%s: reads the server's key in an Err, no member for an API that declares none", async (client) => {
		/* http declares no keys: the declared-member path is errors.test.ts's, shared by both styles */
		const missing: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
		const { run } = await drive(client, [missing], [MEMBERS])
		const call = run.trace?.calls[0]
		expect({ error: call?.error, result: call?.result }, run.stderr).toEqual({ error: MISSING, result: err(404) })
	})
})

/** The `safe` consumer: users.get answered 404, 201, then an undecodable 200, on `SDK` and then on `AsyncSDK`. */
const SAFE = `section("safe")


def summary(r):
    match r:
        case sdk.Ok(data, response):
            return f"ok {data['id']} {response.status}"
        case sdk.Err(sdk.NotFoundError() as e, response):
            return f"404 {e.status} {e.body!r} {response.status} {response.body == e.body}"
        case sdk.Err(sdk.DecodeError() as e, response):
            return f"decode {e} {response.status}"
    return f"unmatched {r!r}"


c = client()
for name in ("missing", "u1", "torn"):
    note(summary(c.safe.users.get(name)))
c.close()
a = aclient()
for name in ("missing", "u1", "torn"):
    note(summary(await a.safe.users.get(name)))
await a.aclose()`

const SAFE_REPLIES: readonly Reply[] = [
	{ json: { message: "not found" }, status: 404 },
	{ json: { id: "u1" }, status: 201 },
	{ headers: { "content-type": "application/json" }, status: 200, text: "{" },
]

const safeRun = once(() =>
	served([...SAFE_REPLIES, ...SAFE_REPLIES], async (server) => {
		const run = await consume("http", "safe", { base: server.url, body: SAFE })
		return { run, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
	}),
)

describe.skipIf(!PY)("Ok and Err from a consumer program, narrowed by match", SLOW, () => {
	// v0: 0eb688f708
	it("matches a 404's NotFoundError with its body and response, a 201's data, an undecodable 200's DecodeError, on SDK and AsyncSDK", async () => {
		const { run, wire } = await safeRun()
		const answered = [
			`404 404 b'{"message":"not found"}' 404 True`,
			"ok u1 201",
			"decode HTTP 200: the body is not JSON 200",
		]
		const sent = ["GET /users/missing", "GET /users/u1", "GET /users/torn"]
		expect({ ...seen(run, "safe"), wire }, run.stderr).toEqual({
			out: [...answered, ...answered],
			ran: true,
			wire: [...sent, ...sent],
		})
	})
})
