import { describe, expect, it } from "vitest"
import { emittedApp, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, any>
type Ctx = Record<string, any>

const BASE = "https://api.test"

/** The emitted app front's client, built with `config` against BASE. */
async function appFor(config: Json): Promise<any> {
	const { createClient } = await emittedApp()
	return (createClient as (config: Json) => unknown)({ baseURL: BASE, ...config })
}

/** An answer by request path: `/health` "ok", `/echo` the method, `/boom` a 500, anything else a 404. */
function routes(request: Request): Response {
	const { pathname } = new URL(request.url)
	if (pathname === "/health") return Response.json("ok")
	if (pathname === "/echo") return Response.json({ method: request.method })
	if (pathname === "/boom") return Response.json({ error_key: "api_error" }, { status: 500 })
	return Response.json({ error_key: "not_found" }, { status: 404 })
}

/** A safe call's Result as [status, data or null, the Err's error_key or null]. */
const summary = (result: Json) => [
	result.response.status,
	result.ok ? result.data : null,
	result.ok ? null : result.error.body.error_key,
]

describe("hook contexts for a parameterized route", () => {
	// v0: 5a16ac11d2
	// v0: 918b9c43ed
	it("onRequest and onResponse get the route template as path", async () => {
		const paths: string[] = []
		const api = await appFor({
			fetch: recordingFetch().fetch,
			onRequest: [(ctx: Ctx) => void paths.push(ctx.path)],
			onResponse: [(ctx: Ctx) => void paths.push(ctx.path)],
		})
		await api.get("/orgs/:orgId", { params: { orgId: "org-1" } })
		expect(paths).toEqual(["/orgs/:orgId", "/orgs/:orgId"])
	})

	// v0: 01b86920a9
	it("the onRequest url carries the interpolated path", async () => {
		const urls: string[] = []
		const api = await appFor({ fetch: recordingFetch().fetch, onRequest: [(ctx: Ctx) => void urls.push(ctx.url)] })
		await api.get("/orgs/:orgId", { params: { orgId: "org-1" } })
		expect(urls).toEqual([`${BASE}/orgs/org-1`])
	})

	// v0: c06c756462
	it("onRequest runs once per call with that call's path, keeping nothing between calls", async () => {
		const paths: string[] = []
		const api = await appFor({
			fetch: recordingFetch(routes).fetch,
			onRequest: [(ctx: Ctx) => void paths.push(ctx.path)],
		})
		await api.get("/health")
		await api.get("/echo")
		await api.get("/health")
		expect(paths).toEqual(["/health", "/echo", "/health"])
	})
})

describe("one client over many calls", () => {
	// v0: 1146095908
	it("handles a success, then an error, then a success with nothing carried over", async () => {
		const api = await appFor({ fetch: recordingFetch(routes).fetch })
		const results = [await api.safe.get("/health"), await api.safe.get("/missing"), await api.safe.get("/echo")]
		expect(results.map(summary)).toEqual([
			[200, "ok", null],
			[404, null, "not_found"],
			[200, { method: "GET" }, null],
		])
	})

	// v0: a98111c2ed
	it("concurrent successes and errors each get their own result", async () => {
		const api = await appFor({ fetch: recordingFetch(routes).fetch })
		const results = await Promise.all(
			["/health", "/missing", "/echo", "/boom", "/health"].map((path) => api.safe.get(path)),
		)
		expect(results.map(summary)).toEqual([
			[200, "ok", null],
			[404, null, "not_found"],
			[200, { method: "GET" }, null],
			[500, null, "api_error"],
			[200, "ok", null],
		])
	})

	// v0: 23bdd81bee
	it("a network failure rejects from the safe twin too", async () => {
		const api = await appFor({ fetch: recordingFetch(() => Promise.reject(new TypeError("fetch failed"))).fetch })
		/* the platform's TypeError is the typed connection error's cause (bit 19 f2) */
		const failure = { cause: expect.any(TypeError), name: "APIConnectionError" }
		await expect(api.safe.get("/down")).rejects.toMatchObject(failure)
		await expect(api.get("/down")).rejects.toMatchObject(failure)
	})
})

describe("config headers and fetch options", () => {
	it.each([
		// v0: c6779eb554
		["get", "GET"],
		// v0: 5321c12ba1
		["post", "POST"],
		// v0: fae58d3dcd
		["delete", "DELETE"],
	])("a headers function receives the %s call's method", async (call, method) => {
		const methods: string[] = []
		const headers = (ctx: Ctx) => {
			methods.push(ctx.method)
			return {}
		}
		await (await appFor({ fetch: recordingFetch().fetch, headers }))[call]("/echo", {})
		expect(methods).toEqual([method])
	})

	// v0: 1d11d2c5c8
	it("concurrent calls each resolve and send their own async headers", async () => {
		let count = 0
		const headers = async () => {
			const n = ++count
			await new Promise((resolve) => setTimeout(resolve, (4 - n) * 5))
			return { "x-call": String(n) }
		}
		const { calls, fetch } = recordingFetch(routes)
		const api = await appFor({ fetch, headers })
		const results = await Promise.all([api.safe.get("/health"), api.safe.get("/health"), api.safe.get("/health")])
		expect([count, results.map(summary), calls.map((call) => call.headers.get("x-call")).sort()]).toEqual([
			3,
			[
				[200, "ok", null],
				[200, "ok", null],
				[200, "ok", null],
			],
			["1", "2", "3"],
		])
	})

	it.each([
		// v0: faee0ba29f
		["credentials", "include"],
		// v0: b3f541d9f6
		["mode", "same-origin"],
	] as const)("config %s %s reaches fetch", async (option, value) => {
		const { calls, fetch } = recordingFetch()
		await (await appFor({ fetch, [option]: value })).get("/health")
		expect(calls[0]?.[option]).toBe(value)
	})
})

describe("onResponse with the throwing client and retry", () => {
	// v0: 120e782527
	it("a hook replacing a 404 with a 200 prevents the throw, and its body becomes the data", async () => {
		const onResponse = [(ctx: Ctx) => (ctx.response.status === 404 ? Response.json({ fallback: true }) : undefined)]
		const api = await appFor({ fetch: recordingFetch(routes).fetch, onResponse })
		expect(await api.get("/missing")).toEqual({ fallback: true })
	})

	// v0: cc44892313
	it("a retry re-runs onRequest with re-resolved headers, and onResponse sees the retried response", async () => {
		const log: string[] = []
		let attempt = 0
		const { calls, fetch } = recordingFetch((request) =>
			request.headers.has("authorization") ? Response.json("ok") : Response.json({}, { status: 401 }),
		)
		const api = await appFor({
			fetch,
			headers: () => (++attempt === 1 ? {} : { authorization: "Bearer test" }),
			onRequest: [(ctx: Ctx) => void log.push(`req:${ctx.method}:attempt${attempt}`)],
			onResponse: [
				(ctx: Ctx) => {
					log.push(`res:${ctx.response.status}:retry=${ctx.isRetry}`)
					return ctx.response.status === 401 && !ctx.isRetry ? ctx.retry() : undefined
				},
			],
		})
		expect(await api.get("/orgs")).toBe("ok")
		expect([log, calls.map((call) => call.headers.get("authorization"))]).toEqual([
			["req:GET:attempt1", "res:401:retry=false", "req:GET:attempt2", "res:200:retry=true"],
			[null, "Bearer test"],
		])
	})

	// v0: f05df367a8
	it("a hook that retries every 401 stops after one retry and throws the 401", async () => {
		const { calls, fetch } = recordingFetch(() => Response.json({ message: "nope" }, { status: 401 }))
		const onResponse = [(ctx: Ctx) => (ctx.response.status === 401 ? ctx.retry() : undefined)]
		const api = await appFor({ fetch, onResponse })
		const error = await api.get("/x").then(
			() => null,
			(thrown: Json) => thrown,
		)
		expect([calls.length, error?.status, /Max 1 retry/.test(String(error?.message))]).toEqual([2, 401, false])
	})
})
