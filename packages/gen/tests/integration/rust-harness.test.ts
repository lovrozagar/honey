/**
 * The v0 Rust SDK integration harness, ported: the emitted Rust SDK for core's served document, compiled
 * with the test driver (`servedRustSdk`, contract 21 Fe1), against core's live reference app (spawned by
 * `conformance/harness.ts`; gen never imports core). Each case is one or more driver runs, in script mode
 * where it needs hooks, a log, directives or a trace. Opt-in: `vitest run --mode harness`.
 */
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type DrivenRustSdk, servedRustSdk } from "../../src/emit/rust/__fixtures__/driven.ts"
import { withRust } from "../../src/emit/rust/__fixtures__/rust-env.ts"
import type { RustError, Script, Trace } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"
import type { Call, Json, Observed, Setup, WireHop } from "./conformance/matrix.ts"

type Drive = { calls: readonly Call[]; setup?: Setup }
type Run = { hops: readonly WireHop[]; observed: readonly Observed[]; trace?: Trace<RustError> }

const VALID: Setup = { auth: { kind: "bearer", token: "valid-token" } }
const EXPIRED: Setup = { auth: { kind: "bearer", token: "expired-token" } }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const USER_ID = /^user-\d+$/
const OCTET = "application/octet-stream"
const MIB = 1 << 20

const call = (operation: string, method: string, path: string, more: Partial<Call> = {}): Call => ({
	operation,
	route: { method, path },
	...more,
})
const createUser = (email: string, name: string) =>
	call("users.create", "POST", "/v1/secure/users", { body: { kind: "json", value: { email, name } } })
const getUser = (id: string) => call("users.get", "GET", "/v1/secure/users/:id", { params: { id } })
const listUsers = () => call("users.list", "GET", "/v1/secure/users")
const updateUser = (id: string, value: Json) =>
	call("users.update", "PUT", "/v1/secure/users/:id", { body: { kind: "json", value }, params: { id } })
const echo = (more: Partial<Call> = {}) => call("echo.get", "GET", "/v1/echo", more)
const blob = (size: number) =>
	call("uploads.blob", "POST", "/v1/secure/uploads/blob", { body: { contentType: OCTET, kind: "binary", size } })
const idempotent = (more: Partial<Call> = {}) => call("idempotent.create", "POST", "/v1/idempotent", more)
const wsEcho = (more: Partial<Call> = {}) => call("ws.echo", "GET", "/v1/ws/echo", more)

let reference: ReferenceApp | undefined
let rustSdk: DrivenRustSdk | undefined

/** The running app and the compiled SDK. */
function live(): { app: ReferenceApp; sdk: DrivenRustSdk } {
	if (!reference || !rustSdk) throw new Error("the reference app or the Rust SDK is not ready")
	return { app: reference, sdk: rustSdk }
}

/** One driver run of `cell` (under `script`), and the requests the app received meanwhile. */
async function drive(cell: Drive, script?: Script): Promise<Run> {
	const { app, sdk } = live()
	const since = await app.mark()
	const run = await sdk.runCalls(cell, { alt: app.alt, url: app.url }, script)
	expect(run.status, run.stderr).toBe(0)
	return { hops: await app.wire(since), observed: run.observed as readonly Observed[], trace: run.trace }
}

/** `drive` under `script`, its trace required. */
async function scripted(cell: Drive, script: Script): Promise<Run & { trace: Trace<RustError> }> {
	const run = await drive(cell, script)
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

/** A script registering the recording WebSocket handlers, closing with `close` when given. */
const wsOn = (close?: { code: number; reason: string }): Script => ({
	calls: [{ ws: close ? { close, on: true } : { on: true } }],
})

/** Whether Rust is here: a missing one fails where it is required and skips this file elsewhere (rust-env). */
const RUST = withRust()
const rustDescribe = describe.skipIf(!RUST)

beforeAll(async () => {
	if (!RUST) return
	reference = await startReferenceApp()
	rustSdk = servedRustSdk(reference.document)
	expect(rustSdk.built, rustSdk.stderr).toBe(true)
}, 600_000)

afterAll(() => reference?.stop())

rustDescribe("round trip", () => {
	// v0: 3718c0f69b
	it("creates a user, then a second run reads the same user back by its id", async () => {
		/* port shape (bit-12 Fe2): v0's one program is two driver runs, the id read from the first */
		const created = await drive({ calls: [createUser("rt@rust.test", "Alice")], setup: VALID })
		expect(created.observed).toEqual([
			{ data: { email: "rt@rust.test", id: expect.stringMatching(USER_ID), name: "Alice" }, kind: "data", status: 201 },
		])
		const id = dataOf(created.observed[0]).id as string
		const fetched = await drive({ calls: [getUser(id)], setup: VALID })
		expect(fetched.observed).toEqual([{ data: dataOf(created.observed[0]), kind: "data", status: 200 }])
		const hops = [...created.hops, ...fetched.hops]
		expect(hops.map((h) => [h.method, h.url, h.headers.authorization, h.body.json ?? null])).toEqual([
			["POST", "/v1/secure/users", "Bearer valid-token", { email: "rt@rust.test", name: "Alice" }],
			["GET", `/v1/secure/users/${id}`, "Bearer valid-token", null],
		])
	})
})

rustDescribe("OnAuthExpired", () => {
	it("retries a 401 once with the refreshed token, replaying the JSON body, then keeps that token", async () => {
		const run = await scripted(
			{ calls: [createUser("ae@rust.test", "Ae"), listUsers()], setup: EXPIRED },
			{ onAuthExpired: { tokens: ["valid-token"] } },
		)
		const user = dataOf(run.observed[0])
		expect(run.observed).toEqual([
			{ data: { email: "ae@rust.test", id: expect.stringMatching(USER_ID), name: "Ae" }, kind: "data", status: 201 },
			{ data: expect.arrayContaining([user]), kind: "data", status: 200 },
		])
		expect([run.trace.authExpired, run.hops.map((h) => h.headers.authorization)]).toEqual([
			1,
			["Bearer expired-token", "Bearer valid-token", "Bearer valid-token"],
		])
		expect(run.hops[1]?.body).toEqual(run.hops[0]?.body)
	})

	it("does not retry a one-shot body the first attempt consumed: the 401 surfaces", async () => {
		const run = await scripted(
			{ calls: [blob(1)], setup: EXPIRED },
			{ calls: [{ oneShotBody: true }], onAuthExpired: { tokens: ["valid-token"] } },
		)
		expect([run.observed, run.trace.authExpired, run.hops.length]).toEqual([
			[
				{
					body: envelope(401, "unauthorized", "Authentication required"),
					errorKey: "unauthorized",
					kind: "error",
					status: 401,
				},
			],
			0,
			1,
		])
	})
})

rustDescribe("typed errors", () => {
	// v0: 522f669f3a
	it("surfaces a declared 400 as Error::Api with kind BadRequest, its typed envelope() parsed", async () => {
		const run = await scripted(
			{ calls: [call("errors.declared", "GET", "/v1/declared-errors/:status", { params: { status: "400" } })] },
			{ calls: [{ envelope: true }] },
		)
		expect(run.observed).toEqual([
			{ body: envelope(400, "bad_request", "Bad request"), errorKey: "bad_request", kind: "error", status: 400 },
		])
		/* V0BUG: v0's downcast_ref on Error::Api never compiled (E0599, plan:100) and data: Option<Value> was its red gate; G6 ruled envelope() */
		expect(run.trace.calls[0]?.error).toEqual({
			debug: expect.any(String),
			envelope: {
				error_key: "bad_request",
				extraKeys: ["request_id", "success"],
				message: "Bad request",
				status: 400,
				status_key: "bad_request",
			},
			key: "bad_request",
			keyVariant: "Some(BadRequest)",
			kind: "BadRequest",
			message: "Bad request",
			source: expect.any(Boolean),
			status: 400,
			text: expect.any(String),
			variant: "Api",
			via: "return",
		})
	})
})

rustDescribe("cancellation", () => {
	// v0: 9f3e174f28
	it("ends a call canceled before it starts as Canceled, with nothing sent", async () => {
		/* ruling change (G2/G9): v0's tokio-util CancellationToken in GetUserOpts is Call::cancel_on; same behavior */
		const run = await scripted({ calls: [getUser("any-id")], setup: VALID }, { calls: [{ cancel: "before" }] })
		expect([run.observed, run.trace.calls[0]?.error, run.hops.length]).toEqual([
			[null],
			{ debug: expect.any(String), source: false, text: "the call was canceled", variant: "Canceled", via: "return" },
			0,
		])
	})
})

rustDescribe("request headers", () => {
	// v0: 1928348bf6
	it("sends a fresh UUIDv4 X-Request-Id per call, keeps a call's id, and lets on_request's id win", async () => {
		/* port shape: v0's create_user calls are echo.get, where the app answers the id it saw */
		const auto = await drive({ calls: [echo(), echo(), echo({ headers: { "x-request-id": "from-call" } })] })
		const ids = auto.hops.map((h) => h.headers["x-request-id"])
		expect(ids).toEqual([expect.stringMatching(UUID_V4), expect.stringMatching(UUID_V4), "from-call"])
		expect(ids[0]).not.toBe(ids[1])
		expect(auto.observed.map((o) => dataOf(o).requestId)).toEqual(ids)
		const hook = await scripted(
			{ calls: [echo({ headers: { "x-request-id": "from-call" } })] },
			{ hooks: { request: [{ setHeader: ["X-Request-Id", "from-hook"] }] } },
		)
		expect(hook.hops.map((h) => h.headers["x-request-id"])).toEqual(["from-hook"])
	})

	// v0: b7702f8c97
	it("gives an x-idempotency-key op an auto UUIDv4 key, honors the call's key, and a caller header wins", async () => {
		const run = await scripted(
			{ calls: [idempotent(), idempotent(), idempotent({ headers: { "Idempotency-Key": "header-wins-key" } })] },
			{ calls: [null, { idempotencyKey: "user-supplied-key-123" }, { idempotencyKey: "should-be-ignored" }] },
		)
		const keys = [expect.stringMatching(UUID_V4), "user-supplied-key-123", "header-wins-key"]
		expect(run.observed.map((o) => dataOf(o).idempotencyKey)).toEqual(keys)
		expect(run.hops.map((h) => h.headers["idempotency-key"])).toEqual(run.observed.map((o) => dataOf(o).idempotencyKey))
	})
})

rustDescribe("hooks and logging", () => {
	// v0: 95d0d5b85b
	it("runs on_request hooks in declaration order, the second overwriting the first, and on_response hooks in order", async () => {
		/* port shape (Fe5): v0's closures are the driver's setHeader; the app 401s "Bearer wrong", so the 201 proves the order */
		const run = await scripted(
			{ calls: [createUser("hooks@rust.test", "Alice")] },
			{
				hooks: {
					request: [
						{ setHeader: ["Authorization", "Bearer wrong"] },
						{ setHeader: ["Authorization", "Bearer valid-token"] },
					],
					response: [{}, {}],
				},
			},
		)
		expect(run.observed).toEqual([
			{
				data: { email: "hooks@rust.test", id: expect.stringMatching(USER_ID), name: "Alice" },
				kind: "data",
				status: 201,
			},
		])
		expect(run.hops.map((h) => h.headers.authorization)).toEqual(["Bearer valid-token"])
		expect(run.trace.hooks.map((h) => [h.phase, h.index, h.status ?? null])).toEqual([
			["request", 0, null],
			["request", 1, null],
			["response", 0, 201],
			["response", 1, 201],
		])
	})

	// v0: 82000f6791
	it("logs request_start, then response_received with the status and a duration, under METHOD <path template>", async () => {
		/* app difference: v0's mock spec logged "POST /users"; the served document's template is /v1/secure/users */
		const run = await scripted(
			{ calls: [createUser("log@rust.test", "Log")], setup: VALID },
			{ log: true, logDurations: true },
		)
		const operation = "POST /v1/secure/users"
		expect(run.trace.log).toEqual([
			{ durationMs: 0, event: "request_start", level: "debug", operation },
			{ durationMs: expect.any(Number), event: "response_received", level: "info", operation, status: 201 },
		])
		const duration = run.trace.log[1]?.durationMs
		expect([Number.isInteger(duration), (duration ?? -1) >= 0]).toEqual([true, true])
	})
})

rustDescribe("invalidation", () => {
	// v0: c365ed50d2
	it("marks the GETs a mutation invalidates stale, a templated pattern matching the interpolated path", async () => {
		/* surface change (Fe4): v0's public client.is_stale(method, path) is read through the hook trace, as TS and Go do */
		const calls = [
			listUsers(),
			getUser("user-0"),
			createUser("z@rust.test", "Zed"),
			listUsers(),
			getUser("user-0"),
			updateUser("z-1", { name: "Zed" }),
			listUsers(),
			getUser("z-1"),
			getUser("user-0"),
		]
		const run = await scripted({ calls, setup: VALID }, { config: { invalidation: { staleTimeMs: 60_000 } } })
		const seen = run.trace.hooks
			.filter((h) => h.phase === "request")
			.map((h) => [h.selector, h.isStale, h.invalidatedBy])
		expect(seen).toEqual([
			["GET /v1/secure/users", false, []],
			["GET /v1/secure/users/user-0", false, []],
			["POST /v1/secure/users", false, []],
			["GET /v1/secure/users", true, ["POST /v1/secure/users"]],
			["GET /v1/secure/users/user-0", false, []],
			["PUT /v1/secure/users/z-1", false, []],
			["GET /v1/secure/users", true, ["PUT /v1/secure/users/z-1"]],
			["GET /v1/secure/users/z-1", true, ["PUT /v1/secure/users/z-1"]],
			["GET /v1/secure/users/user-0", false, []],
		])
	})
})

rustDescribe("streaming upload", () => {
	// v0: 69a158910e
	it("streams a 1 MiB body of unknown length chunked, and the app answers its size and sha256", async () => {
		const sha256 = createHash("sha256")
			.update(Uint8Array.from({ length: MIB }, (_, i) => i & 0xff))
			.digest("hex")
		const run = await scripted({ calls: [blob(MIB)], setup: VALID }, { calls: [{ oneShotBody: true }] })
		expect(run.observed).toEqual([{ data: { sha256, size: MIB }, kind: "data", status: 200 }])
		const hop = run.hops[0]
		expect([hop?.body, hop?.headers["transfer-encoding"], hop?.headers["content-length"]]).toEqual([
			{ contentType: OCTET, sha256, size: MIB },
			"chunked",
			undefined,
		])
	})
})

rustDescribe("WebSocket", () => {
	// v0: 4a79ee6333
	it("connects, sends JSON and receives the echo, then closes cleanly", async () => {
		/* port shape: v0's ws.send(&Value) is send_json, so the echo is the JSON text "\"hello\"" */
		const run = await scripted(
			{ calls: [wsEcho({ take: 1 })] },
			{ calls: [{ ws: { close: { code: 1000, reason: "done" }, on: true, send: [{ json: "hello" }] } }] },
		)
		expect(run.observed).toEqual([{ frames: ["hello"], kind: "frames" }])
		expect(run.trace.calls[0]?.stream).toEqual({
			handlers: [
				{ data: '"hello"', event: "message" },
				{ data: "done", event: "close" },
			],
			yields: 1,
		})
		expect(run.hops.map((h) => [h.method, h.url, h.headers.upgrade])).toEqual([["GET", "/v1/ws/echo", "websocket"]])
	})

	// v0: bd34834054
	it("terminates the connection on a client close: the close handler fires once and close succeeds", async () => {
		const run = await scripted({ calls: [wsEcho({ take: 0 })] }, wsOn({ code: 1000, reason: "client-bye" }))
		expect(run.observed).toEqual([{ frames: [], kind: "frames" }])
		/* ruling change (Fd2): a clean close is not an error; recv after close is None, not Err, and no closeError proves it */
		expect(run.trace.calls[0]?.stream).toEqual({ handlers: [{ data: "client-bye", event: "close" }], yields: 0 })
	})

	// v0: 8f9f2439cc
	it("sees a server-initiated close with its code and reason, and the client's own close succeeds", async () => {
		const run = await scripted({ calls: [wsEcho({ send: ["__close__"] })] }, wsOn())
		expect(run.observed).toEqual([{ frames: [], kind: "frames" }])
		/* ruling change (Fd2): v0's Err(Closed{code, reason}) is recv's None and closed_by(); close on the ended socket is Ok */
		expect(run.trace.calls[0]?.stream).toEqual({
			closedBy: { code: 1000, reason: "server-initiated" },
			handlers: [{ data: "server-initiated", event: "close" }],
			yields: 0,
		})
	})

	// v0: 617fd16933
	it("echoes with ?token=valid-token and closes 4401 with nothing echoed for a bogus token", async () => {
		const valid = await scripted(
			{ calls: [wsEcho({ search: { token: "valid-token" }, send: ["ping"], take: 1 })] },
			wsOn(),
		)
		/* the bogus leg keeps v0's send (Fe6 overridden): the driver reads on after a send error, so the 4401 shows either way */
		const bogus = await scripted({ calls: [wsEcho({ search: { token: "bogus-token" }, send: ["ping"] })] }, wsOn())
		/* ruling change (Fd2): v0's Err(Closed{4401, "unauthorized"}) is recv's None and closed_by() */
		expect([valid.observed, bogus.observed, bogus.trace.calls[0]?.stream?.closedBy]).toEqual([
			[{ frames: ["ping"], kind: "frames" }],
			[{ frames: [], kind: "frames" }],
			{ code: 4401, reason: "unauthorized" },
		])
		expect([...valid.hops, ...bogus.hops].map((h) => h.url)).toEqual([
			"/v1/ws/echo?token=valid-token",
			"/v1/ws/echo?token=bogus-token",
		])
	})
})
