/**
 * The Python test driver's script (contract 29 §4.5, Rust's `sdk.driver.script.test.ts` analog): the script a unit
 * test adds beside a grid cell, decoded strictly; `{observed, trace}` on stdout, the trace's errors read through the
 * exception's attributes (`Trace<PythonError>`); client config, hooks, refresh, log, cancel, a task's cancellation
 * and sleep; the `bytes` outcome's SHA-256 (Python's `hashlib`) against node:crypto; binary bodies, the idempotency
 * key and typed response headers; and what the driver refuses. Driven against `http` and `http-safe`, every leg on
 * `AsyncSDK` and `SDK` with one expectation (the G17 drift check) unless it is marked client-specific.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

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

/** A 300-byte binary body for `files.put`, sent once as a stream when `oneShot`. */
const putFile = (oneShot: boolean): Call => ({
	body: { contentType: "application/octet-stream", kind: "binary", size: 300 },
	operation: "files.put",
	params: { name: oneShot ? "b" : "a" },
	route: { method: "PUT", path: "/files/{name}" },
})
const ORDER: Call = {
	body: { kind: "json", value: { sku: "s" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const ITEM_JSON = { id: "i1", name: "n" }

/** The SDK to drive and the client to drive it on. */
type On = { readonly client: Client; readonly sdk: DrivenPythonSdk }

/** The registry SDK `key` with the driver aimed at it (it must import), on `client`. */
function on(client: Client, key: "http" | "http-safe" = "http"): On {
	const sdk = drivenPythonSdk(key)
	expect(sdk.imported, sdk.stderr).toBe(true)
	return { client, sdk }
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run as `at` says under `options` against a server answering `replies`: the run, the hops and the origin. */
async function drive(at: On, replies: readonly Reply[], calls: readonly Call[], options: Options) {
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const origins = { alt: server.alt, url: server.url }
		const run = await at.sdk.runCalls(cell, origins, { client: at.client, script: options.script })
		return { hops: [...server.hops], run, url: server.url }
	})
}

/** A 307 to `to` on the `origin` listener. */
const hop = (origin: "alt" | "primary", to: string): Reply => ({ redirect: { origin, path: to }, status: 307 })

/** A hook trace entry with the stale fields of a client without invalidation. */
const hook = (entry: Record<string, unknown>) => ({
	invalidatedBy: [],
	isRetry: false,
	isStale: false,
	selector: "",
	...entry,
})

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })
const CANCELED = plain({ chain: ["CanceledError", "HoneyError"], text: "the call was canceled", type: "CanceledError" })
/** A HookError a hook's (or the refresher's) `ValueError(text)` became. */
const hookError = (text: string) =>
	plain({ cause: "ValueError", chain: ["HookError", "HoneyError"], text, type: "HookError" })

describe.skipIf(!PY)("the Python test driver's script: {observed, trace} on stdout", SLOW, () => {
	it.each(CLIENTS)("%s: an empty script traces the time, a no-op hook per phase, no log", async (client) => {
		const { run, url } = await drive(on(client), [OK], [ECHO], { script: {} })
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

	it.each(CLIENTS)("%s: sets the auth header name and prefix; logs with durations", async (client) => {
		const script: Script = {
			config: { authHeaderName: "X-Token", authHeaderPrefix: "Token " },
			log: true,
			logDurations: true,
		}
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const { hops, run } = await drive(on(client), [OK, OK], [ECHO, ECHO], { script, setup })
		const log = run.trace?.log ?? []
		const operation = "GET /echo"
		const entries = [
			{ event: "request_start", level: "debug", operation },
			{ event: "response_received", level: "info", operation, status: 200 },
		]
		expect(
			{
				auth: hops.map((h) => [h.headers["x-token"], h.headers.authorization]),
				durations: log.map((entry) => Number.isInteger(entry.durationMs) && (entry.durationMs ?? -1) >= 0),
				log: log.map((entry) => ({ ...entry, durationMs: undefined })),
			},
			run.stderr,
		).toEqual({
			auth: [
				["Token tok", undefined],
				["Token tok", undefined],
			],
			durations: [true, true, true, true],
			log: [...entries, ...entries],
		})
	})
})

describe.skipIf(!PY)("the Python test driver's script: client config", SLOW, () => {
	it.each(CLIENTS)("%s: invalidation marks a read after a mutation stale, by the mutation", async (client) => {
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
		const { run } = await drive(on(client), replies, [create, read], { script })
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

	it.each(CLIENTS)("%s: maxResponseBytes caps an answer: observed null, traced", async (client) => {
		const script: Script = { config: { maxResponseBytes: 10 } }
		const replies: Reply[] = [{ bytes: 64, headers: { "content-type": "application/json" }, status: 200 }]
		const { run } = await drive(on(client), replies, [ECHO], { script })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed, status: run.status }, run.stderr).toEqual({
			error: plain({
				chain: ["APIConnectionError", "HoneyError"],
				text: "the answer exceeds 10 bytes",
				type: "APIConnectionError",
			}),
			observed: [null],
			status: 0,
		})
	})
})

describe.skipIf(!PY)("the Python test driver's script: on_auth_expired and the hooks", SLOW, () => {
	it.each(CLIENTS)("%s: refreshes from the tokens, then fails (Fc8's text); retries see is_retry", async (client) => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ status: 401 }, FOUND, { status: 401 }]
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { hops, run } = await drive(on(client), replies, [MEMBERS, MEMBERS], { script, setup })
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

	it.each(CLIENTS)("%s: runs the hooks in order: a set header is sent, a body replaced", async (client) => {
		const hooks: Script["hooks"] = {
			request: [{ setHeader: ["X-Hooked", "1"] }, {}],
			response: [{ body: '{"ok":false}' }],
		}
		const { hops, run } = await drive(on(client), [OK], [ECHO], { script: { hooks } })
		const order = run.trace?.hooks.map((h) => `${h.phase} ${h.index}`)
		expect({ observed: run.observed, order, sent: hops[0]?.headers["x-hooked"] }, run.stderr).toEqual({
			observed: [{ data: { ok: false }, kind: "data", status: 200 }],
			order: ["request 0", "request 1", "response 0"],
			sent: "1",
		})
	})

	it.each(CLIENTS)("%s: a raising hook ends the call as HookError with its text (Fc8)", async (client) => {
		const at = on(client)
		const failing = (request: { fail: string }[], response: { fail: string }[]) =>
			drive(at, [OK], [ECHO], { script: { hooks: { request, response } } })
		const before = await failing([{ fail: "boom" }], [])
		const after = await failing([], [{ fail: "bad" }])
		const ended = (r: typeof before) => [r.run.observed, r.run.trace?.calls[0]?.error, r.hops.length]
		expect({ after: ended(after), before: ended(before) }, before.run.stderr + after.run.stderr).toEqual({
			after: [[null], hookError("hook: bad"), 1],
			before: [[null], hookError("hook: boom"), 0],
		})
	})
})

describe.skipIf(!PY)("the Python test driver's script: a caller's httpx2 client", SLOW, () => {
	it.each(CLIENTS)("%s: a caller client's headers on every same-origin hop; no transport", async (client) => {
		const script: Script = { config: { httpClient: true } }
		const { hops, run } = await drive(on(client), [hop("primary", "/landing"), OK], [ECHO], { script })
		const seen = hops.map((h) => `${h.origin} ${h.url} ${h.headers["user-agent"]} ${h.headers["x-builder"]}`)
		expect({ hops: seen, observed: run.observed, transport: run.trace?.transport }, run.stderr).toEqual({
			hops: ["primary /echo honey-driver b", "primary /landing honey-driver b"],
			observed: [OK_DATA],
			transport: undefined,
		})
	})

	it.each(CLIENTS)("%s: a cross-origin hop drops the caller client's headers and auth (Fc7)", async (client) => {
		const script: Script = { config: { httpClient: true } }
		const setup: Setup = { auth: { kind: "bearer", token: "t" }, redirect: "follow" }
		const { hops, run } = await drive(on(client), [hop("alt", "/landing"), OK], [ECHO], { script, setup })
		const second = hops[1]?.headers ?? {}
		const origins = hops.map((h) => `${h.origin} ${h.url}`)
		const landed = [second["user-agent"], second["x-builder"], second.authorization]
		expect({ landed, observed: run.observed, origins }, run.stderr).toEqual({
			landed: ["honey-driver", undefined, undefined],
			observed: [OK_DATA],
			origins: ["primary /echo", "alt /landing"],
		})
	})
})

describe.skipIf(!PY)("the Python test driver's script: cancel, a task's cancellation and sleep", SLOW, () => {
	it.each(CLIENTS)("%s: cancels before a call or during it; sleeps outside elapsedMs", async (client) => {
		const script: Script = { calls: [{ cancel: "before" }, { cancel: { afterMs: 1000 } }, { sleepMs: 1000 }] }
		const started = Date.now()
		const { hops, run } = await drive(on(client), [{ ...OK, delayMs: 3000 }, OK], [ECHO, ECHO, ECHO], { script })
		const calls = run.trace?.calls ?? []
		const during = calls[1]?.elapsedMs ?? -1
		expect(
			{
				errors: calls.map((c) => c.error),
				hops: hops.length,
				observed: run.observed,
				slept: Date.now() - started >= 1000 && (calls[2]?.elapsedMs ?? 1000) < 1000,
				/* client-specific by design (G22): AsyncSDK races the cancel, a blocking read is not interrupted */
				timed: client === "async" ? during < 2500 : during >= 2900,
			},
			run.stderr,
		).toEqual({
			errors: [CANCELED, CANCELED, undefined],
			hops: 2,
			observed: [null, null, OK_DATA],
			slept: true,
			timed: true,
		})
	})

	it("async: cancelling a call's task is CancelledError, outside the SDK's errors, observed null", async () => {
		const script: Script = { calls: [{ taskCancel: { afterMs: 1000 } }] }
		const { hops, run } = await drive(on("async"), [{ ...OK, delayMs: 3000 }], [ECHO], { script })
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: plain({ chain: ["CancelledError"], text: "", type: "CancelledError" }),
			hops: 1,
			observed: [null],
		})
	})
})

describe.skipIf(!PY)(
	"the Python test driver's script: request bodies, the idempotency key, typed headers",
	SLOW,
	() => {
		it.each(CLIENTS)("%s: a binary body in memory or one-shot, the key it sets, typed headers", async (client) => {
			const script: Script = { calls: [null, { oneShotBody: true }, { idempotencyKey: "k-1" }] }
			const replies: Reply[] = [
				{ json: { size: 300 }, status: 200 },
				{ json: { size: 300 }, status: 200 },
				{ json: { id: "o1" }, status: 201 },
				{ headers: { "x-etag": "e1", "x-item-version": "3" }, json: ITEM_JSON, status: 200 },
			]
			const calls = [putFile(false), putFile(true), ORDER, ITEM]
			const { hops, run } = await drive(on(client), replies, calls, { script })
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
					{ data: ITEM_JSON, headers: { "x-etag": "e1", "x-item-version": "3" }, kind: "data", status: 200 },
				],
			})
		})

		it.each(CLIENTS)("%s: an answer without a required declared header is DecodeError (Fc5)", async (client) => {
			const replies: Reply[] = [{ headers: { "x-etag": "e1" }, json: ITEM_JSON, status: 200 }]
			const { run } = await drive(on(client), replies, [ITEM], { script: {} })
			const text = "the X-Item-Version header is missing"
			expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
				error: plain({ chain: ["DecodeError", "HoneyError"], text, type: "DecodeError" }),
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

describe.skipIf(!PY)("the Python test driver: the bytes outcome", SLOW, () => {
	it.each(CLIENTS)("%s: a binary answer is its size and SHA-256, equal to node's", async (client) => {
		const { run } = await drive(on(client), FILE_REPLIES, FILES, {})
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: SIZES.map((size) => ({ kind: "bytes", sha256: digest(bytes(size)), size, status: 200 })),
			status: 0,
		})
	})
})

const MISSING: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
/** MISSING as the trace records it, read through APIStatusError's attributes. */
const MISSING_ERROR = plain({
	chain: ["NotFoundError", "APIStatusError", "HoneyError"],
	key: "member.missing",
	keyMember: null,
	message: "gone",
	status: 404,
	text: "HTTP 404: gone",
	type: "NotFoundError",
})
const MISSING_SEEN = { body: MISSING.json, errorKey: "member.missing", kind: "error", status: 404 }

describe.skipIf(!PY)("the Python test driver's script: a call's Python error", SLOW, () => {
	it.each(CLIENTS)("%s: an error status through its attributes; safe mode's via result", async (client) => {
		const thrown = await drive(on(client), [MISSING], [MEMBERS], { script: {} })
		const safe = await drive(on(client, "http-safe"), [MISSING, FOUND], [MEMBERS, MEMBERS], { script: {} })
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

	it.each(CLIENTS)("%s: the envelope under envelope: set members, extra keys, nothing else", async (client) => {
		const fields = { text: [{ error_key: "too_short", message: "short", path: "text" }] }
		const sent = { error_key: "bad_request", fields, message: "Bad request", status: 400, status_key: "bad_request" }
		const bad: Reply = { json: { ...sent, success: false, trace: "t1" }, status: 400 }
		const refused: Call = { ...MEMBERS, params: { org: "..", "user-id": "u" } }
		const asked: Script = { calls: [{ envelope: true }, null, { envelope: true }] }
		const { hops, run } = await drive(on(client), [bad, bad], [MEMBERS, MEMBERS, refused], { script: asked })
		const [enveloped, unasked, path] = run.trace?.calls ?? []
		const text = "path parameter 'org' is missing, empty, '.' or '..'"
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
			path: plain({ chain: ["PathParamError", "HoneyError"], text, type: "PathParamError" }),
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
	[UPLOAD, {}],
	[ECHO, { calls: [{ idempotencyKey: "k" }] }],
	[ECHO, { calls: [null, null] }],
	[ECHO, { logDurations: true }],
]
const REASONS = [
	"driver: script: unknown member wait",
	"driver: script: call 0: ctxTimeoutMs is Go's ctx deadline; a Python call is bounded by timeoutMs",
	"driver: script: call 0: isKeys is Go's errors.Is; the Python trace records key",
	"driver: script: call 0: isErrors is Go's errors.Is; the Python trace records the type and text",
	"driver: call 0 (files.upload): a multipart body is driven by a consumer program (FilePart)",
	"driver: call 0 (echo.get): the script sets idempotencyKey, and the method has no idempotency key field",
	"driver: script: 2 calls scripted for a cell of 1",
	"driver: script: logDurations needs log",
]

/** Each refused `[call, script]` run on `client` against one server: each run's status, output and reason, and the hops. */
const refusals = (client: Client, refused: readonly (readonly [Call, Script])[]) =>
	served([], async (server) => {
		const { sdk } = on(client)
		const ran = await Promise.all(
			refused.map(([call, script]) => sdk.runCalls({ calls: [call] }, { url: server.url }, { client, script })),
		)
		return {
			hops: server.hops.length,
			runs: ran.map((run) => [run.status, run.observed, run.trace, run.stderr.trim()]),
		}
	})

describe.skipIf(!PY)("the Python test driver's script: what it refuses", SLOW, () => {
	it.each(CLIENTS)("%s: exits 1 naming the reason, nothing sent", async (client) => {
		expect(await refusals(client, REFUSED)).toEqual({
			hops: 0,
			runs: REASONS.map((reason) => [1, undefined, undefined, reason]),
		})
	})

	it("sync: refuses taskCancel, an AsyncSDK task's", async () => {
		expect(await refusals("sync", [[ECHO, { calls: [{ taskCancel: { afterMs: 1 } }] }]])).toEqual({
			hops: 0,
			runs: [[1, undefined, undefined, "driver: script: call 0: taskCancel is an AsyncSDK task's; SDK has none"]],
		})
	})
})
