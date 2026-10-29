/**
 * The C# test driver's script (contract 47 §4.4, Python's `sdk.driver.script.test.ts` analog): the script a unit
 * test adds beside a grid cell, decoded strictly; `{observed, trace}` on stdout, the trace's errors read through the
 * exception's members (`Trace<CsError>`); client config, hooks, refresh, log, cancel and sleep; a caller handler
 * chain under the SDK's strip; the `bytes` outcome's SHA-256 (.NET's `SHA256`) against node:crypto; binary bodies
 * (`byte[]` and one-shot), the idempotency key and typed response headers; and what the driver refuses. Driven
 * against `http` on C#'s one async client and its `client.Safe` mirror: there is no second client, so no drift check.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const MEMBERS: Call = {
	operation: "members.get",
	params: { org: "o", "user-id": "u" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
}
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const FOUND: Reply = { json: { id: "u", name: "n" }, status: 200 }
const DATA = { data: { id: "u", name: "n" }, kind: "data", status: 200 }

/** The sizes the SHA-256 is checked at: around each block boundary (55 and 56 change the padding), and large. */
const SIZES = [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 256, 4096, 65_536]

/** `size` bytes `i & 0xff`, the grid's binary body and the recording server's `bytes` reply. */
const bytes = (size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex")

/** A 300-byte binary body for `files.put`: a `byte[]`, or a one-shot `Stream` under the script's `oneShotBody`. */
const putFile = (name: string): Call => ({
	body: { contentType: "application/octet-stream", kind: "binary", size: 300 },
	operation: "files.put",
	params: { name },
	route: { method: "PUT", path: "/files/{name}" },
})
const ORDER: Call = {
	body: { kind: "json", value: { sku: "s" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const ITEM_JSON = { id: "i1", name: "n" }

/** The registry SDK `key` with the driver aimed at it (it must build). */
function on(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup; readonly safe?: boolean }

/** `calls` run on `sdk` (its `client.Safe` under `safe`) under `options` against a server answering `replies`: the run, the hops, their raw lines and the origin. */
async function drive(sdk: DrivenCSharpSdk, replies: readonly Reply[], calls: readonly Call[], options: Options) {
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const origins = { alt: server.alt, url: server.url }
		const run = await sdk.runCalls(cell, origins, { script: options.script }, options.safe)
		return { hops: [...server.hops], lines: [...server.rawHeaders], run, url: server.url }
	})
}

/** A 307 to `to` on the `origin` listener. */
const hop = (origin: "alt" | "primary", to: string): Reply => ({ redirect: { origin, path: to }, status: 307 })

/** A hook trace entry with the stale fields of a client without invalidation. */
const hook = (entry: Record<string, unknown>) => ({
	invalidatedBy: [],
	isRetry: false,
	isStale: false,
	selector: expect.any(String),
	...entry,
})

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
/** A HookException a hook's (or the refresher's) `InvalidOperationException(text)` became. */
const hookError = (text: string) =>
	plain({ chain: ["HookException", "HoneyException"], inner: "InvalidOperationException", text, type: "HookException" })
/** The caller's token, as thrown: .NET throws either cancel type, so only `canceled` is pinned. */
const CANCELED = expect.objectContaining({ canceled: true, via: "return" })

describe.skipIf(!DOTNET)("the C# test driver's script: {observed, trace} on stdout", SLOW, () => {
	it("an empty script traces the time, a no-op hook per phase, no log", async () => {
		const { run, url } = await drive(on(), [OK], [ECHO], { script: {} })
		expect({ observed: run.observed, status: run.status, trace: run.trace }, run.stderr).toEqual({
			observed: [OK_DATA],
			status: 0,
			trace: {
				authExpired: 0,
				calls: [{ elapsedMs: expect.any(Number) }],
				hooks: [
					hook({ call: 0, index: 0, method: "GET", path: "/echo", phase: "request", url: `${url}/echo` }),
					hook({ call: 0, index: 0, phase: "response", status: 200 }),
				],
				log: [],
			},
		})
	})

	it("sets the auth header name and prefix; logs an error status's three entries with durations", async () => {
		const script: Script = {
			config: { authHeaderName: "X-Token", authHeaderPrefix: "Token " },
			log: true,
			logDurations: true,
		}
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const replies: Reply[] = [{ json: { message: "no" }, status: 404 }]
		const { hops, run } = await drive(on(), replies, [ECHO], { script, setup })
		const log = run.trace?.log ?? []
		const operation = "GET /echo"
		expect(
			{
				auth: hops.map((h) => [h.headers["x-token"], h.headers.authorization]),
				durations: log.map((entry) => Number.isInteger(entry.durationMs) && (entry.durationMs ?? -1) >= 0),
				log: log.map((entry) => ({ ...entry, durationMs: undefined })),
			},
			run.stderr,
		).toEqual({
			auth: [["Token tok", undefined]],
			durations: [true, true, true],
			log: [
				{ event: "request_start", level: "debug", operation },
				{ event: "response_received", level: "warn", operation, status: 404 },
				{ error: "NotFoundException: HTTP 404: no", event: "error", level: "error", operation, status: 404 },
			],
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver's script: client config", SLOW, () => {
	it("invalidation marks a read after a mutation stale, by the mutation", async () => {
		const create: Call = {
			body: { kind: "json", value: { name: "a" } },
			operation: "users.create",
			route: { method: "POST", path: "/users" },
		}
		const read: Call = { operation: "users.get", params: { id: "u1" }, route: { method: "GET", path: "/users/{id}" } }
		const script: Script = { config: { invalidation: { staleTimeMs: 60_000 } } }
		const replies: Reply[] = [
			{ json: { id: "u1" }, status: 200 },
			{ json: { id: "u1" }, status: 200 },
		]
		const { run } = await drive(on(), replies, [create, read], { script })
		expect(
			run.trace?.hooks.map((h) => [h.phase, h.selector, h.isStale, h.invalidatedBy]),
			run.stderr,
		).toEqual([
			["request", "POST /users", false, []],
			["response", "POST /users", false, []],
			["request", "GET /users/u1", true, ["POST /users"]],
			["response", "GET /users/u1", true, ["POST /users"]],
		])
	})

	/* bit 21 i5: the status and headers arrived, so a 2xx past the cap is an answer whose body was not read */
	it("maxResponseBytes caps an answer: a 2xx past it is its DecodeException, traced", async () => {
		const script: Script = { config: { maxResponseBytes: 10 } }
		const replies: Reply[] = [{ bytes: 64, headers: { "content-type": "application/json" }, status: 200 }]
		const { run } = await drive(on(), replies, [ECHO], { script })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed, status: run.status }, run.stderr).toEqual({
			error: plain({
				chain: ["DecodeException", "SdkException", "HoneyException"],
				text: "the answer exceeds 10 bytes",
				type: "DecodeException",
			}),
			observed: [null],
			status: 0,
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver's script: OnAuthExpired and the hooks", SLOW, () => {
	it("refreshes from the tokens, then fails (HookException's text); retries see IsRetry", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ status: 401 }, FOUND, { status: 401 }]
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { hops, run } = await drive(on(), replies, [MEMBERS, MEMBERS], { script, setup })
		const requests = run.trace?.hooks.filter((h) => h.phase === "request")
		expect(
			{
				auth: hops.map((h) => h.headers.authorization),
				error: run.trace?.calls[1]?.error,
				expired: run.trace?.authExpired,
				observed: run.observed,
				retries: requests?.map((h) => [h.call, h.isRetry]),
			},
			run.stderr,
		).toEqual({
			auth: ["Bearer old", "Bearer new", "Bearer new"],
			error: hookError("on_auth_expired: driver: no token left"),
			expired: 2,
			observed: [DATA, null],
			retries: [
				[0, false],
				[0, true],
				[1, false],
			],
		})
	})

	it("runs the hooks in order: a set header replaces its layer as one raw line, a body replaced decodes", async () => {
		const hooks: Script["hooks"] = {
			request: [{ setHeader: ["x-request-id", "hooked"] }, {}],
			response: [{ body: '{"ok":false}' }],
		}
		const { lines, run } = await drive(on(), [OK], [ECHO], { script: { hooks } })
		const order = run.trace?.hooks.map((h) => `${h.phase} ${h.index}`)
		const sent = lines[0]?.filter(([name]) => name === "x-request-id")
		expect({ observed: run.observed, order, sent }, run.stderr).toEqual({
			observed: [{ data: { ok: false }, kind: "data", status: 200 }],
			order: ["request 0", "request 1", "response 0"],
			sent: [["x-request-id", "hooked"]],
		})
	})

	it("a throwing hook ends the call as HookException with its text and its exception inner", async () => {
		const sdk = on()
		const failing = (request: { fail: string }[], response: { fail: string }[]) =>
			drive(sdk, [OK], [ECHO], { script: { hooks: { request, response } } })
		const before = await failing([{ fail: "boom" }], [])
		const after = await failing([], [{ fail: "bad" }])
		const ended = (r: typeof before) => [r.run.observed, r.run.trace?.calls[0]?.error, r.hops.length]
		expect({ after: ended(after), before: ended(before) }, before.run.stderr + after.run.stderr).toEqual({
			after: [[null], hookError("hook: bad"), 1],
			before: [[null], hookError("hook: boom"), 0],
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver's script: a caller handler chain (ClientConfig.Handler)", SLOW, () => {
	it("a caller link's headers on every same-origin hop", async () => {
		const script: Script = { config: { httpClient: true } }
		const { hops, run } = await drive(on(), [hop("primary", "/landing"), OK], [ECHO], { script })
		const seen = hops.map((h) => `${h.origin} ${h.url} ${h.headers["user-agent"]} ${h.headers["x-builder"]}`)
		expect({ hops: seen, observed: run.observed, transport: run.trace?.transport }, run.stderr).toEqual({
			hops: ["primary /echo honey-driver b", "primary /landing honey-driver b"],
			observed: [OK_DATA],
			transport: undefined,
		})
	})

	it("a cross-origin hop drops the caller link's headers and auth (the strip); the install turned redirects off", async () => {
		const script: Script = { config: { httpClient: true } }
		const follow: Setup = { auth: { kind: "bearer", token: "t" }, redirect: "follow" }
		const crossed = await drive(on(), [hop("alt", "/landing"), OK], [ECHO], { script, setup: follow })
		/* under SameOrigin a primary still following would show a second hop and a 200 */
		const refused = await drive(on(), [hop("alt", "/landing"), OK], [ECHO], { script })
		const second = crossed.hops[1]?.headers ?? {}
		expect(
			{
				landed: [second["user-agent"], second["x-builder"], second.authorization],
				observed: [crossed.run.observed, refused.run.observed],
				origins: [crossed.hops, refused.hops].map((hops) => hops.map((h) => `${h.origin} ${h.url}`)),
			},
			crossed.run.stderr + refused.run.stderr,
		).toEqual({
			landed: ["honey-driver", undefined, undefined],
			observed: [[OK_DATA], [{ errorKey: null, kind: "error", status: 307 }]],
			origins: [["primary /echo", "alt /landing"], ["primary /echo"]],
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver's script: cancel and sleep", SLOW, () => {
	it("cancels before a call or during it on the method's token; sleeps outside elapsedMs", async () => {
		/* one unbounded call first: .NET's first request on a starved core (JIT, connect) can outlast the 300 ms cancel */
		const script: Script = { calls: [null, { cancel: "before" }, { cancel: { afterMs: 300 } }, { sleepMs: 1000 }] }
		const echoes = [{ ...ECHO, timeoutMs: 0 }, ECHO, ECHO, ECHO]
		const started = Date.now()
		const { hops, run } = await drive(on(), [OK, { ...OK, delayMs: 2000 }, OK], echoes, { script })
		const calls = run.trace?.calls ?? []
		expect(
			{
				during: (calls[2]?.elapsedMs ?? 1500) < 1500,
				errors: calls.map((c) => c.error),
				hops: hops.length,
				observed: run.observed,
				slept: Date.now() - started >= 1000 && (calls[3]?.elapsedMs ?? 1000) < 1000,
			},
			run.stderr,
		).toEqual({
			during: true,
			errors: [undefined, CANCELED, CANCELED, undefined],
			hops: 3,
			observed: [OK_DATA, null, null, OK_DATA],
			slept: true,
		})
	})
})

describe.skipIf(!DOTNET)(
	"the C# test driver's script: request bodies, the idempotency key, typed headers",
	SLOW,
	() => {
		it("a binary body as byte[] or one-shot Stream, the key it sets, typed headers", async () => {
			const script: Script = { calls: [null, { oneShotBody: true }, { idempotencyKey: "k-1" }] }
			const replies: Reply[] = [
				{ json: { size: 300 }, status: 200 },
				{ json: { size: 300 }, status: 200 },
				{ json: { id: "o1" }, status: 201 },
				{ headers: { "x-etag": "e1", "x-item-version": "3" }, json: ITEM_JSON, status: 200 },
			]
			const { hops, run } = await drive(on(), replies, [putFile("a"), putFile("b"), ORDER, ITEM], { script })
			const framing = (h: (typeof hops)[number]) => [
				h.headers["content-length"] ?? "-",
				h.headers["transfer-encoding"] ?? "-",
			]
			const sent = digest(bytes(300))
			expect(
				{
					bodies: hops.slice(0, 2).map((h) => [h.body.sha256, h.body.size, ...framing(h)]),
					key: hops[2]?.headers["idempotency-key"],
					observed: run.observed,
				},
				run.stderr,
			).toEqual({
				bodies: [
					[sent, 300, "300", "-"],
					[sent, 300, "-", "chunked"],
				],
				key: "k-1",
				observed: [
					{ data: { size: 300 }, kind: "data", status: 200 },
					{ data: { size: 300 }, kind: "data", status: 200 },
					{ data: { id: "o1" }, kind: "data", status: 201 },
					{ data: ITEM_JSON, headers: { "X-Etag": "e1", "X-Item-Version": "3" }, kind: "data", status: 200 },
				],
			})
		})

		it("an answer without a required declared header is DecodeException (Fc7)", async () => {
			const replies: Reply[] = [{ headers: { "x-etag": "e1" }, json: ITEM_JSON, status: 200 }]
			const { run } = await drive(on(), replies, [ITEM], { script: {} })
			const text = "the X-Item-Version header is missing"
			expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
				error: plain({ chain: ["DecodeException", "SdkException", "HoneyException"], text, type: "DecodeException" }),
				observed: [null],
			})
		})
	},
)

/** One `files.get` per size, and the answers: that many bytes each. */
const FILES: readonly Call[] = SIZES.map((size) => ({
	operation: "files.get",
	params: { name: `f${size}` },
	route: { method: "GET", path: "/files/{name}" },
}))
const FILE_REPLIES: readonly Reply[] = SIZES.map((size) => ({
	bytes: size,
	headers: { "content-type": "application/octet-stream" },
	status: 200,
}))

describe.skipIf(!DOTNET)("the C# test driver: the bytes outcome", SLOW, () => {
	it("a binary answer is its size and SHA-256, equal to node's", async () => {
		const { run } = await drive(on(), FILE_REPLIES, FILES, {})
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: SIZES.map((size) => ({ kind: "bytes", sha256: digest(bytes(size)), size, status: 200 })),
			status: 0,
		})
	})
})

const MISSING: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
/** MISSING as the trace records it, read through ApiStatusException's members. */
const MISSING_ERROR = plain({
	chain: ["NotFoundException", "ApiStatusException", "SdkException", "HoneyException"],
	key: "member.missing",
	keyMember: null,
	message: "gone",
	status: 404,
	text: "HTTP 404: gone",
	type: "NotFoundException",
})
const MISSING_SEEN = { body: MISSING.json, errorKey: "member.missing", kind: "error", status: 404 }

describe.skipIf(!DOTNET)("the C# test driver's script: a call's C# error", SLOW, () => {
	it("an error status through its members; client.Safe's via result", async () => {
		const thrown = await drive(on(), [MISSING], [MEMBERS], { script: {} })
		const safe = await drive(on(), [MISSING, FOUND], [MEMBERS, MEMBERS], { safe: true, script: {} })
		const stderr = thrown.run.stderr + safe.run.stderr
		expect({ safe: safe.run.trace?.calls, thrown: thrown.run.trace?.calls }, stderr).toEqual({
			safe: [
				{
					elapsedMs: expect.any(Number),
					error: { ...MISSING_ERROR, via: "result" },
					result: { data: false, ok: false, response: true, status: 404 },
				},
				{ elapsedMs: expect.any(Number), result: { data: true, ok: true, response: true, status: 200 } },
			],
			thrown: [{ elapsedMs: expect.any(Number), error: MISSING_ERROR }],
		})
		expect({ safe: safe.run.observed, thrown: thrown.run.observed }).toEqual({
			safe: [MISSING_SEEN, DATA],
			thrown: [MISSING_SEEN],
		})
	})

	it("the envelope under envelope: set members, extra keys, nothing else", async () => {
		const fields = { text: [{ error_key: "too_short", message: "short", path: "text" }] }
		const sent = { error_key: "bad_request", fields, message: "Bad request", status: 400, status_key: "bad_request" }
		const bad: Reply = { json: { ...sent, success: false, trace: "t1" }, status: 400 }
		const refused: Call = { ...MEMBERS, params: { org: "..", "user-id": "u" } }
		const asked: Script = { calls: [{ envelope: true }, null, { envelope: true }] }
		const { hops, run } = await drive(on(), [bad, bad], [MEMBERS, MEMBERS, refused], { script: asked })
		const [enveloped, unasked, path] = run.trace?.calls ?? []
		const text = 'path param org: ".." is not a path segment'
		expect(
			{
				envelope: enveloped?.error?.envelope,
				hops: hops.length,
				path: path?.error,
				unasked: unasked?.error !== undefined && !("envelope" in unasked.error),
			},
			run.stderr,
		).toEqual({
			envelope: { ...sent, extraKeys: ["success", "trace"] },
			hops: 2,
			path: plain({ chain: ["PathParamException", "HoneyException"], text, type: "PathParamException" }),
			unasked: true,
		})
	})
})

const UPLOAD: Call = {
	body: { kind: "json", value: {} },
	operation: "files.upload",
	route: { method: "POST", path: "/upload" },
}
/** What the driver refuses, each a call and its script, in the order of REASONS. */
const REFUSED: readonly (readonly [Call, Script])[] = [
	[ECHO, { calls: [{ sleepMs: 1, wait: 2 } as never] }],
	[ECHO, { calls: [{ ctxTimeoutMs: 100 }] }],
	[ECHO, { calls: [{ isKeys: ["other"] }] }],
	[ECHO, { calls: [{ isErrors: ["ErrSSELineTooLong"] }] }],
	[ECHO, { calls: [{ taskCancel: { afterMs: 1 } }] }],
	[UPLOAD, {}],
	[ECHO, { calls: [{ idempotencyKey: "k" }] }],
	[ECHO, { calls: [null, null] }],
	[ECHO, { logDurations: true }],
]
const REASONS = [
	"driver: script: unknown member wait",
	"driver: script: call 0: ctxTimeoutMs is Go's ctx deadline; a C# call is bounded by timeoutMs",
	"driver: script: call 0: isKeys is Go's errors.Is; the C# trace records key",
	"driver: script: call 0: isErrors is Go's errors.Is; the C# trace records the type and text",
	"driver: script: call 0: taskCancel is a Python AsyncSDK task's; a C# call ends by its token (cancel)",
	"driver: call 0 (files.upload): a multipart body is driven by a consumer program (FilePart)",
	"driver: call 0 (echo.get): the script sets idempotencyKey, and the method has no idempotency key field",
	"driver: script: 2 calls scripted for a cell of 1",
	"driver: script: logDurations needs log",
]

describe.skipIf(!DOTNET)("the C# test driver's script: what it refuses", SLOW, () => {
	it("exits 1 naming the reason, nothing sent", async () => {
		const sdk = on()
		const refusals = await served([], async (server) => {
			const ran = await Promise.all(
				REFUSED.map(([call, script]) => sdk.runCalls({ calls: [call] }, { url: server.url }, { script })),
			)
			return {
				hops: server.hops.length,
				runs: ran.map((run) => [run.status, run.observed, run.trace, run.stderr.trim()]),
			}
		})
		expect(refusals).toEqual({ hops: 0, runs: REASONS.map((reason) => [1, undefined, undefined, reason]) })
	})
})
