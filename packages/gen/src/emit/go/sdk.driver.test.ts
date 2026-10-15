import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, WireHop } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, type DriverRun } from "./__fixtures__/compiled.ts"
import { goRequired, hasGo } from "./__fixtures__/go-env.ts"
import { type RecordingServer, type Reply, recordingServer } from "./__fixtures__/recording-server.ts"
import { goCallPlans } from "./sdk.ts"

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

/* Go absent passes locally and fails where it is required (CI, the pre-push battery) */
const go = hasGo()

/** Whether this test runs its Go half: false only where Go may be absent. */
function withGo(): boolean {
	expect(go || !goRequired()).toBe(true)
	return go
}

/** A run's outcome as a test asserts it: the exit status and what it observed. */
const outcome = (run: DriverRun) => ({ observed: run.observed, status: run.status })

/** `use` with a recording server answering `replies`, closed after it whatever it does. */
async function served<T>(replies: readonly Reply[], use: (server: RecordingServer) => Promise<T>): Promise<T> {
	const server = await recordingServer(replies)
	try {
		return await use(server)
	} finally {
		await server.close()
	}
}

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

describe("goCallPlans: each operation's call plan, in the emitter's own names", () => {
	it("names the resource path, the method, the path params in path order and every Opts field", () => {
		expect(goCallPlans(NOTES)).toEqual({
			"orgs.members.notes.create": {
				body: true,
				headers: { "X-Trace": "XTrace" },
				members: ["Orgs", "Members", "Notes"],
				method: "Create",
				operation: "orgs.members.notes.create",
				pathParams: ["org", "member"],
				query: { tag: "Tag" },
				response: "json",
				stream: null,
			},
		})
	})
})

describe("the Go test driver: the compiled SDK called by its call plan, (*T, error)", () => {
	it("sends a nested POST with escaped path params, query, header param and JSON body, and observes data then an error", async () => {
		if (!withGo()) return
		const sdk = notesSdk()
		const replies: Reply[] = [
			{ json: { id: "n1", text: "hi" }, status: 200 },
			{ json: { error_key: "note.invalid", message: "bad text" }, status: 422 },
		]
		const setup = { auth: { kind: "bearer", token: "tok" }, headers: { "X-Tenant": "acme" } } as const
		const [run, hops, expected] = await served(replies, async (server) => {
			const ran = await sdk.runCalls({ calls: [CREATE, CREATE], setup }, server)
			const recorded: readonly WireHop[] = server.hops
			return [ran, recorded, createdHop(server)] as const
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
	}, 600_000)
})

describe("the Go test driver: the compiled SDK called by its call plan, safe mode (SDKResult[T])", () => {
	it("observes an error status as error with a null key, sent to the alt origin, then data on the client's own", async () => {
		if (!withGo()) return
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

describe("the Go test driver: what it cannot express yet", () => {
	it("refuses it loudly: a non-zero exit naming the operation and the reason, nothing sent", async () => {
		if (!withGo()) return
		const sdk = notesSdk()
		const refused: Call[] = [
			{ ...CREATE, raw: true },
			{ ...CREATE, body: { contentType: "application/octet-stream", kind: "binary", size: 4 } },
		]
		const [runs, hops] = await served([], async (server) => {
			const ran = await Promise.all(refused.map((call) => sdk.runCalls({ calls: [call] }, server)))
			return [ran, server.hops] as const
		})
		expect(runs.map((run) => ({ ...outcome(run), stderr: run.stderr.trim() }))).toEqual([
			{ observed: undefined, status: 1, stderr: expect.stringMatching(/orgs\.members\.notes\.create.*raw/) },
			{ observed: undefined, status: 1, stderr: expect.stringMatching(/orgs\.members\.notes\.create.*binary/) },
		])
		expect(hops).toEqual([])
	}, 600_000)
})
