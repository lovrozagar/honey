import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import type { GoError, Script } from "../shared/__fixtures__/protocol.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const NOTE = { properties: { id: STRING, text: STRING }, required: ["id", "text"], type: "object" }
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const path = (name: string) => ({ in: "path", name, required: true, schema: STRING })

/** A JSON create and get under a path param, and a binary download: what the script legs call. */
const SCRIPTED: Json = {
	info: { title: "Scripted", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/files/{name}": {
			get: {
				operationId: "files.get",
				parameters: [path("name")],
				responses: { 200: { content: { "application/octet-stream": {} }, description: "ok" } },
			},
		},
		"/orgs/{org}/notes": {
			post: {
				operationId: "notes.create",
				parameters: [path("org")],
				requestBody: { ...json({ properties: { text: STRING }, type: "object" }), required: true },
				responses: { 200: { ...json(NOTE), description: "ok" } },
			},
		},
		"/orgs/{org}/notes/{id}": {
			get: { operationId: "notes.get", parameters: [path("org"), path("id")], responses: { 200: json(NOTE) } },
		},
	},
}

const GET: Call = {
	operation: "notes.get",
	params: { id: "n1", org: "o" },
	route: { method: "GET", path: "/orgs/{org}/notes/{id}" },
}
const POST: Call = {
	body: { kind: "json", value: { text: "hi" } },
	operation: "notes.create",
	params: { org: "o" },
	route: { method: "POST", path: "/orgs/{org}/notes" },
}
const FOUND: Reply = { json: { id: "n1", text: "hi" }, status: 200 }
const DATA = { data: { id: "n1", text: "hi" }, kind: "data", status: 200 }

/** The SDK for SCRIPTED compiled with the driver, which must build and vet clean. */
function scriptedSdk(throwOnError?: boolean): DrivenSdk {
	const sdk = compiledSdk(SCRIPTED, { modulePath: "example.com/scripted", throwOnError })
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/** `calls` run by `sdk` under `script` against a server answering `replies`: the run, the hops and the origins. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], options: Options) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { hops: [...server.hops], run, url: server.url }
	})
}
type Options = { readonly script: Script; readonly setup?: Setup }

/** A 307 to `to` on the `origin` listener. */
const hop = (origin: "alt" | "primary", to: string): Reply => ({ redirect: { origin, path: to }, status: 307 })

/** A hook trace entry with the stale fields of a client without invalidation. */
const hook = (entry: Json) => ({ invalidatedBy: [], isRetry: false, isStale: false, selector: "", ...entry })

/** A Go error of no honey type, as the trace records it. */
const plain = (entry: Partial<GoError>) => ({
	canceled: false,
	deadline: false,
	tooLarge: false,
	via: "return",
	...entry,
})

/** The `*sdk.` entries of an error's chain: the only ones a test may pin. */
const sdkTypes = (error: GoError | undefined) => error?.chain.filter((type) => type.startsWith("*sdk."))

goDescribe("the Go test driver's script: {observed, trace} on stdout", () => {
	it("records each call's time, a no-op hook per phase, no log and no refresh for an empty script", async () => {
		const { run, url } = await drive(scriptedSdk(), [FOUND], [GET], { script: {} })
		expect({ observed: run.observed, status: run.status, trace: run.trace }, run.stderr).toEqual({
			observed: [DATA],
			status: 0,
			trace: {
				authExpired: 0,
				calls: [{ elapsedMs: expect.any(Number) }],
				hooks: [
					hook({
						call: 0,
						index: 0,
						method: "GET",
						path: "/orgs/o/notes/n1",
						phase: "request",
						url: `${url}/orgs/o/notes/n1`,
					}),
					hook({ call: 0, index: 0, phase: "response", status: 200 }),
				],
				log: [],
			},
		})
	}, 600_000)

	it("sets the auth header name and prefix and records OnLog, the operation never the concrete path", async () => {
		const script: Script = { config: { authHeaderName: "X-Token", authHeaderPrefix: "Token " }, log: true }
		const replies: Reply[] = [FOUND, { json: { message: "gone" }, status: 404 }]
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const { hops, run } = await drive(scriptedSdk(), replies, [GET, GET], { script, setup })
		const operation = "GET /orgs/{org}/notes/{id}"
		expect({ auth: hops.map((h) => [h.headers["x-token"], h.headers.authorization]), log: run.trace?.log }).toEqual({
			auth: [
				["Token tok", undefined],
				["Token tok", undefined],
			],
			log: [
				{ event: "request_start", level: "debug", operation },
				{ event: "response_received", level: "info", operation, status: 200 },
				{ event: "request_start", level: "debug", operation },
				{ event: "response_received", level: "warn", operation, status: 404 },
				{ error: "HTTP 404: gone", event: "error", level: "error", operation, status: 404 },
			],
		})
	}, 600_000)
})

goDescribe("the Go test driver's script: OnAuthExpired and the hooks", () => {
	it("answers OnAuthExpired from its tokens in order, then fails it; a retry's hooks see isRetry", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ status: 401 }, FOUND, { status: 401 }]
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { hops, run } = await drive(scriptedSdk(), replies, [GET, GET], { script, setup })
		const requests = run.trace?.hooks.filter((h) => h.phase === "request")
		expect({
			auth: hops.map((h) => h.headers.authorization),
			error: run.trace?.calls[1]?.error,
			expired: run.trace?.authExpired,
			observed: run.observed,
			retries: requests?.map((h) => [h.call, h.isRetry]),
		}).toEqual({
			auth: ["Bearer old", "Bearer new", "Bearer new"],
			error: plain({
				chain: ["*fmt.wrapError", "*errors.errorString"],
				text: "honey: OnAuthExpired failed: driver: no token left",
				type: "*fmt.wrapError",
			}),
			expired: 2,
			observed: [DATA, null],
			retries: [
				[0, false],
				[0, true],
				[1, false],
			],
		})
	}, 600_000)

	it("runs the scripted hooks in order: a set header is sent, a body replaced, a failure ends the call", async () => {
		const sdk = scriptedSdk()
		const hooks: Script["hooks"] = {
			request: [{ setHeader: ["X-Hooked", "1"] }, {}],
			response: [{ body: '{"id":"h","text":"hooked"}' }],
		}
		const shaped = await drive(sdk, [FOUND], [GET], { script: { hooks } })
		const failing = (request: Json[], response: Json[]) =>
			drive(sdk, [FOUND], [GET], { script: { hooks: { request, response } } })
		const [before, after] = await Promise.all([failing([{ fail: "boom" }], []), failing([], [{ fail: "bad" }])])
		expect({
			after: [after.run.observed, after.run.trace?.calls[0]?.error?.text, after.hops.length],
			before: [before.run.observed, before.run.trace?.calls[0]?.error?.text, before.hops.length],
			observed: shaped.run.observed,
			order: shaped.run.trace?.hooks.map((h) => `${h.phase} ${h.index}`),
			sent: shaped.hops[0]?.headers["x-hooked"],
		}).toEqual({
			after: [[null], "honey: OnResponse hook: bad", 1],
			before: [[null], "honey: OnRequest hook: boom", 0],
			observed: [{ data: { id: "h", text: "hooked" }, kind: "data", status: 200 }],
			order: ["request 0", "request 1", "response 0"],
			sent: "1",
		})
	}, 600_000)
})

goDescribe("the Go test driver's script: client config", () => {
	it("turns on invalidation: every hook sees its call's concrete selector", async () => {
		const script: Script = { config: { invalidation: { staleTimeMs: 60_000 } } }
		const { run } = await drive(scriptedSdk(), [FOUND, FOUND], [POST, GET], { script })
		expect(run.trace?.hooks.map((h) => [h.phase, h.selector, h.isStale, h.invalidatedBy])).toEqual([
			["request", "POST /orgs/o/notes", false, []],
			["response", "POST /orgs/o/notes", false, []],
			["request", "GET /orgs/o/notes/n1", false, []],
			["response", "GET /orgs/o/notes/n1", false, []],
		])
	}, 600_000)

	it("caps a buffered body by maxResponseBytes: a non-grid error observed as null, tooLarge in the trace", async () => {
		const script: Script = { config: { maxResponseBytes: 8 } }
		const replies: Reply[] = [{ bytes: 64, headers: { "content-type": "application/json" }, status: 200 }]
		const { run } = await drive(scriptedSdk(), replies, [GET], { script })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed, status: run.status }).toEqual({
			error: plain({
				chain: ["*fmt.wrapError", "*errors.errorString"],
				text: "honey: http do: honey: response body exceeds MaxResponseBytes",
				tooLarge: true,
				type: "*fmt.wrapError",
			}),
			observed: [null],
			status: 0,
		})
	}, 600_000)

	it("sends through a caller HTTPClient whose transport and CheckRedirect count, over both redirect origins", async () => {
		const sdk = scriptedSdk()
		const script: Script = { config: { httpClient: true } }
		const same = await drive(sdk, [hop("primary", "/orgs/o/notes/n2"), FOUND], [GET], { script })
		const setup: Setup = { auth: { kind: "bearer", token: "t" }, redirect: "follow" }
		const cross = await drive(sdk, [hop("alt", "/landing"), FOUND], [GET], { script, setup })
		const seen = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
			hops: hops.map((h) => `${h.origin} ${h.url} ${h.headers.authorization ?? "-"}`),
			observed: run.observed,
			transport: run.trace?.transport,
		})
		expect({ cross: seen(cross), same: seen(same) }).toEqual({
			cross: {
				hops: ["primary /orgs/o/notes/n1 Bearer t", "alt /landing -"],
				observed: [DATA],
				transport: { checkRedirect: 1, roundTrips: 2 },
			},
			same: {
				hops: ["primary /orgs/o/notes/n1 -", "primary /orgs/o/notes/n2 -"],
				observed: [DATA],
				transport: { checkRedirect: 1, roundTrips: 2 },
			},
		})
	}, 600_000)
})

goDescribe("the Go test driver's script: per-call directives", () => {
	it("cancels before or during a call, bounds it by a caller deadline, and sleeps before it", async () => {
		const script: Script = {
			calls: [{ cancel: "before" }, { cancel: { afterMs: 300 } }, { ctxTimeoutMs: 300 }, { sleepMs: 1000 }],
		}
		const late: Reply = { ...FOUND, delayMs: 2000 }
		const started = Date.now()
		const { hops, run } = await drive(scriptedSdk(), [late, late, FOUND], [GET, GET, GET, GET], { script })
		const calls = run.trace?.calls ?? []
		expect({
			flags: calls.map((c) => [c.error?.canceled, c.error?.deadline, sdkTypes(c.error)]),
			hops: hops.length,
			observed: run.observed,
			quick: calls.map((c) => c.elapsedMs < 1500),
			slept: Date.now() - started >= 1000 && (calls[3]?.elapsedMs ?? 1000) < 1000,
			waited: (calls[2]?.elapsedMs ?? 0) >= 300,
		}).toEqual({
			flags: [
				[true, false, []],
				[true, false, []],
				[false, true, []],
				[undefined, undefined, undefined],
			],
			hops: 3,
			observed: [null, null, { kind: "timeout" }, DATA],
			quick: [true, true, true, true],
			slept: true,
			waited: true,
		})
	}, 600_000)
})

goDescribe("the Go test driver's script: a call's Go error", () => {
	it("traces an error status's Go types, status and keys; safe mode's via result and SDKResult", async () => {
		const invalid: Reply = { json: { error_key: "note.invalid", message: "bad" }, status: 422 }
		const script: Script = { calls: [{ isKeys: ["note.invalid", "other"] }] }
		const thrown = await drive(scriptedSdk(), [invalid], [GET], { script })
		const safe = await drive(scriptedSdk(false), [invalid, FOUND], [GET, GET], { script })
		const error = {
			...plain({
				chain: ["*sdk.UnprocessableEntityError", "*sdk.ClientError"],
				text: "HTTP 422: bad",
				type: "*sdk.UnprocessableEntityError",
			}),
			keys: { "note.invalid": true, other: false },
			status: 422,
		}
		expect({ safe: safe.run.trace?.calls, thrown: thrown.run.trace?.calls }).toEqual({
			safe: [
				{
					elapsedMs: expect.any(Number),
					error: { ...error, via: "result" },
					result: { data: false, ok: false, response: true, status: 422 },
				},
				{ elapsedMs: expect.any(Number), result: { data: true, ok: true, response: true, status: 200 } },
			],
			thrown: [{ elapsedMs: expect.any(Number), error }],
		})
		expect(safe.run.observed).toEqual([
			{ body: invalid.json, errorKey: "note.invalid", kind: "error", status: 422 },
			DATA,
		])
	}, 600_000)

	it("traces a refused path param as *sdk.PathParamError, nothing sent, and an undecodable body as null", async () => {
		const undecodable: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
		const calls: Call[] = [{ ...GET, params: { id: "..", org: "o" } }, GET]
		const { hops, run } = await drive(scriptedSdk(), [undecodable], calls, { script: {} })
		const [refused, decoded] = run.trace?.calls ?? []
		expect({
			decoded: [sdkTypes(decoded?.error), decoded?.error?.text.startsWith("honey: decode response:")],
			hops: hops.map((h) => h.url),
			observed: run.observed,
			refused: refused?.error,
		}).toEqual({
			decoded: [[], true],
			hops: ["/orgs/o/notes/n1"],
			observed: [null, null],
			refused: plain({
				chain: ["*sdk.PathParamError"],
				pathParam: { missing: false, name: "id", value: ".." },
				text: 'Invalid path param "id": ".." is not a path segment',
				type: "*sdk.PathParamError",
			}),
		})
	}, 600_000)
})

goDescribe("the Go test driver's script: opt-in trace members", () => {
	it("adds each OnLog entry's durationMs under logDurations, a ClientError's typed envelope under envelope, neither unasked", async () => {
		const sdk = scriptedSdk()
		const fields = { text: [{ error_key: "too_short", message: "short", path: "text" }] }
		const envelope = {
			error_key: "bad_request",
			fields,
			message: "Bad request",
			status: 400,
			status_key: "bad_request",
		}
		const replies: Reply[] = [
			{ ...FOUND, delayMs: 50 },
			{ json: { ...envelope, trace: "t1" }, status: 400 },
		]
		const calls = [GET, GET, { ...GET, params: { id: "..", org: "o" } }]
		const asked = {
			calls: [{ envelope: true }, { envelope: true }, { envelope: true }],
			log: true,
			logDurations: true,
		} as const
		const [on, off] = await Promise.all([
			drive(sdk, replies, calls, { script: asked }),
			drive(sdk, replies, calls, { script: { calls: [null, { isKeys: ["bad_request"] }], log: true } }),
		])
		const operation = "GET /orgs/{org}/notes/{id}"
		const log = on.run.trace?.log ?? []
		const durations = log.map((entry) => entry.durationMs)
		expect(
			{
				durations: durations.map((ms, i) => Number.isInteger(ms) && (ms as number) >= [0, 50, 0, 0, 0][i]!),
				errors: on.run.trace?.calls.map((c) => c.error?.envelope),
				log: log.map((entry) => ({ ...entry, durationMs: undefined })),
				starts: [durations[0], durations[2]],
			},
			on.run.stderr,
		).toEqual({
			durations: [true, true, true, true, true],
			errors: [undefined, envelope, undefined],
			log: [
				{ event: "request_start", level: "debug", operation },
				{ event: "response_received", level: "info", operation, status: 200 },
				{ event: "request_start", level: "debug", operation },
				{ event: "response_received", level: "warn", operation, status: 400 },
				{ error: "HTTP 400: Bad request", event: "error", level: "error", operation, status: 400 },
			],
			starts: [0, 0],
		})
		expect({
			envelope: off.run.trace?.calls.map((c) => (c.error === undefined ? null : "envelope" in c.error)),
			log: off.run.trace?.log.map((entry) => "durationMs" in entry),
		}).toEqual({ envelope: [null, false, false], log: [false, false, false, false, false] })
	}, 600_000)
})

goDescribe("the Go test driver's script: what it refuses", () => {
	it("exits 1 naming the reason, nothing sent: an unknown member, a key the method has no field for, a body it takes no parameter for, extra calls, durations without a log", async () => {
		const sdk = scriptedSdk()
		const file: Call = {
			body: { contentType: "application/octet-stream", kind: "binary", size: 1 },
			operation: "files.get",
			params: { name: "a" },
			route: { method: "GET", path: "/files/{name}" },
		}
		const refused: [Call, Script][] = [
			[GET, { calls: [{ sleepMs: 1, wait: 2 } as never] }],
			[POST, { calls: [{ idempotencyKey: "k" }] }],
			[file, {}],
			[GET, { calls: [null, null] }],
			[GET, { logDurations: true }],
		]
		const [runs, hops] = await served([], async (server) => {
			const ran = await Promise.all(refused.map(([call, script]) => sdk.runCalls({ calls: [call] }, server, script)))
			return [ran, server.hops.length] as const
		})
		expect({ hops, runs: runs.map((run) => [run.status, run.observed, run.trace]) }).toEqual({
			hops: 0,
			runs: refused.map(() => [1, undefined, undefined]),
		})
		expect(runs.map((run) => run.stderr.trim())).toEqual([
			expect.stringMatching(/script.*unknown field "wait"/),
			expect.stringMatching(/notes\.create.*IdempotencyKey/),
			expect.stringMatching(/files\.get.*binary body.*no body parameter/),
			expect.stringMatching(/script.*2 calls.*1/),
			expect.stringMatching(/script.*logDurations needs log/),
		])
	}, 600_000)
})
