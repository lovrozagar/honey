import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import type { GoError, HookTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const USER = { properties: { id: STRING, name: STRING }, required: ["id", "name"], type: "object" }
const path = (name: string) => ({ in: "path", name, required: true, schema: STRING })

/** REQ's users.get: two path params declared out of path order and a list query. */
const HOOKS: Json = {
	info: { title: "Hooks", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/orgs/{org}/users/{user-id}": {
			get: {
				operationId: "users.get",
				parameters: [
					path("user-id"),
					path("org"),
					{ in: "query", name: "ids", schema: { items: STRING, type: "array" } },
				],
				responses: { 200: { content: { "application/json": { schema: USER } }, description: "ok" } },
			},
		},
	},
}

/* values no log entry may carry: the path params, the query and the token */
const ORG = "org-7f3a"
const USER_ID = "usr-9c2e"
const QUERY = "qry-41bd"
const TOKEN = "tok-d00d"
const OPERATION = "GET /orgs/{org}/users/{user-id}"
const CONCRETE = `/orgs/${ORG}/users/${USER_ID}`

const GET: Call = {
	operation: "users.get",
	params: { org: ORG, "user-id": USER_ID },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	search: { ids: [QUERY] },
}
const FOUND: Reply = { json: { id: "u", name: "found" }, status: 200 }
const BEARER: Setup = { auth: { kind: "bearer", token: TOKEN } }
const data = (value: Json) => ({ data: value, kind: "data", status: 200 })

let memo: DrivenSdk | undefined
/** The SDK for HOOKS compiled with the driver, once: it must build and vet clean. */
function hooksSdk(): DrivenSdk {
	memo ??= compiledSdk(HOOKS, { modulePath: "example.com/hooks" })
	expect({ built: memo.built, vet: memo.vet }, memo.stderr).toEqual({ built: true, vet: [] })
	return memo
}

/** `calls` under `script` against a server answering `replies`: the run, the hops and the origin. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	return served(replies, async (server) => {
		const run = await hooksSdk().runCalls({ calls, setup }, server, script)
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], run, url: server.url }
	})
}

/** A hook run as `<call> <phase> <index>`, its retry flag and status when it has them. */
const step = (h: HookTrace) =>
	[h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((part) => part !== "").join(" ")

/** A Go error of no honey type, as the trace records it. */
const plain = (entry: Partial<GoError>) => ({
	canceled: false,
	deadline: false,
	tooLarge: false,
	via: "return",
	...entry,
})

/** OnLog entries, as the trace records them. */
const start = { event: "request_start", level: "debug", operation: OPERATION }
const received = (level: string, status: number) => ({
	event: "response_received",
	level,
	operation: OPERATION,
	status,
})
const failed = (error: string, status?: number) => ({
	error,
	event: "error",
	level: "error",
	operation: OPERATION,
	...(status === undefined ? {} : { status }),
})

/** The stale fields of a client without invalidation, as every hook sees them. */
const OFF = { invalidatedBy: [], isRetry: false, isStale: false, selector: "" }

/** What request hook `index` of call 0 saw of GET against `url`. */
const asked = (index: number, url: string) => ({
	...OFF,
	call: 0,
	index,
	method: "GET",
	path: CONCRETE,
	phase: "request",
	url: `${url}${CONCRETE}?ids=${QUERY}`,
})

/** GET once with OnLog on, under these request and response hooks. */
const failing = (request: Json[], response: Json[]) =>
	drive([FOUND], [GET], { hooks: { request, response }, log: true })

/** A failing-hook run as the test reads it: the call's error, the hops, the log, the observed and the hook runs. */
const outcome = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	error: run.trace?.calls[0]?.error,
	hops: hops.length,
	log: run.trace?.log,
	observed: run.observed,
	order: run.trace?.hooks.map(step),
})

/** A hook's error as the call returns it: wrapped by the runtime, the hook's own error beneath. */
const hookError = (text: string) =>
	plain({ chain: ["*fmt.wrapError", "*errors.errorString"], text, type: "*fmt.wrapError" })

goDescribe("OnRequest and OnResponse hooks: declaration order", () => {
	it("run in declaration order on every call: the last header set is sent, the last body set decodes", async () => {
		const hooks: Script["hooks"] = {
			request: [{ setHeader: ["X-Hooked", "first"] }, { setHeader: ["X-Hooked", "second"] }],
			response: [{ body: '{"id":"r0","name":"first"}' }, { body: '{"id":"r1","name":"second"}' }],
		}
		const { hops, run, url } = await drive([FOUND, FOUND], [GET, GET], { hooks })
		expect({
			first: run.trace?.hooks.slice(0, 4),
			observed: run.observed,
			order: run.trace?.hooks.map(step),
			sent: hops.map((h) => h.headers["x-hooked"]),
		}).toEqual({
			first: [
				asked(0, url),
				asked(1, url),
				{ ...OFF, call: 0, index: 0, phase: "response", status: 200 },
				{ ...OFF, call: 0, index: 1, phase: "response", status: 200 },
			],
			observed: [data({ id: "r1", name: "second" }), data({ id: "r1", name: "second" })],
			order: [
				"0 request 0",
				"0 request 1",
				"0 response 0 200",
				"0 response 1 200",
				"1 request 0",
				"1 request 1",
				"1 response 0 200",
				"1 response 1 200",
			],
			sent: ["second", "second"],
		})
	}, 600_000)
})

goDescribe("OnRequest and OnResponse hooks: a hook's error", () => {
	it("ends the call with it, wrapped, runs no later hook, and reaches OnLog as the error entry", async () => {
		const [before, after] = await Promise.all([
			failing([{ fail: "boom" }, {}], [{}]),
			failing([{}], [{ fail: "bad" }, { body: '{"id":"x","name":"x"}' }]),
		])
		expect({ after: outcome(after), before: outcome(before) }).toEqual({
			after: {
				error: hookError("honey: OnResponse hook: bad"),
				hops: 1,
				log: [start, failed("honey: OnResponse hook: bad")],
				observed: [null],
				order: ["0 request 0", "0 response 0 200"],
			},
			before: {
				error: hookError("honey: OnRequest hook: boom"),
				hops: 0,
				log: [start, failed("honey: OnRequest hook: boom")],
				observed: [null],
				order: ["0 request 0"],
			},
		})
	}, 600_000)
})

goDescribe("OnRequest and OnResponse hooks: an auth retry", () => {
	it("runs every hook again with isRetry, its request carrying what they set; OnLog sees one exchange", async () => {
		const script: Script = {
			hooks: { request: [{ setHeader: ["X-Hooked", "1"] }], response: [{}] },
			log: true,
			onAuthExpired: { tokens: ["tok-new"] },
		}
		const { hops, run } = await drive([{ status: 401 }, FOUND], [GET], script, BEARER)
		expect({
			expired: run.trace?.authExpired,
			hops: hops.map((h) => [h.headers.authorization, h.headers["x-hooked"]]),
			log: run.trace?.log,
			observed: run.observed,
			order: run.trace?.hooks.map(step),
		}).toEqual({
			expired: 1,
			hops: [
				[`Bearer ${TOKEN}`, "1"],
				["Bearer tok-new", "1"],
			],
			log: [start, received("info", 200)],
			observed: [data({ id: "u", name: "found" })],
			order: ["0 request 0", "0 response 0 401", "0 request 0 retry", "0 response 0 retry 200"],
		})
	}, 600_000)
})

goDescribe("OnLog: the exchange by its operation template, never a path value, query or token", () => {
	it("logs request_start, then response_received at info for a 2xx, warn plus an error entry for an error status", async () => {
		const missing: Reply = { json: { message: "no such user" }, status: 404 }
		const { run } = await drive([FOUND, missing], [GET, GET], { log: true }, BEARER)
		expect(run.trace?.log).toEqual([
			start,
			received("info", 200),
			start,
			received("warn", 404),
			failed("404 Not Found: no such user", 404),
		])
	}, 600_000)

	it("logs request_start then an error entry with no status when no response arrives, its text without query or token", async () => {
		const log = await refused()
		expect(log).toEqual([start, failed(expect.stringContaining("connection refused") as unknown as string)])
		const text = JSON.stringify(log)
		expect([QUERY, TOKEN].filter((secret) => text.includes(secret))).toEqual([])
	}, 600_000)

	/* V0BUG: v0's LogEntry carried the raw transport error, a *url.Error naming the concrete URL and
	   so every path value (_v0/src/client-go/runtime.go:157-169); v1's entry names the operation template */
	it("names no path param value in a transport error's text: the operation template stands for the URL", async () => {
		const text = JSON.stringify(await refused())
		expect([ORG, USER_ID].filter((value) => text.includes(value))).toEqual([])
	}, 600_000)
})

/** OnLog's entries for GET against a closed origin, the call observed as null. */
async function refused() {
	const closed = REFUSED_URL
	const run = await hooksSdk().runCalls({ calls: [GET], setup: BEARER }, { url: closed }, { log: true })
	expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({ observed: [null], status: 0 })
	return run.trace?.log ?? []
}
