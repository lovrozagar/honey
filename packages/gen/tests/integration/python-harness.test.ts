/**
 * The v0 Python SDK integration harness, ported: the emitted Python SDK for core's served document, gated
 * (`servedPythonSdk`, imported), with the fixed reflection driver, against core's live reference app (spawned by
 * `conformance/harness.ts`; gen never imports core). Each case is one or more driver runs on both clients (G17),
 * in script mode where it needs hooks, a log, directives or a trace. The WebSocket cases are in
 * `python-harness.ws.test.ts`. Opt-in: `vitest run --mode harness`.
 */
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { program } from "../../src/emit/python/__fixtures__/consumer.ts"
import { type DrivenPythonSdk, servedPythonSdk } from "../../src/emit/python/__fixtures__/driven.ts"
import { withPython } from "../../src/emit/python/__fixtures__/python-env.ts"
import type { PythonError, Script, Trace } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"
import type { Call, Json, Observed, Setup, WireHop } from "./conformance/matrix.ts"

type Client = (typeof CLIENTS)[number]
type Drive = { calls: readonly Call[]; setup?: Setup }
type Run = { hops: readonly WireHop[]; observed: readonly Observed[]; trace?: Trace<PythonError> }

const CLIENTS = ["async", "sync"] as const
const VALID: Setup = { auth: { kind: "bearer", token: "valid-token" } }
const EXPIRED: Setup = { auth: { kind: "bearer", token: "expired-token" } }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const USER_ID = /^user-\d+$/
const OCTET = "application/octet-stream"
const MIB = 1 << 20
/** The custom credential header of Tests F and G: the name as given, no prefix. */
const API_KEY = { authHeaderName: "X-API-Key", authHeaderPrefix: "" }

const call = (operation: string, method: string, path: string, more: Partial<Call> = {}): Call => ({
	operation,
	route: { method, path },
	...more,
})
const createUser = (value: Json) => call("users.create", "POST", "/v1/secure/users", { body: { kind: "json", value } })
const getUser = (id: string) => call("users.get", "GET", "/v1/secure/users/:id", { params: { id } })
const listUsers = () => call("users.list", "GET", "/v1/secure/users")
const updateUser = (id: string, value: Json) =>
	call("users.update", "PUT", "/v1/secure/users/:id", { body: { kind: "json", value }, params: { id } })
const echo = (more: Partial<Call> = {}) => call("echo.get", "GET", "/v1/echo", more)
const blob = (size: number) =>
	call("uploads.blob", "POST", "/v1/secure/uploads/blob", { body: { contentType: OCTET, kind: "binary", size } })
const idempotent = (more: Partial<Call> = {}) => call("idempotent.create", "POST", "/v1/idempotent", more)
const slow = (ms: number) => call("timing.slow", "GET", "/v1/slow", { search: { ms } })
const declared = (status: string) =>
	call("errors.declared", "GET", "/v1/declared-errors/:status", { params: { status } })

let reference: ReferenceApp | undefined
let pythonSdk: DrivenPythonSdk | undefined

/** The running app and the gated SDK. */
function live(): { app: ReferenceApp; sdk: DrivenPythonSdk } {
	if (!reference || !pythonSdk) throw new Error("the reference app or the Python SDK is not ready")
	return { app: reference, sdk: pythonSdk }
}

/** One driver run of `cell` on `client` (under `script`), and the requests the app received meanwhile. */
async function drive(cell: Drive, client: Client, script?: Script): Promise<Run> {
	const { app, sdk } = live()
	const since = await app.mark()
	const run = await sdk.runCalls(cell, { alt: app.alt, url: app.url }, { client, script })
	expect(run.status, run.stderr).toBe(0)
	return { hops: await app.wire(since), observed: run.observed as readonly Observed[], trace: run.trace }
}

/** `drive` under `script`, its trace required. */
async function scripted(cell: Drive, client: Client, script: Script): Promise<Run & { trace: Trace<PythonError> }> {
	const run = await drive(cell, client, script)
	if (run.trace === undefined) throw new Error("a scripted run printed no trace")
	return { ...run, trace: run.trace }
}

/** The data a `data` observation carries. */
function dataOf(observed: Observed | undefined): Record<string, Json> {
	if (observed?.kind !== "data") throw new Error(`not a data observation: ${JSON.stringify(observed)}`)
	return observed.data as Record<string, Json>
}

/** The app's error envelope, as a call observes its body. */
const envelope = (status: number, key: string, message: string): Json => ({
	error_key: key,
	fields: {},
	message,
	request_id: "conformance",
	status,
	status_key: key,
	success: false,
})

/** The app's 401, as a call observes it. */
const UNAUTHORIZED: Observed = {
	body: envelope(401, "unauthorized", "Authentication required"),
	errorKey: "unauthorized",
	kind: "error",
	status: 401,
}

/** An `APIStatusError` subclass the method raised, as the trace records it. */
const statusError = (type: string, status: number, key: string, message: string): PythonError => ({
	cause: null,
	chain: [type, "APIStatusError", "HoneyError"],
	key,
	keyMember: key.toUpperCase(),
	message,
	repr: `${type}('HTTP ${status}: ${message}')`,
	status,
	text: `HTTP ${status}: ${message}`,
	type,
	via: "return",
})

/** Each hop's value of the header `name` (lower case), `undefined` where it is absent. */
const headerOf = (hops: readonly WireHop[], name: string) => hops.map((h) => h.headers[name])

/**
 * Test L's consumer program on `client`: a `users.create` with no name, and what its `BadRequestError` shows that
 * the driver cannot: the raw body's type (bytes, errors.py) beside the envelope, a TypedDict view of it (d0efb2c).
 */
async function badRequestShown(client: Client): Promise<Json[]> {
	const { app, sdk } = live()
	const create = `c.users.create({"email": "lp-${client}@py.test"})`
	const body = [
		"def show(e: sdk.BadRequestError) -> list[object]:",
		"    env, kind = e.envelope, type(e.body).__name__",
		"    shown = [type(e).__name__, e.status, str(e.key), kind, json.loads(e.body)['error_key'], type(env).__name__]",
		"    return [*shown, env.get('message'), sorted(env.get('fields') or {})]",
		`${client === "sync" ? "with client" : "async with aclient"}(bearer_token="valid-token") as c:`,
		"    try:",
		`        ${client === "sync" ? create : `await ${create}`}`,
		"    except sdk.BadRequestError as e:",
		"        note(show(e))",
	].join("\n")
	const ran = await sdk.exec(program(sdk.package, `l-${client}`, body), JSON.stringify({ base: app.url }))
	expect(ran.status, ran.stderr).toBe(0)
	return ((JSON.parse(ran.stdout) as Record<string, string[]>).main ?? []).map((line) => JSON.parse(line) as Json)
}

/** Whether Python is here: a missing one fails where it is required and skips this file elsewhere (python-env). */
const PY = withPython()
const pyDescribe = describe.skipIf(!PY)

beforeAll(async () => {
	if (!PY) return
	reference = await startReferenceApp()
	pythonSdk = servedPythonSdk(reference.document)
	expect(pythonSdk.imported, pythonSdk.stderr).toBe(true)
})

afterAll(() => reference?.stop())

pyDescribe("round trip", () => {
	// v0: 141513c590
	it.each(CLIENTS)("%s: creates a user, then a second run reads the same user back by its id", async (client) => {
		/* port shape: v0 drove SDK alone; both clients run now (G2/G17), and v0's one program is two driver runs (bit-12 Fe2) */
		const email = `rt-${client}@py.test`
		const created = await drive({ calls: [createUser({ email, name: "Alice" })], setup: VALID }, client)
		expect(created.observed).toEqual([
			{ data: { email, id: expect.stringMatching(USER_ID), name: "Alice" }, kind: "data", status: 201 },
		])
		const id = dataOf(created.observed[0]).id as string
		const fetched = await drive({ calls: [getUser(id)], setup: VALID }, client)
		expect(fetched.observed).toEqual([{ data: dataOf(created.observed[0]), kind: "data", status: 200 }])
		const hops = [...created.hops, ...fetched.hops]
		expect(hops.map((h) => [h.method, h.url, h.headers.authorization, h.body.json ?? null])).toEqual([
			["POST", "/v1/secure/users", "Bearer valid-token", { email, name: "Alice" }],
			["GET", `/v1/secure/users/${id}`, "Bearer valid-token", null],
		])
	})
})

pyDescribe("OnAuthExpired", () => {
	it.each(CLIENTS)(
		"%s: retries a 401 once with the refreshed token, replaying the JSON body, then keeps that token",
		async (client) => {
			const email = `ae-${client}@py.test`
			const run = await scripted({ calls: [createUser({ email, name: "Ae" }), listUsers()], setup: EXPIRED }, client, {
				onAuthExpired: { tokens: ["valid-token"] },
			})
			const user = dataOf(run.observed[0])
			expect(run.observed).toEqual([
				{ data: { email, id: expect.stringMatching(USER_ID), name: "Ae" }, kind: "data", status: 201 },
				{ data: expect.arrayContaining([user]), kind: "data", status: 200 },
			])
			expect([run.trace.authExpired, headerOf(run.hops, "authorization")]).toEqual([
				1,
				["Bearer expired-token", "Bearer valid-token", "Bearer valid-token"],
			])
			expect(run.hops[1]?.body).toEqual(run.hops[0]?.body)
		},
	)

	it.each(CLIENTS)(
		"%s: does not retry a one-shot body the first attempt consumed: the 401 surfaces",
		async (client) => {
			const run = await scripted({ calls: [blob(1)], setup: EXPIRED }, client, {
				calls: [{ oneShotBody: true }],
				onAuthExpired: { tokens: ["valid-token"] },
			})
			expect([run.observed, run.trace.authExpired, headerOf(run.hops, "transfer-encoding")]).toEqual([
				[UNAUTHORIZED],
				0,
				["chunked"],
			])
		},
	)
})

pyDescribe("auth headers", () => {
	// v0: f53a360f0d
	it.each(CLIENTS)(
		"%s: sends the bearer token as Authorization: Bearer by default, and no x-api-key",
		async (client) => {
			const run = await drive({ calls: [echo()], setup: { auth: { kind: "bearer", token: "my-token" } } }, client)
			const hop = run.hops[0]
			expect([run.hops.length, hop?.headers.authorization, hop?.headers["x-api-key"]]).toEqual([
				1,
				"Bearer my-token",
				undefined,
			])
			expect(dataOf(run.observed[0])).toEqual({ method: "GET", requestId: hop?.headers["x-request-id"] })
		},
	)

	// v0: 53dc868c80
	it.each(CLIENTS)("%s: sends the token bare under a custom header name, and no Authorization", async (client) => {
		const run = await scripted({ calls: [echo()], setup: { auth: { kind: "bearer", token: "my-token" } } }, client, {
			config: API_KEY,
		})
		const hop = run.hops[0]
		expect([run.hops.length, hop?.headers["x-api-key"], hop?.headers.authorization]).toEqual([1, "my-token", undefined])
		expect(dataOf(run.observed[0])).toEqual({ method: "GET", requestId: hop?.headers["x-request-id"] })
	})

	// v0: a689c74d5b
	it.each(CLIENTS)(
		"%s: refreshes a 401 once under a custom header name, retrying with the new token and never Authorization",
		async (client) => {
			/* port shape (Fe5): v0's retry answered 200 u1 from a MockTransport; the app checks Bearer only, so its answer is the second 401 and every SDK claim is on the wire */
			const script: Script = { config: API_KEY, onAuthExpired: { tokens: ["valid-token"] } }
			/* the credential last: a bearer under the custom name wins over a stale config header, which is never sent */
			const setups: Setup[] = [
				{ headers: { "X-API-Key": "expired-token" } },
				{ ...EXPIRED, headers: { "X-API-Key": "stale-config" } },
			]
			for (const setup of setups) {
				const run = await scripted({ calls: [listUsers()], setup }, client, script)
				expect([run.observed, run.trace.calls[0]?.error, run.trace.authExpired]).toEqual([
					[UNAUTHORIZED],
					statusError("UnauthorizedError", 401, "unauthorized", "Authentication required"),
					1,
				])
				expect([headerOf(run.hops, "x-api-key"), headerOf(run.hops, "authorization")]).toEqual([
					["expired-token", "valid-token"],
					[undefined, undefined],
				])
			}
		},
	)
})

pyDescribe("typed errors", () => {
	// v0: 8a4f857181
	it.each(CLIENTS)(
		"%s: raises BadRequestError for a 400 with its typed envelope, field errors and bytes body",
		async (client) => {
			const fields = { name: [{ error_key: "required", message: "name is required", path: "name" }] }
			const run = await scripted({ calls: [createUser({ email: `l-${client}@py.test` })], setup: VALID }, client, {
				calls: [{ envelope: true }],
			})
			expect(run.observed).toEqual([
				{
					body: {
						error_key: "invalid_input",
						fields,
						message: "Invalid input",
						request_id: "conformance",
						status: 400,
						status_key: "bad_request",
						success: false,
					},
					errorKey: "invalid_input",
					kind: "error",
					status: 400,
				},
			])
			/* V0BUG: v0's .data slot was its declared red gate and its "bad" came from its MockTransport handler; G6 pins the typed envelope, and the app sends "Invalid input" */
			const extraKeys = ["request_id", "success"]
			expect(run.trace.calls[0]?.error).toEqual({
				...statusError("BadRequestError", 400, "invalid_input", "Invalid input"),
				envelope: {
					error_key: "invalid_input",
					extraKeys,
					fields,
					message: "Invalid input",
					status: 400,
					status_key: "bad_request",
				},
			})
			const plain = await scripted({ calls: [declared("400")] }, client, { calls: [{ envelope: true }] })
			expect([plain.observed, plain.trace.calls[0]?.error?.envelope]).toEqual([
				[{ body: envelope(400, "bad_request", "Bad request"), errorKey: "bad_request", kind: "error", status: 400 }],
				{ error_key: "bad_request", extraKeys, message: "Bad request", status: 400, status_key: "bad_request" },
			])
			expect(await badRequestShown(client)).toEqual([
				["BadRequestError", 400, "invalid_input", "bytes", "invalid_input", "dict", "Invalid input", ["name"]],
			])
		},
	)
})

pyDescribe("cancellation", () => {
	// v0: a63ac3d393
	it.each(CLIENTS)("%s: ends a call canceled before it starts as CanceledError, with nothing sent", async (client) => {
		/* V0BUG: v0's sync path raised asyncio.CancelledError (a BaseException) and accepted CancelledError or RuntimeError; v1 raises CanceledError(HoneyError) on both clients, and v0's cancel_token= is options["cancel"] (G3) */
		const run = await scripted(
			{ calls: [createUser({ email: `o-${client}@py.test`, name: "O" })], setup: VALID },
			client,
			{ calls: [{ cancel: "before" }] },
		)
		expect([run.observed, run.trace.calls[0]?.error, run.hops.length]).toEqual([
			[null],
			{
				cause: null,
				chain: ["CanceledError", "HoneyError"],
				repr: "CanceledError('the call was canceled')",
				text: "the call was canceled",
				type: "CanceledError",
				via: "return",
			},
			0,
		])
	})

	// v0: 8d3db8d7c7
	it("async: cancelling the call's task mid-flight raises CancelledError at once, the request already sent", async () => {
		const run = await scripted({ calls: [slow(5000)] }, "async", { calls: [{ taskCancel: { afterMs: 100 } }] })
		expect([run.observed, run.trace.calls[0]?.error]).toEqual([
			[null],
			{
				cause: null,
				chain: ["CancelledError"],
				repr: "CancelledError()",
				text: "",
				type: "CancelledError",
				via: "return",
			},
		])
		expect(run.trace.calls[0]?.elapsedMs).toBeLessThan(1000)
		expect(run.hops.map((h) => [h.method, h.url])).toEqual([["GET", "/v1/slow?ms=5000"]])
	})
})

pyDescribe("request headers", () => {
	// v0: cdc60f35b5
	it.each(CLIENTS)(
		"%s: sends a fresh UUIDv4 X-Request-Id per call, then the config's, the call's, and a hook's as one value",
		async (client) => {
			const auto = await drive({ calls: [echo(), echo(), echo({ headers: { "x-request-id": "from-call" } })] }, client)
			const ids = headerOf(auto.hops, "x-request-id")
			expect(ids).toEqual([expect.stringMatching(UUID_V4), expect.stringMatching(UUID_V4), "from-call"])
			expect(ids[0]).not.toBe(ids[1])
			expect(auto.observed.map((o) => dataOf(o).requestId)).toEqual(ids)
			const config = await drive({ calls: [echo()], setup: { headers: { "x-request-id": "from-config" } } }, client)
			expect(headerOf(config.hops, "x-request-id")).toEqual(["from-config"])
			/* V1 defect found (Fe7): a hook's header in another case duplicated the call's; v0's hook wrote lower case, so v0 never hit it */
			const hook = await scripted({ calls: [echo({ headers: { "x-request-id": "from-call" } })] }, client, {
				hooks: { request: [{ setHeader: ["X-Request-Id", "from-hook"] }] },
			})
			expect([headerOf(hook.hops, "x-request-id"), dataOf(hook.observed[0]).requestId]).toEqual([
				["from-hook"],
				"from-hook",
			])
		},
	)

	// v0: 0af35a7b1b
	it.each(CLIENTS)(
		"%s: gives an x-idempotency-key op an auto UUIDv4 key, honors the call's key, and a caller header wins",
		async (client) => {
			/* test text: v0's UUID regex had no version nibble; v1 pins V4 */
			const run = await scripted(
				{ calls: [idempotent(), idempotent(), idempotent({ headers: { "Idempotency-Key": "header-wins-key" } })] },
				client,
				{ calls: [null, { idempotencyKey: "user-supplied-key-123" }, { idempotencyKey: "should-be-ignored" }] },
			)
			const keys = [expect.stringMatching(UUID_V4), "user-supplied-key-123", "header-wins-key"]
			expect(run.observed.map((o) => dataOf(o).idempotencyKey)).toEqual(keys)
			expect(headerOf(run.hops, "idempotency-key")).toEqual(run.observed.map((o) => dataOf(o).idempotencyKey))
		},
	)
})

pyDescribe("hooks and logging", () => {
	// v0: a342f63647
	// v0: e41ce2f1e8
	it.each(CLIENTS)(
		"%s: runs request hooks in declaration order, both headers sent, then response hooks in order",
		async (client) => {
			/* port shape: the async row is Test X's coroutine hooks, the sync row Test Y's; v0's recorder [200, "r2"] is the trace's [phase, index, status] */
			const run = await scripted({ calls: [getUser("user-0")], setup: VALID }, client, {
				hooks: {
					request: [{ setHeader: ["X-Hook-1", "a"] }, { setHeader: ["X-Hook-2", "b"] }],
					response: [{}, {}],
				},
			})
			expect(run.observed).toEqual([
				{ data: { email: "taken@example.com", id: "user-0", name: "Taken" }, kind: "data", status: 200 },
			])
			expect([headerOf(run.hops, "x-hook-1"), headerOf(run.hops, "x-hook-2")]).toEqual([["a"], ["b"]])
			expect(run.trace.hooks.map((h) => [h.phase, h.index, h.status ?? null])).toEqual([
				["request", 0, null],
				["request", 1, null],
				["response", 0, 200],
				["response", 1, 200],
			])
		},
	)

	// v0: 2a085318f0
	it.each(CLIENTS)(
		"%s: logs request_start, then response_received with the status and a duration, under METHOD <path template>",
		async (client) => {
			/* app difference: v0's mock spec logged "POST /users" and 200; the served document's template is /v1/secure/users, and the app answers 201 */
			const run = await scripted(
				{ calls: [createUser({ email: `log-${client}@py.test`, name: "Log" })], setup: VALID },
				client,
				{ log: true, logDurations: true },
			)
			const operation = "POST /v1/secure/users"
			expect(run.trace.log).toEqual([
				{ durationMs: 0, event: "request_start", level: "debug", operation },
				{ durationMs: expect.any(Number), event: "response_received", level: "info", operation, status: 201 },
			])
			const duration = run.trace.log[1]?.durationMs
			expect([Number.isInteger(duration), (duration ?? -1) >= 0]).toEqual([true, true])
		},
	)
})

pyDescribe("invalidation", () => {
	// v0: 2e02bd7a3f
	it.each(CLIENTS)(
		"%s: marks the GETs a mutation invalidates stale, a templated pattern matching the interpolated path",
		async (client) => {
			/* surface change (bit-12 dfabed1f02, bit-13 Fe4): v0's public is_stale(method, path) is read through the hook trace, as TS, Go and Rust do */
			const z = `z-${client}`
			const calls = [
				listUsers(),
				getUser("user-0"),
				createUser({ email: `${z}@py.test`, name: "Zed" }),
				listUsers(),
				getUser("user-0"),
				updateUser(z, { name: "Zed" }),
				listUsers(),
				getUser(z),
				getUser("user-0"),
			]
			const run = await scripted({ calls, setup: VALID }, client, {
				config: { invalidation: { staleTimeMs: 60_000 } },
			})
			const seen = run.trace.hooks
				.filter((h) => h.phase === "request")
				.map((h) => [h.selector, h.isStale, h.invalidatedBy])
			expect(seen).toEqual([
				["GET /v1/secure/users", false, []],
				["GET /v1/secure/users/user-0", false, []],
				["POST /v1/secure/users", false, []],
				["GET /v1/secure/users", true, ["POST /v1/secure/users"]],
				["GET /v1/secure/users/user-0", false, []],
				[`PUT /v1/secure/users/${z}`, false, []],
				["GET /v1/secure/users", true, [`PUT /v1/secure/users/${z}`]],
				[`GET /v1/secure/users/${z}`, true, [`PUT /v1/secure/users/${z}`]],
				["GET /v1/secure/users/user-0", false, []],
			])
		},
	)
})

pyDescribe("streaming upload", () => {
	// v0: f8b49b0f4c
	it.each(CLIENTS)(
		"%s: streams a 1 MiB body of unknown length chunked, and the app answers its size and sha256",
		async (client) => {
			/* port shape: v0 drove AsyncSDK alone; both clients take an iterable body now (G4), and v0's hash is the app's sha256 */
			const sha256 = createHash("sha256")
				.update(Uint8Array.from({ length: MIB }, (_, i) => i & 0xff))
				.digest("hex")
			const run = await scripted({ calls: [blob(MIB)], setup: VALID }, client, { calls: [{ oneShotBody: true }] })
			expect(run.observed).toEqual([{ data: { sha256, size: MIB }, kind: "data", status: 200 }])
			const hop = run.hops[0]
			expect([hop?.body, hop?.headers["transfer-encoding"], hop?.headers["content-length"]]).toEqual([
				{ contentType: OCTET, sha256, size: MIB },
				"chunked",
				undefined,
			])
		},
	)
})
