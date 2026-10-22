/**
 * The Java SDK's safe mode (bit 16, C4; C#'s errors.safe.test.ts analog): an error status lands in the call's
 * `Result<T>` as `Result.Err` beside its status and the response, and a 2xx as `Result.Ok`; every other failure (no
 * answer, an undecodable 2xx, a lapsed timeout, the caller's cancel, a refused connection, a throwing hook) still
 * throws. Driven through the `http-safe` driver (the one fixture key beyond the RULED three, flagged in the report),
 * observed as `JavaError` in the trace, whose `result` records each safe-mode return.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the pinned JDK and Gradle are here: a missing pin fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate compiles the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const MEMBERS: Call = {
	operation: "members.get",
	params: { org: "o", "user-id": "u" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
}
const USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

/** The `http-safe` SDK with the driver aimed at it; the driver must compile against it. */
function safe(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http-safe")
	expect(sdk.javac.diagnostics, sdk.javac.diagnostics.join("\n")).toEqual([])
	return sdk
}

/** `calls` under `script` against a server answering `replies`: the run and the hops. */
function drive(replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	return served(replies, async (server) => {
		const run = await safe().runCalls({ calls, setup: {} }, { url: server.url }, { script })
		return { hops: [...server.hops], run }
	})
}

/** `calls` against an origin that refuses every connection: REFUSED_URL, never a server this test closed. */
function refused(calls: readonly Call[]) {
	return safe().runCalls({ calls, setup: {} }, { url: REFUSED_URL }, { script: {} })
}

type Traced = Trace<JavaError>["calls"][number]
/** The first call's error, and its safe-mode result if the method returned one. */
const first = (traced: readonly Traced[] | undefined) => traced?.[0]

/** A Java error as the trace records it: no inner, not canceled, the safe-mode return unless given. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
const statusChain = (type: string) => [type, "ApiException", "HoneyException"]
/** A safe-mode result holding an error status, or one holding a 2xx's data. */
const missed = (status: number) => ({ data: false, ok: false, response: true, status })
const hit = (status: number) => ({ data: true, ok: true, response: true, status })

/** A 404 keyed `member.missing` as the trace reads it from a safe-mode result: the server's key, no member. */
const MISSING = plain({
	chain: statusChain("NotFoundException"),
	key: "member.missing",
	keyMember: null,
	message: "gone",
	status: 404,
	text: "HTTP 404: gone",
	type: "NotFoundException",
	via: "result",
})

describe.skipIf(!JAVA)("safe mode: an error status in Result.Err, every other failure thrown", SLOW, () => {
	// ported: csharp errors.safe.test.ts:73 (the 404 beside its status and response)
	it("puts a 404 in Result.Err beside its status and response, its error and its observed body", async () => {
		const { run } = await drive([{ json: { message: "m" }, status: 404 }], [MEMBERS])
		const call = first(run.trace?.calls)
		expect({ error: call?.error, observed: run.observed, result: call?.result }, run.stderr).toEqual({
			error: plain({
				chain: statusChain("NotFoundException"),
				key: null,
				keyMember: null,
				message: "m",
				status: 404,
				text: "HTTP 404: m",
				type: "NotFoundException",
				via: "result",
			}),
			observed: [{ body: { message: "m" }, errorKey: null, kind: "error", status: 404 }],
			result: missed(404),
		})
	})

	it("holds a 201 in Result.Ok as its data, with no error", async () => {
		const { run } = await drive([{ json: { id: "u1" }, status: 201 }], [USER])
		const call = first(run.trace?.calls)
		expect({ error: call?.error, observed: run.observed, result: call?.result }, run.stderr).toEqual({
			error: undefined,
			observed: [{ data: { id: "u1" }, kind: "data", status: 201 }],
			result: hit(201),
		})
	})

	// ported: csharp errors.safe.test.ts:73 (the undecodable 2xx, a lapsed timeout, a cancel, a refused connection, a hook)
})

describe.skipIf(!JAVA)("safe mode: every other failure thrown, none in the result", SLOW, () => {
	it("throws an undecodable 2xx as DecodeException, with no result", async () => {
		const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
		const { run } = await drive([torn], [USER])
		expect({ error: first(run.trace?.calls)?.error, result: first(run.trace?.calls)?.result }, run.stderr).toEqual({
			error: plain({
				chain: ["DecodeException", "HoneyException"],
				inner: "UnexpectedEndOfInputException",
				text: expect.stringMatching(
					/^GET \/users\/\{id\}: the answer does not decode: Unexpected end-of-input within\/between Object entries\n/,
				),
				type: "DecodeException",
			}),
			result: undefined,
		})
	})

	it("throws a lapsed per-call timeout as ApiTimeoutException, with no status and no result", async () => {
		const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
		const { run } = await drive([late], [{ ...MEMBERS, timeoutMs: 300 }])
		expect({ error: first(run.trace?.calls)?.error, result: first(run.trace?.calls)?.result }, run.stderr).toEqual({
			error: plain({
				chain: ["ApiTimeoutException", "HoneyException"],
				inner: expect.stringMatching(/^(TimeoutException|CompletionException|CancellationException)$/),
				text: "GET /orgs/{org}/users/{user-id} timed out after 300 ms",
				type: "ApiTimeoutException",
			}),
			result: undefined,
		})
	})

	it("throws the caller's cancel with canceled set, and no request sent", async () => {
		const script: Script = { calls: [{ cancel: "before" }] }
		const { hops, run } = await drive([], [MEMBERS], script)
		expect({ canceled: first(run.trace?.calls)?.error?.canceled, hops: hops.length }, run.stderr).toEqual({
			canceled: true,
			hops: 0,
		})
	})
})

describe.skipIf(!JAVA)("safe mode: a failure outside the exchange thrown, none in the result", SLOW, () => {
	it("throws a refused connection as ApiConnectionException, with no result", async () => {
		const run = await refused([MEMBERS])
		expect({ error: first(run.trace?.calls)?.error, result: first(run.trace?.calls)?.result }, run.stderr).toEqual({
			error: plain({
				chain: ["ApiConnectionException", "HoneyException"],
				inner: "ConnectException",
				text: "GET /orgs/{org}/users/{user-id}: ConnectException",
				type: "ApiConnectionException",
			}),
			result: undefined,
		})
	})

	it("throws a failing request hook as HookException before any request is sent", async () => {
		const { hops, run } = await drive([], [MEMBERS], { hooks: { request: [{ fail: "boom" }] } })
		expect({ error: first(run.trace?.calls)?.error, hops: hops.length }, run.stderr).toEqual({
			error: plain({
				chain: ["HookException", "HoneyException"],
				inner: "IllegalStateException",
				text: "hook: boom",
				type: "HookException",
			}),
			hops: 0,
		})
	})
})

describe.skipIf(!JAVA)("Result.Err's read of the server's key, from a safe-mode result", SLOW, () => {
	// ported: csharp errors.safe.test.ts:108 (http declares no keys, so no member names the key)
	it("reads the server's key in a safe-mode result, with no keyMember for an API that declares none", async () => {
		const missing: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
		const { run } = await drive([missing], [MEMBERS])
		const call = first(run.trace?.calls)
		expect({ error: call?.error, result: call?.result }, run.stderr).toEqual({ error: MISSING, result: missed(404) })
	})
})
