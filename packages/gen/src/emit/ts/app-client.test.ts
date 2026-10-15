import { describe, expect, it } from "vitest"
import { emittedApp, recordingFetch } from "./__fixtures__/emitted.ts"

type Verb = "delete" | "get" | "patch" | "post" | "put"

/** The emitted client as these tests drive it; its types are pinned in core's app-client.typetest.ts. */
type Client = { readonly [V in Verb]: (path: string, input?: object) => Promise<unknown> } & { readonly ws: unknown }

type ErrorClass = abstract new (...args: never[]) => Error

/** The emitted app front: createClient and the error classes a thrown call is checked against. */
async function front(): Promise<{
	ClientError: ErrorClass
	createClient: (config: object) => Client
	NotFoundError: ErrorClass
}> {
	return (await emittedApp()) as never
}

/** An in-memory organizations API under /api/v1: list, create, read and delete. */
function organizations(): (request: Request) => Promise<Response> {
	const orgs = new Map<string, unknown>([["acme", { name: "acme" }]])
	let created = 0
	return async (request) => {
		const id = new URL(request.url).pathname.split("/")[4]
		if (request.method === "POST") {
			const org = { ...((await request.json()) as object), id: `org-${++created}` }
			orgs.set(org.id, org)
			return Response.json(org, { status: 201 })
		}
		if (id === undefined) return Response.json({ items: [...orgs.values()], total: orgs.size })
		if (!orgs.has(id)) return Response.json({ error_key: "not_found", status: 404 }, { status: 404 })
		if (request.method === "DELETE") {
			orgs.delete(id)
			return new Response(null, { status: 204 })
		}
		return Response.json(orgs.get(id))
	}
}

describe("createClient: a Proxy over the HTTP methods", () => {
	// v0: 21ca2ca75f
	it("answers every verb and ws with a function", async () => {
		const { createClient } = await front()
		const api = createClient({ baseURL: "http://test", fetch: recordingFetch().fetch, throwOnError: true })
		expect((["get", "post", "put", "patch", "delete", "ws"] as const).map((key) => typeof api[key])).toEqual([
			"function",
			"function",
			"function",
			"function",
			"function",
			"function",
		])
	})

	// v0: 4d920e4c7c
	// v0: ac0f2f1c40
	// v0: 74bd25361d
	// v0: 9a2142697f
	it("sends each verb as its method, json as the body, and resolves the answer as data beside a null error", async () => {
		const { createClient } = await front()
		const { calls, fetch } = recordingFetch((request) => Response.json({ method: request.method }))
		const api = createClient({ baseURL: "http://test", fetch })
		const results = [
			await api.post("/api/echo", { json: {} }),
			await api.put("/api/echo", { json: {} }),
			await api.patch("/api/echo", { json: {} }),
			await api.delete("/api/echo"),
		]
		const sent = await Promise.all(calls.map(async (call) => [call.method, call.url, await call.text()]))
		expect({ results, sent }).toMatchObject({
			results: ["POST", "PUT", "PATCH", "DELETE"].map((method) => ({ data: { method }, error: null, status: 200 })),
			sent: [
				["POST", "http://test/api/echo", "{}"],
				["PUT", "http://test/api/echo", "{}"],
				["PATCH", "http://test/api/echo", "{}"],
				["DELETE", "http://test/api/echo", ""],
			],
		})
	})
})

describe("createClient: any fetch, params and a chain of calls", () => {
	// v0: 0bb3cc4326
	it("runs over any fetch-shaped handler, in process: throw mode resolves a text answer as the string", async () => {
		const { createClient } = await front()
		const { calls, fetch } = recordingFetch(() => new Response("ok", { headers: { "content-type": "text/plain" } }))
		const api = createClient({ baseURL: "http://test", fetch, throwOnError: true })
		expect([await api.get("/api/health"), calls.map((call) => call.url)]).toEqual(["ok", ["http://test/api/health"]])
	})

	// v0: 6809e34cc0
	it("chains create, list, delete by param and read against one API, a 204 resolving null and a gone resource an error", async () => {
		const { createClient } = await front()
		const { calls, fetch } = recordingFetch(organizations())
		const api = createClient({ baseURL: "http://test", fetch, headers: { authorization: "Bearer test" } })
		for (const slug of ["a", "b", "c"]) await api.post("/api/v1/organizations", { json: { name: slug, slug } })
		const before = await api.get("/api/v1/organizations")
		const removed = await api.delete("/api/v1/organizations/:orgId", { params: { orgId: "org-2" } })
		const after = await api.get("/api/v1/organizations")
		const gone = await api.get("/api/v1/organizations/:orgId", { params: { orgId: "org-2" } })
		expect([before, removed, after, gone]).toMatchObject([
			{ data: { total: 4 }, error: null, status: 200 },
			{ data: null, error: null, status: 204 },
			{ data: { total: 3 }, error: null, status: 200 },
			{ data: null, error: { error_key: "not_found" }, status: 404 },
		])
		expect(calls.map((call) => [call.method, call.url, call.headers.get("authorization")]).slice(4, 6)).toEqual([
			["DELETE", "http://test/api/v1/organizations/org-2", "Bearer test"],
			["GET", "http://test/api/v1/organizations", "Bearer test"],
		])
	})
})

describe("createClient: result mode and throw mode", () => {
	// v0: f91714b808
	// v0: 850ca0e9f4
	it("result mode resolves a 2xx json answer as data beside a null error and its status", async () => {
		const { createClient } = await front()
		const { calls, fetch } = recordingFetch(() => Response.json({ id: "1", name: "test" }))
		const api = createClient({ baseURL: "http://test", fetch })
		expect([await api.get("/items/:id", { params: { id: "1" } }), calls[0]?.url]).toMatchObject([
			{ data: { id: "1", name: "test" }, error: null, status: 200 },
			"http://test/items/1",
		])
	})

	// v0: 05bfebf817
	// v0: 614de19390
	// v0: 93cd837821
	// v0: bbe9086162
	// v0: cb37af43a2
	it("result mode resolves a non-2xx json body verbatim as the error, beside its status and null data", async () => {
		const { createClient } = await front()
		const bodies: Readonly<Record<string, readonly [object, number]>> = {
			"/fail": [{ reason: "deleted" }, 404],
			"/register": [{ error_key: "email_taken", fields: {}, message: "Email taken", status: 409, success: false }, 409],
			"/std-err": [{ error_key: "email_taken", message: "Email taken", status: 409, ts: 1000 }, 409],
		}
		const { fetch } = recordingFetch((request) => {
			const [body, status] = bodies[new URL(request.url).pathname] ?? [{}, 500]
			return Response.json(body, { status })
		})
		const api = createClient({ baseURL: "http://test", fetch })
		expect([await api.get("/fail"), await api.post("/register"), await api.get("/std-err")]).toMatchObject(
			Object.values(bodies).map(([error, status]) => ({ data: null, error, status })),
		)
	})

	// v0: 9a87d3067d
	it("throw mode rejects a non-2xx answer with the status's ClientError, its body the parsed payload", async () => {
		const { ClientError, NotFoundError, createClient } = await front()
		const payload = { reason: "Item deleted", suggestions: ["/items/456"] }
		const { fetch } = recordingFetch(() => Response.json(payload, { status: 404 }))
		const api = createClient({ baseURL: "http://test", fetch, throwOnError: true })
		const error = await api.get("/custom-404").catch((thrown: unknown) => thrown)
		expect([error instanceof ClientError, error instanceof NotFoundError, error]).toMatchObject([
			true,
			true,
			{ body: payload, status: 404 },
		])
	})
})

describe("the client object", () => {
	// v0: a42bc08c59
	it("prints as [object HoneyClient] and is not a thenable", async () => {
		const { calls, fetch } = recordingFetch()
		const api = (await front()).createClient({ baseURL: "https://api.example.com", fetch })
		expect([
			String(api),
			Object.prototype.toString.call(api),
			(api as { then?: unknown }).then,
			(await Promise.resolve(api)) === api,
		]).toEqual(["[object HoneyClient]", "[object HoneyClient]", undefined, true])
		expect(calls).toEqual([])
	})
})
