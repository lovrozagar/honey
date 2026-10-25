/**
 * The v0 Go SDK integration harness, ported: the emitted Go SDK, compiled with the test driver,
 * against core's live reference app (spawned by `conformance/harness.ts`; gen never imports core).
 * Each case is one or more driver runs, in script mode where it needs hooks, a log, directives or
 * a trace. Opt-in: `vitest run --mode harness`.
 */
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compiledSdk, type DrivenSdk } from "../../src/emit/go/__fixtures__/compiled.ts"
import type { Script, Trace } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { withGo } from "../../src/emit/go/__fixtures__/go-env.ts"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"
import type { Call, Json, Observed, Setup, WireHop } from "./conformance/matrix.ts"

type Drive = { calls: readonly Call[]; setup?: Setup }
type Run = { hops: readonly WireHop[]; observed: readonly Observed[]; trace?: Trace }

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
let goSdk: DrivenSdk | undefined

/** The running app and the compiled SDK. */
function live(): { app: ReferenceApp; sdk: DrivenSdk } {
	if (!reference || !goSdk) throw new Error("the reference app or the Go SDK is not ready")
	return { app: reference, sdk: goSdk }
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
async function scripted(cell: Drive, script: Script): Promise<Run & { trace: Trace }> {
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

/** The `*sdk.` entries of a Go error's chain. */
const sdkChain = (chain: readonly string[]) => chain.filter((type) => type.startsWith("*sdk."))

/** A script registering the recording WebSocket handlers, closing with `close` when given. */
const wsOn = (close?: { code: number; reason: string }): Script => ({
	calls: [{ ws: close ? { close, on: true } : { on: true } }],
})

/** Whether Go is here: a missing one fails where it is required and skips this file elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

beforeAll(async () => {
	if (!GO) return
	reference = await startReferenceApp()
	goSdk = compiledSdk(reference.document, { modulePath: "example.com/conformance" })
	expect({ built: goSdk.built, vet: goSdk.vet }, goSdk.stderr).toEqual({ built: true, vet: [] })
}, 60_000)

afterAll(() => reference?.stop())

goDescribe("round trip", () => {
	// v0: 4f86e8c658
	it("creates a user, then a second run reads the same user back by its id", async () => {
		const created = await drive({ calls: [createUser("rt@go.test", "Alice")], setup: VALID })
		expect(created.observed).toEqual([
			{ data: { email: "rt@go.test", id: expect.stringMatching(USER_ID), name: "Alice" }, kind: "data", status: 201 },
		])
		const id = dataOf(created.observed[0]).id as string
		const fetched = await drive({ calls: [getUser(id)], setup: VALID })
		expect(fetched.observed).toEqual([{ data: dataOf(created.observed[0]), kind: "data", status: 200 }])
		const hops = [...created.hops, ...fetched.hops]
		expect(hops.map((h) => [h.method, h.url, h.headers.authorization, h.body.json ?? null])).toEqual([
			["POST", "/v1/secure/users", "Bearer valid-token", { email: "rt@go.test", name: "Alice" }],
			["GET", `/v1/secure/users/${id}`, "Bearer valid-token", null],
		])
	})
})

goDescribe("OnAuthExpired", () => {
	it("retries a 401 once with the refreshed token, replaying the JSON body, then keeps that token", async () => {
		const run = await scripted(
			{ calls: [createUser("ae@go.test", "Ae"), listUsers()], setup: EXPIRED },
			{ onAuthExpired: { tokens: ["valid-token"] } },
		)
		const user = dataOf(run.observed[0])
		expect(run.observed).toEqual([
			{ data: { email: "ae@go.test", id: expect.stringMatching(USER_ID), name: "Ae" }, kind: "data", status: 201 },
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

goDescribe("typed errors", () => {
	// v0: 3824914fa7
	it("surfaces a declared 400 as *BadRequestError over *ClientError, its typed Envelope parsed", async () => {
		const run = await scripted(
			{ calls: [call("errors.declared", "GET", "/v1/declared-errors/:status", { params: { status: "400" } })] },
			{ calls: [{ envelope: true, isKeys: ["bad_request"] }] },
		)
		expect(run.observed).toEqual([
			{ body: envelope(400, "bad_request", "Bad request"), errorKey: "bad_request", kind: "error", status: 400 },
		])
		const error = run.trace.calls[0]?.error
		/* V0BUG: v0 pinned BadRequestError.Data (any); G6 ruled the typed Envelope (plan:76) */
		expect([sdkChain(error?.chain ?? []), error?.status, error?.keys, error?.envelope]).toEqual([
			["*sdk.BadRequestError", "*sdk.ClientError"],
			400,
			{ bad_request: true },
			{ error_key: "bad_request", message: "Bad request", status: 400, status_key: "bad_request" },
		])
	})
})

goDescribe("request headers", () => {
	// v0: 5e949770e4
	it("merges per-call headers over config headers: the call's value wins per key, config keys kept", async () => {
		const run = await drive({
			calls: [echo({ headers: { "X-Both": "call", "X-Call": "c" } })],
			setup: { headers: { "X-Both": "config", "X-Config": "a" } },
		})
		const headers = run.hops[0]?.headers ?? {}
		expect([headers["x-config"], headers["x-call"], headers["x-both"]]).toEqual(["a", "c", "call"])
		const requestId = headers["x-request-id"]
		expect(run.observed).toEqual([
			{ data: { method: "GET", requestId }, headers: { "x-request-id": requestId }, kind: "data", status: 200 },
		])
		expect(requestId).toMatch(UUID_V4)
	})

	// v0: 37aad01b94
	it("sends a fresh UUIDv4 X-Request-Id per call, keeps a config or call id, and lets OnRequest's id win", async () => {
		const auto = await drive({ calls: [echo(), echo(), echo({ headers: { "X-Request-Id": "from-call" } })] })
		const ids = auto.hops.map((h) => h.headers["x-request-id"])
		expect(ids).toEqual([expect.stringMatching(UUID_V4), expect.stringMatching(UUID_V4), "from-call"])
		expect(ids[0]).not.toBe(ids[1])
		expect(auto.observed.map((o) => dataOf(o).requestId)).toEqual(ids)
		const config = await drive({ calls: [echo()], setup: { headers: { "X-Request-Id": "from-config" } } })
		const hook = await scripted(
			{ calls: [echo({ headers: { "X-Request-Id": "from-call" } })] },
			{ hooks: { request: [{ setHeader: ["X-Request-Id", "from-hook"] }] } },
		)
		expect([config.hops[0]?.headers["x-request-id"], hook.hops[0]?.headers["x-request-id"]]).toEqual([
			"from-config",
			"from-hook",
		])
	})

	// v0: 77cf022eaf
	it("gives an x-idempotency-key op an auto UUIDv4 key, honors Opts.IdempotencyKey, and a caller header wins", async () => {
		const run = await scripted(
			{ calls: [idempotent(), idempotent(), idempotent({ headers: { "Idempotency-Key": "header-wins-key" } })] },
			{ calls: [null, { idempotencyKey: "user-supplied-key-123" }, { idempotencyKey: "should-be-ignored" }] },
		)
		const keys = [expect.stringMatching(UUID_V4), "user-supplied-key-123", "header-wins-key"]
		expect(run.observed.map((o) => dataOf(o).idempotencyKey)).toEqual(keys)
		expect(run.hops.map((h) => h.headers["idempotency-key"])).toEqual(run.observed.map((o) => dataOf(o).idempotencyKey))
	})
})

goDescribe("hooks and logging", () => {
	// v0: a8caa7554c
	it("runs OnRequest and OnResponse hooks in declaration order", async () => {
		const run = await scripted(
			{ calls: [getUser("user-0")], setup: VALID },
			{
				hooks: {
					request: [{ setHeader: ["X-Hook-1", "a"] }, { setHeader: ["X-Hook-2", "b"] }],
					response: [{}, {}],
				},
			},
		)
		const headers = run.hops[0]?.headers ?? {}
		expect([headers["x-hook-1"], headers["x-hook-2"]]).toEqual(["a", "b"])
		expect(run.trace.hooks.map((h) => [h.phase, h.index, h.status ?? null])).toEqual([
			["request", 0, null],
			["request", 1, null],
			["response", 0, 200],
			["response", 1, 200],
		])
	})

	// v0: 4897c15a88
	it("logs request_start, then response_received with the status and a duration, under METHOD <path template>", async () => {
		const run = await scripted(
			{ calls: [createUser("log@go.test", "Log")], setup: VALID },
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

goDescribe("invalidation", () => {
	// v0: dfabed1f02
	it("marks the GETs a mutation invalidates stale, a templated pattern matching the interpolated path", async () => {
		const calls = [
			listUsers(),
			getUser("user-0"),
			createUser("z@go.test", "Zed"),
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

goDescribe("streaming upload", () => {
	// v0: 09bfa6e48b
	it("streams a 1 MiB bare io.Reader chunked, and the app answers its size and sha256", async () => {
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

goDescribe("WebSocket", () => {
	// v0: 3aa45cf6fa
	it("connects, sends and receives the echo, then closes cleanly", async () => {
		const run = await scripted({ calls: [wsEcho({ send: ["hello"], take: 1 })] }, wsOn({ code: 1000, reason: "done" }))
		expect(run.observed).toEqual([{ frames: ["hello"], kind: "frames" }])
		expect(run.trace.calls[0]?.stream).toEqual({
			handlers: [
				{ data: "hello", event: "message" },
				{ data: "done", event: "close" },
			],
			yields: 1,
		})
		expect(run.hops.map((h) => [h.method, h.url, h.headers.upgrade])).toEqual([["GET", "/v1/ws/echo", "websocket"]])
	})

	// v0: eaf443a85d
	it("completes a client-initiated close handshake: Close returns nil", async () => {
		const run = await scripted({ calls: [wsEcho({ take: 0 })] }, wsOn({ code: 1000, reason: "client-bye" }))
		expect(run.observed).toEqual([{ frames: [], kind: "frames" }])
		/* v0 asserted that a Read after Close fails, which any closed conn satisfies; no closeError proves the handshake */
		expect(run.trace.calls[0]?.stream).toEqual({ handlers: [{ data: "client-bye", event: "close" }], yields: 0 })
	})

	// v0: 92204506d1
	it("sees a server-initiated close with its code and reason", async () => {
		const run = await scripted({ calls: [wsEcho({ send: ["__close__"] })] }, wsOn())
		expect(run.observed).toEqual([{ frames: [], kind: "frames" }])
		/* no closeError: the driver's own Close after the peer's close frame is benign (ws.go maps net.ErrClosed to nil) */
		expect(run.trace.calls[0]?.stream).toEqual({
			closedBy: { code: 1000, reason: "server-initiated" },
			handlers: [{ data: "server-initiated", event: "close" }],
			yields: 0,
		})
	})

	// v0: 95ca344579
	it("echoes with ?token=valid-token and closes 4401 with nothing echoed for a bogus token", async () => {
		const valid = await scripted(
			{ calls: [wsEcho({ search: { token: "valid-token" }, send: ["ping"], take: 1 })] },
			wsOn(),
		)
		/* the bogus leg sends nothing (Fe8, sweep 19): the app refuses in onOpen, and a send into the closing socket pins nothing */
		const bogus = await scripted({ calls: [wsEcho({ search: { token: "bogus-token" } })] }, wsOn())
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
