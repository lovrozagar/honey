/**
 * The C# SDK integration harness: v1 ports of the Rust, Python, Go and TS harness classes (bit 15 owns no v0 ids),
 * on the emitted C# SDK for core's served document (`servedCSharpSdk`, built warnings as errors), driven by the
 * fixed reflection driver against core's live reference app (spawned by `conformance/harness.ts`; gen never imports
 * core). Each case is one or more driver runs, in script mode where it needs hooks, a log, directives or a trace;
 * the multipart upload is a consumer program, which the driver refuses. The WebSocket cases are in
 * `csharp-harness.ws.test.ts`. Opt-in: `vitest run --mode harness`.
 */
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clientOf, program } from "../../src/emit/csharp/__fixtures__/consumer.ts"
import { type DrivenCSharpSdk, servedCSharpSdk } from "../../src/emit/csharp/__fixtures__/driven.ts"
import { withDotnet } from "../../src/emit/csharp/__fixtures__/csharp-env.ts"
import type { CsError, Script, Trace } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { type ReferenceApp, SPAWN_TIMEOUT, startReferenceApp } from "./conformance/harness.ts"
import type { Call, Json, Observed, Setup, WireHop } from "./conformance/matrix.ts"

type Drive = { calls: readonly Call[]; setup?: Setup }
type Run = { hops: readonly WireHop[]; observed: readonly Observed[]; trace?: Trace<CsError> }

const VALID: Setup = { auth: { kind: "bearer", token: "valid-token" } }
const EXPIRED: Setup = { auth: { kind: "bearer", token: "expired-token" } }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const USER_ID = /^user-\d+$/
const OCTET = "application/octet-stream"
const MIB = 1 << 20
/** The custom credential header: the name as given, no prefix. */
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
let csharpSdk: DrivenCSharpSdk | undefined

/** The running app and the built SDK. */
function live(): { app: ReferenceApp; sdk: DrivenCSharpSdk } {
	if (!reference || !csharpSdk) throw new Error("the reference app or the C# SDK is not ready")
	return { app: reference, sdk: csharpSdk }
}

/** One driver run of `cell` (under `script`), and the requests the app received meanwhile. */
async function drive(cell: Drive, script?: Script): Promise<Run> {
	const { app, sdk } = live()
	const since = await app.mark()
	const run = await sdk.runCalls(cell, { alt: app.alt, url: app.url }, script === undefined ? {} : { script })
	expect(run.status, run.stderr).toBe(0)
	return { hops: await app.wire(since), observed: run.observed as readonly Observed[], trace: run.trace }
}

/** `drive` under `script`, its trace required. */
async function scripted(cell: Drive, script: Script): Promise<Run & { trace: Trace<CsError> }> {
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

/** The app's 401, as a call observes it. */
const UNAUTHORIZED: Observed = {
	body: envelope(401, "unauthorized", "Authentication required"),
	errorKey: "unauthorized",
	kind: "error",
	status: 401,
}

/** An `ApiStatusException` subclass the method threw, as the trace records it (`Errors.cs:44-45`'s text). */
const statusError = (type: string, status: number, key: [string, string], message: string): CsError => ({
	canceled: false,
	chain: [type, "ApiStatusException", "HoneyException"],
	display: `HoneySdk.${type}: HTTP ${status}: ${message}`,
	inner: null,
	key: key[0],
	keyMember: key[1],
	message,
	status,
	text: `HTTP ${status}: ${message}`,
	type,
	via: "return",
})

/** Each hop's value of the header `name` (lower case), `undefined` where it is absent. */
const headerOf = (hops: readonly WireHop[], name: string) => hops.map((h) => h.headers[name])

/** A multipart content type's boundary when it is `honey-<uuid>`, else null (`binary.test.ts:386`). */
const boundaryOf = (type: string | undefined) =>
	/^multipart\/form-data; boundary=(honey-[0-9a-f-]{36})$/.exec(type ?? "")?.[1] ?? null

/** Consumer program `name` around `body` on the served SDK, aimed at the app: its notes, and the app's hops. */
async function consumed(name: string, body: string): Promise<{ hops: readonly WireHop[]; out: unknown }> {
	const { app, sdk } = live()
	const { client, namespace } = clientOf(sdk)
	const since = await app.mark()
	const source = `// consumer ${name}: a test program, never shipped\n${program(namespace, client, body)}`
	const ran = await sdk.exec(source, "", [app.url])
	expect(ran.status, ran.stderr).toBe(0)
	return { hops: await app.wire(since), out: JSON.parse(ran.stdout) as unknown }
}

/** Whether .NET is here: a missing SDK fails where it is required and skips this file elsewhere (csharp-env). */
const DOTNET = withDotnet()
const csDescribe = describe.skipIf(!DOTNET)

beforeAll(async () => {
	if (!DOTNET) return
	reference = await startReferenceApp()
	csharpSdk = servedCSharpSdk(reference.document)
	expect(csharpSdk.built, csharpSdk.diagnostics.join("\n")).toBe(true)
}, SPAWN_TIMEOUT)

afterAll(() => reference?.stop())

csDescribe("round trip", () => {
	/* ported: rust-harness.test.ts:104-118, python-harness.test.ts:154, go-harness.test.ts:107 */
	it("creates a user, then a second run reads the same user back by its id", async () => {
		const email = "rt@cs.test"
		const created = await drive({ calls: [createUser({ email, name: "Alice" })], setup: VALID })
		expect(created.observed).toEqual([
			{ data: { email, id: expect.stringMatching(USER_ID), name: "Alice" }, kind: "data", status: 201 },
		])
		const id = dataOf(created.observed[0]).id as string
		const fetched = await drive({ calls: [getUser(id)], setup: VALID })
		expect(fetched.observed).toEqual([{ data: dataOf(created.observed[0]), kind: "data", status: 200 }])
		const hops = [...created.hops, ...fetched.hops]
		expect(hops.map((h) => [h.method, h.url, h.headers.authorization, h.body.json ?? null])).toEqual([
			["POST", "/v1/secure/users", "Bearer valid-token", { email, name: "Alice" }],
			["GET", `/v1/secure/users/${id}`, "Bearer valid-token", null],
		])
	})
})

csDescribe("OnAuthExpired", () => {
	/* ported: rust-harness.test.ts:122-137, go-harness.test.ts:124 */
	it("retries a 401 once with the refreshed token, replaying the JSON body, then keeps that token", async () => {
		const email = "ae@cs.test"
		const run = await scripted(
			{ calls: [createUser({ email, name: "Ae" }), listUsers()], setup: EXPIRED },
			{ onAuthExpired: { tokens: ["valid-token"] } },
		)
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
	})

	/* ported: rust-harness.test.ts:139-156, go-harness.test.ts:141 */
	it("does not retry a one-shot body the first attempt consumed: the 401 surfaces", async () => {
		const run = await scripted(
			{ calls: [blob(1)], setup: EXPIRED },
			{ calls: [{ oneShotBody: true }], onAuthExpired: { tokens: ["valid-token"] } },
		)
		/* a one-shot stream is not Replayable (Exchange.cs:103), so it goes chunked and is never resent */
		expect([run.observed, run.trace.authExpired, headerOf(run.hops, "transfer-encoding")]).toEqual([
			[UNAUTHORIZED],
			0,
			["chunked"],
		])
	})

	/* ported: ts-harness.test.ts:148-158 (v0 40dd62d460's class), with C#'s FilePart (binary.test.ts:357-360) */
	it("retries a FilePart multipart upload with the refreshed token, the app's parser reading the same body twice", async () => {
		/* Fe6: the driver refuses a multipart body, so a consumer program sends it; the app answers the file's size */
		const { hops, out } = await consumed(
			"multipart",
			[
				`var file = new FilePart("hello.txt", "hello multipart"u8.ToArray(), "text/plain");`,
				`using var c = Client(new ClientConfig { BearerToken = "expired-token", OnAuthExpired = _ => Task.FromResult<string?>("valid-token") });`,
				"var r = await c.Uploads.FormAsync(new UploadsFormBody { File = file });",
				`Note($"size {r.Size}");`,
			].join("\n"),
		)
		expect(out).toEqual({ main: ["size 15"] })
		expect(hops.map((h) => [h.method, h.url, h.headers.authorization])).toEqual([
			["POST", "/v1/secure/uploads/form", "Bearer expired-token"],
			["POST", "/v1/secure/uploads/form", "Bearer valid-token"],
		])
		const boundaries = hops.map((h) => boundaryOf(h.headers["content-type"]))
		expect([boundaries[0], boundaries[1], hops[1]?.body.sha256]).toEqual([
			expect.stringMatching(/^honey-/),
			boundaries[0],
			hops[0]?.body.sha256,
		])
	})
})

csDescribe("auth headers", () => {
	/* ported: python-harness.test.ts:211-223 */
	it("sends the bearer token as Authorization: Bearer by default, and no x-api-key", async () => {
		const run = await drive({ calls: [echo()], setup: { auth: { kind: "bearer", token: "my-token" } } })
		const hop = run.hops[0]
		expect([run.hops.length, hop?.headers.authorization, hop?.headers["x-api-key"]]).toEqual([
			1,
			"Bearer my-token",
			undefined,
		])
		expect(dataOf(run.observed[0])).toEqual({ method: "GET", requestId: hop?.headers["x-request-id"] })
	})

	/* ported: python-harness.test.ts:226-233 */
	it("sends the token bare under a custom header name, and no Authorization", async () => {
		const run = await scripted(
			{ calls: [echo()], setup: { auth: { kind: "bearer", token: "my-token" } } },
			{ config: API_KEY },
		)
		const hop = run.hops[0]
		/* Auth.cs:15-16: the credential goes under AuthHeaderName with AuthHeaderPrefix, and nowhere else */
		expect([run.hops.length, hop?.headers["x-api-key"], hop?.headers.authorization]).toEqual([1, "my-token", undefined])
		expect(dataOf(run.observed[0])).toEqual({ method: "GET", requestId: hop?.headers["x-request-id"] })
	})

	/* ported: python-harness.test.ts:236-259 (Test G per bit-14 Fe5) */
	it("refreshes a 401 once under a custom header name, retrying with the new token and never Authorization", async () => {
		const script: Script = { config: API_KEY, onAuthExpired: { tokens: ["valid-token"] } }
		/* the credential last: a bearer under the custom name wins over a stale config header, which is never sent */
		const setups: Setup[] = [
			{ headers: { "X-API-Key": "expired-token" } },
			{ ...EXPIRED, headers: { "X-API-Key": "stale-config" } },
		]
		for (const setup of setups) {
			const run = await scripted({ calls: [listUsers()], setup }, script)
			expect([run.observed, run.trace.calls[0]?.error, run.trace.authExpired]).toEqual([
				[UNAUTHORIZED],
				statusError("UnauthorizedException", 401, ["unauthorized", "Unauthorized"], "Authentication required"),
				1,
			])
			expect([headerOf(run.hops, "x-api-key"), headerOf(run.hops, "authorization")]).toEqual([
				["expired-token", "valid-token"],
				[undefined, undefined],
			])
		}
	})
})

csDescribe("typed errors", () => {
	/* ported: python-harness.test.ts:264-309, rust-harness.test.ts:161-189, go-harness.test.ts:163 */
	it("throws BadRequestException for a 400 with its typed envelope and field errors", async () => {
		/* Test L needs no consumer program: ApiStatusException.Body is statically byte[] (Errors.cs:63, errors.test.ts:418) */
		const fields = { name: [{ error_key: "required", message: "name is required", path: "name" }] }
		const run = await scripted(
			{ calls: [createUser({ email: "l@cs.test" })], setup: VALID },
			{ calls: [{ envelope: true }] },
		)
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
		const extraKeys = ["request_id", "success"]
		expect(run.trace.calls[0]?.error).toEqual({
			...statusError("BadRequestException", 400, ["invalid_input", "InvalidInput"], "Invalid input"),
			envelope: {
				error_key: "invalid_input",
				extraKeys,
				fields,
				message: "Invalid input",
				status: 400,
				status_key: "bad_request",
			},
		})
		const plain = await scripted({ calls: [declared("400")] }, { calls: [{ envelope: true }] })
		expect([plain.observed, plain.trace.calls[0]?.error?.key, plain.trace.calls[0]?.error?.envelope]).toEqual([
			[{ body: envelope(400, "bad_request", "Bad request"), errorKey: "bad_request", kind: "error", status: 400 }],
			"bad_request",
			{ error_key: "bad_request", extraKeys, message: "Bad request", status: 400, status_key: "bad_request" },
		])
	})
})

csDescribe("cancellation", () => {
	/* ported: rust-harness.test.ts:194-202, python-harness.test.ts:314-333 */
	it("ends a call canceled before it starts as a TaskCanceledException on the caller's token, with nothing sent", async () => {
		/* the hooks are left unpinned: C# runs OnRequest before a pre-cancelled SendAsync throws (Exchange.cs:113-127; bit 19) */
		const run = await scripted(
			{ calls: [createUser({ email: "o@cs.test", name: "O" })], setup: VALID },
			{ calls: [{ cancel: "before" }] },
		)
		expect([run.observed, run.trace.calls[0]?.error, run.hops.length]).toEqual([
			[null],
			{
				canceled: true,
				chain: ["TaskCanceledException"],
				display: expect.any(String),
				inner: "TaskCanceledException",
				text: "A task was canceled.",
				type: "TaskCanceledException",
				via: "return",
			},
			0,
		])
	})

	/* ported: python-harness.test.ts:336-351, retimed by 4d1f701 */
	it("cancels a call in flight on the method's token, the request already sent, long before its reply", async () => {
		/* Fe5: the echo warms the client, so the 300 ms cancel lands on a sent request; the ceiling sits under the 5 s reply */
		const run = await scripted({ calls: [echo(), slow(5000)] }, { calls: [null, { cancel: { afterMs: 300 } }] })
		expect([dataOf(run.observed[0]).method, run.observed[1], run.trace.calls[1]?.error]).toEqual([
			"GET",
			null,
			{
				canceled: true,
				chain: ["TaskCanceledException"],
				display: expect.any(String),
				inner: "TaskCanceledException",
				text: "The operation was canceled.",
				type: "TaskCanceledException",
				via: "return",
			},
		])
		expect(run.hops.map((h) => [h.method, h.url])).toEqual([
			["GET", "/v1/echo"],
			["GET", "/v1/slow?ms=5000"],
		])
		expect(run.trace.calls[1]?.elapsedMs).toBeLessThan(4000)
	})
})

csDescribe("request headers", () => {
	/* ported: python-harness.test.ts:356-375, rust-harness.test.ts:207-219, go-harness.test.ts:199 */
	it("sends a fresh UUIDv4 X-Request-Id per call, then the config's, the call's, and a hook's as one value", async () => {
		const auto = await drive({ calls: [echo(), echo(), echo({ headers: { "x-request-id": "from-call" } })] })
		const ids = headerOf(auto.hops, "x-request-id")
		expect(ids).toEqual([expect.stringMatching(UUID_V4), expect.stringMatching(UUID_V4), "from-call"])
		expect(ids[0]).not.toBe(ids[1])
		expect(auto.observed.map((o) => dataOf(o).requestId)).toEqual(ids)
		const config = await drive({ calls: [echo()], setup: { headers: { "x-request-id": "from-config" } } })
		expect(headerOf(config.hops, "x-request-id")).toEqual(["from-config"])
		/* the hop's headers fold case (Exchange.cs:164-170), so a hook's X-Request-Id replaces the call's x-request-id */
		const hook = await scripted(
			{ calls: [echo({ headers: { "x-request-id": "from-call" } })] },
			{ hooks: { request: [{ setHeader: ["X-Request-Id", "from-hook"] }] } },
		)
		expect([headerOf(hook.hops, "x-request-id"), dataOf(hook.observed[0]).requestId]).toEqual([
			["from-hook"],
			"from-hook",
		])
	})

	/* ported: rust-harness.test.ts:222-230, go-harness.test.ts:217 */
	it("gives an x-idempotency-key op an auto UUIDv4 key, honors the call's key, and a caller header wins", async () => {
		const run = await scripted(
			{ calls: [idempotent(), idempotent(), idempotent({ headers: { "Idempotency-Key": "header-wins-key" } })] },
			{ calls: [null, { idempotencyKey: "user-supplied-key-123" }, { idempotencyKey: "should-be-ignored" }] },
		)
		const keys = [expect.stringMatching(UUID_V4), "user-supplied-key-123", "header-wins-key"]
		expect(run.observed.map((o) => dataOf(o).idempotencyKey)).toEqual(keys)
		expect(headerOf(run.hops, "idempotency-key")).toEqual(run.observed.map((o) => dataOf(o).idempotencyKey))
	})
})

csDescribe("hooks and logging", () => {
	/* ported: rust-harness.test.ts:235-263 */
	it("runs OnRequest hooks in declaration order, the second overwriting the first, and OnResponse hooks in order", async () => {
		/* the app 401s "Bearer wrong", so the 201 proves the order */
		const run = await scripted(
			{ calls: [createUser({ email: "hooks@cs.test", name: "Alice" })] },
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
				data: { email: "hooks@cs.test", id: expect.stringMatching(USER_ID), name: "Alice" },
				kind: "data",
				status: 201,
			},
		])
		expect(headerOf(run.hops, "authorization")).toEqual(["Bearer valid-token"])
		expect(run.trace.hooks.map((h) => [h.phase, h.index, h.status ?? null])).toEqual([
			["request", 0, null],
			["request", 1, null],
			["response", 0, 201],
			["response", 1, 201],
		])
	})

	/* ported: rust-harness.test.ts:266-279, go-harness.test.ts:251, python-harness.test.ts:421-438 */
	it("logs request_start at 0 ms, then response_received with the status and a duration, under METHOD <path template>", async () => {
		/* Fe7: request_start pins 0 for parity; the call's clock must start there, not at the exchange's construction */
		const run = await scripted(
			{ calls: [createUser({ email: "log@cs.test", name: "Log" })], setup: VALID },
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

csDescribe("invalidation", () => {
	/* ported: rust-harness.test.ts:284-312, go-harness.test.ts:268 */
	it("marks the GETs a mutation invalidates stale, a templated pattern matching the interpolated path", async () => {
		const calls = [
			listUsers(),
			getUser("user-0"),
			createUser({ email: "z@cs.test", name: "Zed" }),
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

csDescribe("streaming upload", () => {
	/* ported: rust-harness.test.ts:317-329, go-harness.test.ts:300 */
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
