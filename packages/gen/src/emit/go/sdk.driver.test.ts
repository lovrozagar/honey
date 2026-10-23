import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, WireHop } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, compileGo, type DrivenSdk, type DriverRun } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type RecordingServer, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { generateGoSdk, goCallPlans } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: Json) => ({ content: { "application/json": { schema } } })

/** One nested POST: two path params (declared out of path order), a query and a header param, a JSON body. */
const NOTES: Json = {
	components: {
		schemas: {
			Note: { properties: { id: STRING, text: STRING }, required: ["id", "text"], type: "object" },
			NoteInput: {
				properties: { tags: { items: STRING, type: "array" }, text: STRING },
				required: ["text"],
				type: "object",
			},
		},
	},
	info: { title: "Notes", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/orgs/{org}/members/{member}/notes": {
			post: {
				operationId: "orgs.members.notes.create",
				parameters: [
					{ in: "query", name: "tag", schema: STRING },
					{ in: "path", name: "member", required: true, schema: STRING },
					{ in: "header", name: "X-Trace", schema: STRING },
					{ in: "path", name: "org", required: true, schema: STRING },
				],
				requestBody: { ...json(ref("NoteInput")), required: true },
				responses: { 200: { ...json(ref("Note")), description: "ok" } },
			},
		},
	},
}

/** The create call the legs send: path params needing escapes, a query, the header param, a JSON body. */
const CREATE: Call = {
	body: { kind: "json", value: { tags: ["a"], text: "hi" } },
	headers: { "x-trace": "t-1" },
	operation: "orgs.members.notes.create",
	params: { member: "m?1", org: "a/b c" },
	route: { method: "POST", path: "/orgs/{org}/members/{member}/notes" },
	search: { tag: "x&y z" },
}

/** CREATE's body as the SDK encodes it: the typed struct's fields in declaration order. */
const CREATED_BODY = '{"tags":["a"],"text":"hi"}'

/** The path and query CREATE reaches, escaped as encodeURIComponent and URLSearchParams do. */
const CREATED_URL = "/orgs/a%2Fb%20c/members/m%3F1/notes?tag=x%26y+z"

/** A run's outcome as a test asserts it: the exit status and what it observed. */
const outcome = (run: DriverRun) => ({ observed: run.observed, status: run.status })

/** The SDK for NOTES compiled with the driver, which must build and vet clean. */
function notesSdk(throwOnError?: boolean): DrivenSdk {
	const sdk = compiledSdk(NOTES, { modulePath: "example.com/notes", throwOnError })
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/** CREATE as the primary listener of `server` receives it, under the bearer token and the tenant header. */
const createdHop = (server: RecordingServer): WireHop => ({
	body: {
		contentType: "application/json",
		json: { tags: ["a"], text: "hi" },
		sha256: createHash("sha256").update(CREATED_BODY).digest("hex"),
		size: CREATED_BODY.length,
	},
	headers: {
		"accept-encoding": "gzip",
		authorization: "Bearer tok",
		"content-length": String(CREATED_BODY.length),
		"content-type": "application/json",
		host: new URL(server.url).host,
		"user-agent": "Go-http-client/1.1",
		"x-request-id": expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
		"x-tenant": "acme",
		"x-trace": "t-1",
	},
	method: "POST",
	origin: "primary",
	url: CREATED_URL,
})

/** A raw Observed: the status, the body as text and every header the Node listener sends. */
const raw = (status: number, body: string, headers: Record<string, unknown>) => ({
	body,
	headers: {
		connection: "keep-alive",
		"content-length": String(body.length),
		date: expect.any(String),
		"keep-alive": "timeout=5",
		...headers,
	},
	kind: "raw",
	status,
})

describe("goCallPlans: each operation's call plan, in the emitter's own names", () => {
	it("names the resource path, the method, the path params in path order and every Opts field", () => {
		expect(goCallPlans(NOTES)).toEqual({
			"orgs.members.notes.create": {
				body: "json",
				bodyType: "NoteInput",
				headers: { "X-Trace": "XTrace" },
				members: ["Orgs", "Members", "Notes"],
				method: "Create",
				operation: "orgs.members.notes.create",
				opts: "OrgsMembersNotesCreateOpts",
				pathParams: ["org", "member"],
				query: { tag: "Tag" },
				response: "json",
				responseHeaders: null,
				returns: "(*Note, error)",
				stream: null,
			},
		})
	})
})

goDescribe("the Go test driver: the compiled SDK called by its call plan, (*T, error)", () => {
	it("sends a nested POST with escaped path params, query, header param and JSON body, and observes data then an error", async () => {
		const sdk = notesSdk()
		const replies: Reply[] = [
			{ json: { id: "n1", text: "hi" }, status: 200 },
			{ json: { error_key: "note.invalid", message: "bad text" }, status: 422 },
		]
		const setup = { auth: { kind: "bearer", token: "tok" }, headers: { "X-Tenant": "acme" } } as const
		const [run, hops, expected, bodies] = await served(replies, async (server) => {
			const ran = await sdk.runCalls({ calls: [CREATE, CREATE], setup }, server)
			const recorded: readonly WireHop[] = server.hops
			return [ran, recorded, createdHop(server), server.bodies.map(String)] as const
		})
		expect(outcome(run), run.stderr).toEqual({
			observed: [
				{ data: { id: "n1", text: "hi" }, kind: "data", status: 200 },
				{
					body: { error_key: "note.invalid", message: "bad text" },
					errorKey: "note.invalid",
					kind: "error",
					status: 422,
				},
			] satisfies Observed[],
			status: 0,
		})
		expect(hops).toEqual([expected, expected])
		expect(bodies).toEqual([CREATED_BODY, CREATED_BODY])
	}, 600_000)
})

goDescribe("the Go test driver: the compiled SDK called by its call plan, safe mode (SDKResult[T])", () => {
	it("observes an error status as error with a null key, sent to the alt origin, then data on the client's own", async () => {
		const sdk = notesSdk(false)
		const replies: Reply[] = [
			{ json: { message: "no such member" }, status: 404 },
			{ json: { id: "n2", text: "hi" }, status: 200 },
		]
		const calls: Call[] = [{ ...CREATE, origin: "alt" }, CREATE]
		const [run, hops] = await served(
			replies,
			async (server) => [await sdk.runCalls({ calls }, server), server.hops] as const,
		)
		expect(outcome(run), run.stderr).toEqual({
			observed: [
				{ body: { message: "no such member" }, errorKey: null, kind: "error", status: 404 },
				{ data: { id: "n2", text: "hi" }, kind: "data", status: 200 },
			] satisfies Observed[],
			status: 0,
		})
		expect(hops.map((h) => `${h.origin} ${h.method} ${h.url}`)).toEqual([
			`alt POST ${CREATED_URL}`,
			`primary POST ${CREATED_URL}`,
		])
	}, 600_000)
})

goDescribe("the Go test driver: timeouts and the raw response, the grid's outcomes in either mode", () => {
	it("observes a lapsed client or call timeout as timeout, a late answer never awaited", async () => {
		const sdk = notesSdk()
		const replies: Reply[] = [
			{ delayMs: 5000, json: {}, status: 200 },
			{ delayMs: 5000, json: {}, status: 200 },
		]
		const calls: Call[] = [CREATE, { ...CREATE, timeoutMs: 300 }]
		const started = Date.now()
		const [run, hops] = await served(replies, async (server) => {
			const ran = await sdk.runCalls({ calls, setup: { timeoutMs: 300 } }, server)
			return [ran, server.hops.length] as const
		})
		expect({ ...outcome(run), hops }, run.stderr).toEqual({
			hops: 2,
			observed: [{ kind: "timeout" }, { kind: "timeout" }] satisfies Observed[],
			status: 0,
		})
		expect(Date.now() - started).toBeLessThan(4000)
	}, 600_000)

	it("observes raw: true as the stored response, on success and on an error status, in both modes", async () => {
		const replies: Reply[] = [
			{ headers: { "x-extra": "e" }, json: { id: "n1", text: "hi" }, status: 200 },
			{ text: "plain failure", status: 404 },
		]
		const expected = [
			raw(200, '{"id":"n1","text":"hi"}', { "content-type": "application/json", "x-extra": "e" }),
			raw(404, "plain failure", {}),
		]
		for (const sdk of [notesSdk(), notesSdk(false)]) {
			const calls: Call[] = [
				{ ...CREATE, raw: true },
				{ ...CREATE, raw: true },
			]
			const run = await served(replies, (server) => sdk.runCalls({ calls }, server))
			expect(outcome(run), run.stderr).toEqual({ observed: expected, status: 0 })
		}
	}, 600_000)
})

/** An error-only op (a 307 and a 500, no 2xx): the plan's response is "none", the method returns no answer. */
const MOVED: Json = {
	info: { title: "Moved", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/moved": {
			get: {
				operationId: "moved.get",
				responses: { 307: { description: "moved" }, 500: { ...json({ type: "object" }), description: "failed" } },
			},
		},
	},
}

goDescribe("the Go test driver: a success the document does not type (an error-only op)", () => {
	it("observes the body WithResponseInto stored: its JSON, its text, null when empty, in both modes", async () => {
		expect(goCallPlans(MOVED)["moved.get"]?.response).toBe("none")
		const replies: Reply[] = [{ json: { a: 1 }, status: 200 }, { status: 200 }, { status: 200, text: "t" }]
		const call: Call = { operation: "moved.get", route: { method: "GET", path: "/moved" } }
		for (const throwOnError of [true, false]) {
			const sdk = compiledSdk(MOVED, { modulePath: "example.com/moved", throwOnError })
			expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
			const run = await served(replies, (server) => sdk.runCalls({ calls: [call, call, call] }, server))
			expect(outcome(run), run.stderr).toEqual({
				observed: [
					{ data: { a: 1 }, kind: "data", status: 200 },
					{ data: null, kind: "data", status: 200 },
					{ data: "t", kind: "data", status: 200 },
				] satisfies Observed[],
				status: 0,
			})
		}
	}, 600_000)
})

/** One GET whose header params take each Opts shape: a required string (no pointer) and an optional integer. */
const PING: Json = {
	info: { title: "Ping", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/ping": {
			get: {
				operationId: "ping.get",
				parameters: [
					{ in: "header", name: "X-Tenant", required: true, schema: STRING },
					{ in: "header", name: "X-Limit", schema: { type: "integer" } },
				],
				responses: { 200: { ...json({ type: "object" }), description: "ok" } },
			},
		},
	},
}

goDescribe("the Go test driver: header params in every Opts shape", () => {
	it("sets a required string header and an optional integer header from the call's headers", async () => {
		const sdk = compiledSdk(PING, { modulePath: "example.com/ping" })
		const call: Call = {
			headers: { "x-limit": "5", "x-tenant": "acme" },
			operation: "ping.get",
			route: { method: "GET", path: "/ping" },
		}
		const [run, hops] = await served([{ json: { ok: true }, status: 200 }], async (server) => {
			const ran = await sdk.runCalls({ calls: [call] }, server)
			return [ran, server.hops.map((hop) => [hop.headers["x-tenant"], hop.headers["x-limit"]])] as const
		})
		expect(outcome(run), run.stderr).toEqual({
			observed: [{ data: { ok: true }, kind: "data", status: 200 }],
			status: 0,
		})
		expect(hops).toEqual([["acme", "5"]])
	}, 600_000)
})

/** A WebSocket operation (`x-websocket`) under a path param, with a query param: what the phase-c emitter already dials. */
const ROOMS: Json = {
	info: { title: "Rooms", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/rooms/{room}": {
			get: {
				operationId: "rooms.socket",
				parameters: [
					{ in: "path", name: "room", required: true, schema: STRING },
					{ in: "query", name: "since", schema: { type: "integer" } },
				],
				responses: { 101: { description: "upgrade" } },
				"x-websocket": true,
			},
		},
	},
}

goDescribe("the Go test driver: a WebSocket, (*TypedWebSocket, error)", () => {
	it("dials the escaped path with its query, sends the grid's frames, observes take frames, then closes 1000", async () => {
		const sdk = compiledSdk(ROOMS, { modulePath: "example.com/rooms" })
		expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
		const reply: Reply = { status: 101, ws: { steps: [{ receive: 1 }, { json: { n: 1 } }, { text: "plain" }] } }
		const call: Call = {
			operation: "rooms.socket",
			params: { room: "a b/c" },
			route: { method: "GET", path: "/rooms/{room}" },
			search: { since: 3 },
			send: ['{"x":1}'],
			take: 2,
		}
		const [run, hops, streams] = await served([reply], async (server) => {
			const ran = await sdk.runCalls({ calls: [call] }, server)
			return [ran, server.hops, server.streams] as const
		})
		expect(outcome(run), run.stderr).toEqual({
			observed: [{ frames: [{ n: 1 }, "plain"], kind: "frames" }] satisfies Observed[],
			status: 0,
		})
		expect(hops.map(({ headers, method, url }) => ({ headers, method, url }))).toEqual([
			{
				headers: expect.objectContaining({ upgrade: "websocket", "sec-websocket-version": "13" }),
				method: "GET",
				url: "/rooms/a%20b%2Fc?since=3",
			},
		])
		expect(streams).toEqual([
			{
				clientGone: false,
				received: [
					{ kind: "text", text: '{"x":1}' },
					{ code: 1000, kind: "close", reason: "" },
				],
			},
		])
	}, 600_000)
})

goDescribe("the Go test driver: what it cannot express", () => {
	it("refuses it loudly: a non-zero exit naming the operation and the reason, nothing sent", async () => {
		const sdk = notesSdk()
		const refused: Call[] = [
			{ ...CREATE, lastEventId: "e1" },
			{ ...CREATE, body: { contentType: "application/octet-stream", kind: "binary", size: 4 } },
		]
		const [runs, hops] = await served([], async (server) => {
			const ran = await Promise.all(refused.map((call) => sdk.runCalls({ calls: [call] }, server)))
			return [ran, server.hops] as const
		})
		expect(runs.map((run) => ({ ...outcome(run), stderr: run.stderr.trim() }))).toEqual([
			{ observed: undefined, status: 1, stderr: expect.stringMatching(/orgs\.members\.notes\.create.*lastEventId/) },
			{ observed: undefined, status: 1, stderr: expect.stringMatching(/orgs\.members\.notes\.create.*binary/) },
		])
		expect(hops).toEqual([])
	}, 600_000)

	it("fails a call ending in a Go error the grid has no Observed for: an undecodable success", async () => {
		const sdk = notesSdk()
		const replies: Reply[] = [{ headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }]
		const run = await served(replies, (server) => sdk.runCalls({ calls: [CREATE] }, server))
		expect({ ...outcome(run), stderr: run.stderr.trim() }).toEqual({
			observed: undefined,
			status: 1,
			stderr: expect.stringMatching(/orgs\.members\.notes\.create.*honey: decode response/),
		})
	}, 600_000)
})

goDescribe("the compile fixture: a check program's stdin", () => {
	it("runs a program that never reads its stdin, however large the input, its exit status the answer", async () => {
		const sdk = compileGo(generateGoSdk(NOTES, { modulePath: "example.com/notes" }).files, {
			main: "package main\n\nfunc main() {}\n",
		})
		expect(sdk.built, sdk.stderr).toBe(true)
		/* more than a pipe holds: the program exits before the write ends, which must not surface as EPIPE */
		expect(await sdk.exec("x".repeat(4 << 20))).toEqual({ status: 0, stderr: "", stdout: "" })
	}, 600_000)
})
