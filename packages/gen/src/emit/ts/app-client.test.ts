import { describe, expect, it } from "vitest"
import { emittedApp, recordingFetch } from "./__fixtures__/emitted.ts"

type Verb = "delete" | "get" | "patch" | "post" | "put"

type Call = (path: string, input?: object) => Promise<unknown>

/** The emitted client as these tests drive it; its types are pinned in core's app-client.typetest.ts. */
type Client = { readonly [V in Verb]: Call } & { readonly safe: { readonly [V in Verb]: Call }; readonly ws: unknown }

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
		const api = createClient({ baseURL: "http://test", fetch: recordingFetch().fetch })
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
	it("sends each verb as its method, json as the body, and resolves the answer as the data", async () => {
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
			results: ["POST", "PUT", "PATCH", "DELETE"].map((method) => ({ method })),
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
	it("runs over any fetch-shaped handler, in process: a text answer resolves as the string", async () => {
		const { createClient } = await front()
		const { calls, fetch } = recordingFetch(() => new Response("ok", { headers: { "content-type": "text/plain" } }))
		const api = createClient({ baseURL: "http://test", fetch })
		expect([await api.get("/api/health"), calls.map((call) => call.url)]).toEqual(["ok", ["http://test/api/health"]])
	})

	// v0: 6809e34cc0
	it("chains create, list, delete by param and read against one API, a 204 resolving null and a gone resource an error", async () => {
		const { createClient } = await front()
		const { calls, fetch } = recordingFetch(organizations())
		const api = createClient({ baseURL: "http://test", fetch, headers: { authorization: "Bearer test" } })
		for (const slug of ["a", "b", "c"]) await api.post("/api/v1/organizations", { json: { name: slug, slug } })
		const before = await api.safe.get("/api/v1/organizations")
		const removed = await api.safe.delete("/api/v1/organizations/:orgId", { params: { orgId: "org-2" } })
		const after = await api.safe.get("/api/v1/organizations")
		const gone = await api.safe.get("/api/v1/organizations/:orgId", { params: { orgId: "org-2" } })
		expect([before, removed, after, gone]).toMatchObject([
			{ data: { total: 4 }, ok: true, response: { status: 200 } },
			{ data: null, ok: true, response: { status: 204 } },
			{ data: { total: 3 }, ok: true, response: { status: 200 } },
			{ error: { body: { error_key: "not_found" }, status: 404 }, ok: false, response: { status: 404 } },
		])
		expect(calls.map((call) => [call.method, call.url, call.headers.get("authorization")]).slice(4, 6)).toEqual([
			["DELETE", "http://test/api/v1/organizations/org-2", "Bearer test"],
			["GET", "http://test/api/v1/organizations", "Bearer test"],
		])
	})
})

describe("createClient: the safe twin and the normal client", () => {
	// v0: f91714b808
	// v0: 850ca0e9f4
	it("safe resolves a 2xx json answer as an Ok of the data and its response", async () => {
		const { createClient } = await front()
		const { calls, fetch } = recordingFetch(() => Response.json({ id: "1", name: "test" }))
		const api = createClient({ baseURL: "http://test", fetch })
		const result = await api.safe.get("/items/:id", { params: { id: "1" } })
		expect([result, calls[0]?.url]).toMatchObject([
			{ data: { id: "1", name: "test" }, ok: true, response: { status: 200 } },
			"http://test/items/1",
		])
		expect(Object.keys(result as object).sort()).toEqual(["data", "ok", "response"])
	})

	// v0: 05bfebf817
	// v0: 614de19390
	// v0: 93cd837821
	// v0: bbe9086162
	// v0: cb37af43a2
	it("safe resolves a non-2xx as an Err of its ClientError, the json body verbatim, beside its response", async () => {
		const { ClientError, createClient } = await front()
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
		const results = [await api.safe.get("/fail"), await api.safe.post("/register"), await api.safe.get("/std-err")]
		expect(results).toMatchObject(
			Object.values(bodies).map(([body, status]) => ({ error: { body, status }, ok: false, response: { status } })),
		)
		expect(results.map((result) => (result as { error: unknown }).error instanceof ClientError)).toEqual([
			true,
			true,
			true,
		])
	})

	// v0: 9a87d3067d
	it("the normal client rejects a non-2xx answer with the status's ClientError, its body the parsed payload", async () => {
		const { ClientError, NotFoundError, createClient } = await front()
		const payload = { reason: "Item deleted", suggestions: ["/items/456"] }
		const { fetch } = recordingFetch(() => Response.json(payload, { status: 404 }))
		const api = createClient({ baseURL: "http://test", fetch })
		const error = await api.get("/custom-404").catch((thrown: unknown) => thrown)
		expect([error instanceof ClientError, error instanceof NotFoundError, error]).toMatchObject([
			true,
			true,
			{ body: payload, status: 404 },
		])
	})
})

describe("createClient: the safe object", () => {
	it("is one safe object on every read, its Ok and Err from the same calls the normal client throws", async () => {
		const { NotFoundError, createClient } = await front()
		const { fetch } = recordingFetch((request) =>
			request.url.endsWith("/gone") ? Response.json({ reason: "x" }, { status: 404 }) : Response.json({ id: "1" }),
		)
		const api = createClient({ baseURL: "http://test", fetch })
		const ok = await api.safe.get("/here")
		const err = await api.safe.get("/gone")
		const thrown = await api.get("/gone").catch((e: unknown) => e)
		expect([api.safe === api.safe, ok, err, thrown instanceof NotFoundError]).toMatchObject([
			true,
			{ data: { id: "1" }, ok: true },
			{ error: { body: { reason: "x" }, status: 404 }, ok: false, response: { status: 404 } },
			true,
		])
		expect((err as { error: unknown }).error instanceof NotFoundError).toBe(true)
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
