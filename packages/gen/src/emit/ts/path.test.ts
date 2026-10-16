import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Build = (path: string, input?: Json) => string
type Send = (path: string, input?: Json) => Promise<unknown>
type App = { $path: Build; $url: Build; delete: Send; get: Send }
type Result = { data: unknown; error: { message: string } | null; status: number }
type Op = (input?: Json) => Promise<Result>
type Ctor = abstract new (...args: never[]) => unknown

const ORIGIN = "https://api.example.com"
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "ok" } }

/** A URL-building vector both fronts share: `url` is the request URL after the origin, `error` part of the refusal. */
type Vector = { base?: string; error?: string; name: string; params?: Json; path: string; search?: Json; url?: string }

const VECTORS: readonly Vector[] = [
	{ name: "root base", path: "/users", url: "/users" },
	{ base: "/v1", name: "base path kept", path: "/users", url: "/v1/users" },
	{ base: "/v1/", name: "base path with trailing slash", path: "/users", url: "/v1/users" },
	{ base: "/v1?key=k", name: "base query kept", path: "/users", url: "/v1/users?key=k" },
	{ name: "colon param encoded", params: { id: "a b/c" }, path: "/users/:id", url: "/users/a%20b%2Fc" },
	{ name: "hyphenated param name", params: { "user-id": "7" }, path: "/users/:user-id", url: "/users/7" },
	{ name: "brace param", params: { id: "7" }, path: "/users/{id}", url: "/users/7" },
	{ name: "brace param with hyphen", params: { "user-id": "7" }, path: "/users/{user-id}", url: "/users/7" },
	{ name: "brace param inside a segment", params: { id: "9" }, path: "/ops/{id}:cancel", url: "/ops/9:cancel" },
	{ name: "optional param omitted", path: "/opt/:id?", url: "/opt" },
	{ name: "wildcard spans segments", params: { path: "a/b c.txt" }, path: "/files/*path", url: "/files/a/b%20c.txt" },
	{
		name: "query serialization repeats arrays",
		path: "/s",
		search: { q: "x y", skip: null, tag: ["a", "b"] },
		url: "/s?q=x+y&tag=a&tag=b",
	},
	{
		base: "/v1",
		error: "Invalid path param",
		name: "dot-dot param rejected",
		params: { id: ".." },
		path: "/members/:id",
	},
	{ base: "/v1", error: "Invalid path param", name: "dot param rejected", params: { id: "." }, path: "/members/:id" },
	{
		error: "Invalid path param",
		name: "empty param rejected",
		params: { org: "", repo: "evil.example" },
		path: "/:org/:repo",
	},
	{ error: "Invalid path param", name: "dot-dot brace param rejected", params: { id: ".." }, path: "/members/{id}" },
	{
		error: "Invalid path param",
		name: "dot-dot inside wildcard rejected",
		params: { path: "a/../admin" },
		path: "/files/*path",
	},
	{ error: "Missing path param: id", name: "missing param", path: "/users/:id" },
	{ name: "percent-encoded dots stay data", params: { id: "%2e%2e" }, path: "/users/:id", url: "/users/%252e%252e" },
	{
		name: "query escaping",
		path: "/s",
		search: { e: "", q: "a b&c=d", t: "~*", ü: "é+" },
		url: "/s?e=&q=a+b%26c%3Dd&t=%7E*&%C3%BC=%C3%A9%2B",
	},
	{
		name: "query numbers and booleans",
		path: "/s",
		search: { b: true, big: 1e21, f: 0.5, n: 3, tiny: 1.5e-7 },
		url: "/s?b=true&big=1e%2B21&f=0.5&n=3&tiny=1.5e-7",
	},
	{
		base: "/v1?key=k",
		name: "base query and search merge",
		path: "/users",
		search: { a: "1" },
		url: "/v1/users?key=k&a=1",
	},
	{ name: "path segment encoding set", params: { id: "!*'()~ é" }, path: "/x/:id", url: "/x/!*'()~%20%C3%A9" },
]

/** What a vector must yield: the URL it names, or a refusal carrying its error. */
const want = (v: Vector) => ({ refused: v.error !== undefined, url: v.url === undefined ? null : `${ORIGIN}${v.url}` })

/** The app-front client on `baseURL` over a recording fetch, and what it sent. */
async function app(baseURL = ORIGIN, config: Json = {}): Promise<{ api: App; calls: Request[]; PathParamError: Ctor }> {
	const { createClient, PathParamError } = await emittedApp()
	const { calls, fetch } = recordingFetch()
	return {
		api: (createClient as (config: Json) => App)({ baseURL, fetch, ...config }),
		calls,
		PathParamError: PathParamError as Ctor,
	}
}

/** A required path parameter as OpenAPI declares it; `wildcard` spans segments. */
const pathParam = (name: string, wildcard = false): Json => ({
	in: "path",
	name,
	required: true,
	schema: { type: "string" },
	...(wildcard ? { "x-honey-wildcard": true } : {}),
})

/** A GET operation `operationId` taking the path params `names`. */
const getOp = (operationId: string, names: readonly string[]): Json => ({
	get: { operationId, parameters: names.map((name) => pathParam(name)), responses: OK },
})

/** The SDK emitted for `paths`, on `ORIGIN` over a recording fetch; its module and what it sent. */
async function sdkOf<T>(paths: Json, config: Json = {}): Promise<{ calls: Request[]; mod: Json; sdk: T }> {
	const mod = await emittedSdk({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })
	const { calls, fetch } = recordingFetch()
	return { calls, mod, sdk: new (mod.TestSDK as new (config: Json) => T)({ baseURL: ORIGIN, fetch, ...config }) }
}

/** A vector's route pattern as an OpenAPI path and its parameters (`*name` a wildcard). */
function openApi(path: string): { parameters: Json[]; template: string } {
	const parameters: Json[] = []
	const template = path
		.split("/")
		.map((segment) => {
			if (segment.startsWith(":") || segment.startsWith("*")) {
				parameters.push(pathParam(segment.slice(1), segment.startsWith("*")))
				return `{${segment.slice(1)}}`
			}
			for (const [, name] of segment.matchAll(/\{([^{}/]+)\}/g)) parameters.push(pathParam(name as string))
			return segment
		})
		.join("/")
	return { parameters, template }
}

describe("app front: URL vectors", () => {
	// v0: 96675f036a
	it.each(VECTORS)("builds or refuses the URL as the vector says: $name", async (v) => {
		const { api } = await app(`${ORIGIN}${v.base ?? ""}`)
		let outcome: { refused: boolean; url: string | null }
		try {
			outcome = { refused: false, url: api.$url(v.path, { params: v.params, search: v.search }) }
		} catch (error) {
			outcome = { refused: (error as Error).message.includes(v.error ?? ""), url: null }
		}
		expect(outcome).toEqual(want(v))
	})
})

describe("app front: $url", () => {
	// v0: 2b4d5bedf4
	// v0: 9fcb6ed7ed
	// v0: 82b57a83c0
	it("builds the full URL from the base URL and the path, with or without input", async () => {
		const { api } = await app()
		expect([api.$url("/health"), api.$url("/simple", {})]).toEqual([`${ORIGIN}/health`, `${ORIGIN}/simple`])
	})

	// v0: 476d566fc1
	// v0: b1938132a3
	// v0: 5f7858305b
	// v0: fbd64e2a07
	// v0: a5aadfac1e
	it("interpolates params and appends the query, repeating an array's key", async () => {
		const { api } = await app()
		expect([
			api.$url("/users/:userId", { params: { userId: "42" } }),
			api.$url("/users", { search: { limit: 10, page: 1 } }),
			api.$url("/users/:userId/posts", { params: { userId: "42" }, search: { sort: "date" } }),
			api.$url("/filter", { search: { ids: [1, 2, 3] } }),
			api.$url("/api/v1/organizations/:orgId", { params: { orgId: "org-1" }, search: { include: "members" } }),
		]).toEqual([
			`${ORIGIN}/users/42`,
			`${ORIGIN}/users?limit=10&page=1`,
			`${ORIGIN}/users/42/posts?sort=date`,
			`${ORIGIN}/filter?ids=1&ids=2&ids=3`,
			`${ORIGIN}/api/v1/organizations/org-1?include=members`,
		])
	})

	// v0: 307cebab88
	// v0: 5c8d0f58ec
	// v0: a5e4f40bc2
	// v0: 471d146094
	it("percent-encodes param values: spaces, slashes, colons and unicode", async () => {
		const { api } = await app()
		const org = (orgId: string) => api.$url("/orgs/:orgId", { params: { orgId } })
		expect([
			api.$url("/search/:query", { params: { query: "hello world" } }),
			org("a b/c"),
			org("org:123"),
			org("org-日本語"),
		]).toEqual([
			`${ORIGIN}/search/hello%20world`,
			`${ORIGIN}/orgs/a%20b%2Fc`,
			`${ORIGIN}/orgs/org%3A123`,
			`${ORIGIN}/orgs/org-%E6%97%A5%E6%9C%AC%E8%AA%9E`,
		])
	})
})

describe("app front: $path", () => {
	// v0: 0075b6873c
	// v0: 33ac86784a
	// v0: b00322dda0
	it("$path returns the path and query without the base URL, and no `?` for an empty search", async () => {
		const { api } = await app()
		expect([
			api.$path("/health"),
			api.$path("/api/v1/organizations/:orgId", { params: { orgId: "org-1" } }),
			api.$path("/api/health", { search: {} }),
		]).toEqual(["/health", "/api/v1/organizations/org-1", "/api/health"])
	})

	// v0: 7b1ceb7659
	it("$url and $path agree on the encoded path, and $url keeps the base path", async () => {
		const { api } = await app(`${ORIGIN}/v1`)
		const input = { params: { id: "a/b" } }
		expect([api.$url("/users/:id", input), api.$path("/users/:id", input)]).toEqual([
			`${ORIGIN}/v1/users/a%2Fb`,
			"/users/a%2Fb",
		])
	})

	// v0: 02e50937e7
	// v0: 9cfc1dd249
	it("keeps the base path prefix and sorts the query on both $url and $path when asked", async () => {
		const { api } = await app(`${ORIGIN}/api`, { sortSearchParams: true })
		const input = { params: { orgId: "org-1" }, search: { z: "last", a: "first" } }
		expect([api.$url("/v1/organizations/:orgId", input), api.$path("/v1/organizations/:orgId", input)]).toEqual([
			`${ORIGIN}/api/v1/organizations/org-1?a=first&z=last`,
			"/v1/organizations/org-1?a=first&z=last",
		])
	})

	// v0: ddb9c93d69
	it("never fetches", async () => {
		const { api, calls } = await app()
		api.$url("/test", { search: { a: 1 } })
		api.$path("/test")
		expect(calls).toEqual([])
	})
})

describe("app front: sending to a path", () => {
	// v0: 4f0599fcbe
	// v0: b869c422ef
	it("sends to the interpolated URL", async () => {
		const { api, calls } = await app()
		await api.get("/users/:userId", { params: { userId: "42" } })
		await api.get("/users/:id/posts/:postId", { params: { id: "42", postId: "7" } })
		expect(calls.map((call) => call.url)).toEqual([`${ORIGIN}/users/42`, `${ORIGIN}/users/42/posts/7`])
	})

	// v0: fe01068985
	// v0: e3619f2f85
	it("refuses empty and dot-segment params with a PathParamError before sending, even in safe mode", async () => {
		const { api, calls, PathParamError } = await app(ORIGIN, { headers: { authorization: "Bearer t" } })
		await expect(api.get("/api/v1/organizations/:orgId", { params: { orgId: "" } })).rejects.toThrow(
			/Invalid path param "orgId"/,
		)
		await expect(
			api.delete("/orgs/:org/projects/:pid/files/:fid", { params: { fid: "..", org: "acme", pid: "p1" } }),
		).rejects.toThrow(PathParamError)
		await expect(api.get("/:org/:repo", { params: { org: "", repo: "evil.example" } })).rejects.toThrow(PathParamError)
		expect(calls).toEqual([])
	})
})

describe("SDK front: URL vectors", () => {
	// v0: ee37925472
	it.each(VECTORS.filter((v) => !v.path.includes("?")))("sends or refuses as the vector says: $name", async (v) => {
		const { parameters, template } = openApi(v.path)
		const { calls, sdk } = await sdkOf<{ op: Op }>(
			{ [template]: { get: { operationId: "op", parameters, responses: OK } } },
			{ baseURL: `${ORIGIN}${v.base ?? ""}`, requestId: false },
		)
		const result = await sdk.op({ params: v.params, search: v.search })
		expect({
			refused: result.error?.message.includes(v.error ?? "") ?? false,
			url: calls[0]?.url ?? null,
		}).toEqual(want(v))
	})
})

describe("SDK front: path interpolation", () => {
	// v0: b28bfb5318
	// v0: 0cc741d5be
	// v0: cd62ebb707
	it("substitutes every {param} of the OpenAPI path", async () => {
		const { calls, sdk } = await sdkOf<Record<"getExport" | "getPost" | "getUser", Op>>({
			"/orgs/{orgId}/projects/{projectId}/exports/{exportId}": getOp("getExport", ["orgId", "projectId", "exportId"]),
			"/users/{id}": getOp("getUser", ["id"]),
			"/users/{userId}/posts/{postId}": getOp("getPost", ["userId", "postId"]),
		})
		await sdk.getUser({ params: { id: "abc123" } })
		await sdk.getPost({ params: { postId: "99", userId: "1" } })
		await sdk.getExport({ params: { exportId: "e-1", orgId: "o-1", projectId: "p-1" } })
		expect(calls.map((call) => call.url)).toEqual([
			`${ORIGIN}/users/abc123`,
			`${ORIGIN}/users/1/posts/99`,
			`${ORIGIN}/orgs/o-1/projects/p-1/exports/e-1`,
		])
	})

	// v0: 14c5c0feef
	// v0: f8439e0116
	// v0: 81e629816e
	it("percent-encodes path param values, slashes and @ included", async () => {
		const { calls, sdk } = await sdkOf<{ getUser: Op }>({ "/users/{id}": getOp("getUser", ["id"]) })
		await sdk.getUser({ params: { id: "user@domain/path" } })
		await sdk.getUser({ params: { id: "hello world/special" } })
		await sdk.getUser({ params: { id: "a b/c" } })
		expect(calls.map((call) => call.url)).toEqual([
			`${ORIGIN}/users/user%40domain%2Fpath`,
			`${ORIGIN}/users/hello%20world%2Fspecial`,
			`${ORIGIN}/users/a%20b%2Fc`,
		])
	})

	// v0: b44fef713c
	it("interpolates hyphenated brace names and a brace inside a segment (`{id}:cancel`)", async () => {
		const { calls, sdk } = await sdkOf<{ cancelOp: Op; getMember: Op }>({
			"/members/{user-id}": getOp("getMember", ["user-id"]),
			"/ops/{id}:cancel": { post: { operationId: "cancelOp", parameters: [pathParam("id")], responses: OK } },
		})
		await sdk.getMember({ params: { "user-id": "7" } })
		await sdk.cancelOp({ params: { id: "9" } })
		expect(calls.map((call) => [call.method, call.url])).toEqual([
			["GET", `${ORIGIN}/members/7`],
			["POST", `${ORIGIN}/ops/9:cancel`],
		])
	})
})

describe("SDK front: path param errors", () => {
	// v0: 7b5d88a7a5
	// v0: 90ace364d2
	it("throws on a missing required path param in throw mode, sending nothing", async () => {
		const { calls, sdk } = await sdkOf<{ getUser: Op }>(
			{ "/users/{id}": getOp("getUser", ["id"]) },
			{ throwOnError: true },
		)
		await expect(sdk.getUser({ params: {} })).rejects.toThrow("Missing path param: id")
		expect(calls).toEqual([])
	})

	// v0: 8ebd298507
	it("interpolates before sending, and resolves a path param error as a status-0 ClientError in safe mode", async () => {
		const { calls, mod, sdk } = await sdkOf<{ getUser: Op }>({ "/users/{id}": getOp("getUser", ["id"]) })
		const result = await sdk.getUser({ params: { id: ".." } })
		expect({
			calls: calls.length,
			data: result.data,
			isClientError: result.error instanceof (mod.ClientError as Ctor),
			message: result.error?.message,
			status: result.status,
		}).toEqual({
			calls: 0,
			data: null,
			isClientError: true,
			message: expect.stringContaining('Invalid path param "id"'),
			status: 0,
		})
	})
})
