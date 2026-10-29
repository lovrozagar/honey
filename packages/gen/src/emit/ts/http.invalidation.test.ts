import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
/** What a safe call resolves to. */
type Result = { data?: unknown; error?: { name: string; status: number }; ok: boolean; response: Response }
type Op = (input?: Json) => Promise<unknown>
type Sdk = Record<string, Record<string, Op>> & {
	safe: Record<string, Record<string, (input?: Json) => Promise<Result>>>
}
/** One request's invalidation view, as a hook sees it. */
type View = { invalidatedBy?: string[]; isStale?: boolean; selector?: string }

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const BODY = { content: { "application/json": { schema: { type: "object" } } } }

/** An OpenAPI 3.1 document over `paths`. */
function doc(paths: Json): Json {
	return { info: { title: "t", version: "1" }, openapi: "3.1.0", paths }
}

/** A required string path parameter. */
function param(name: string): Json {
	return { in: "path", name, required: true, schema: { type: "string" } }
}

/** A `users` resource whose `create` and `update` mutations invalidate the given targets. */
function users(invalidate: { create?: string[]; update?: string[] }, createResponses: Json = OK): Json {
	const mutation = (operationId: string, targets: string[] | undefined, responses: Json): Json =>
		targets === undefined
			? { operationId, requestBody: BODY, responses }
			: { operationId, requestBody: BODY, responses, "x-invalidate": targets }
	return doc({
		"/users": {
			get: { operationId: "users.list", responses: OK },
			post: mutation("users.create", invalidate.create, createResponses),
		},
		"/users/{id}": {
			get: { operationId: "users.get", parameters: [param("id")], responses: OK },
			patch: { ...mutation("users.update", invalidate.update, OK), parameters: [param("id")] },
		},
	})
}

/** `orgs.update` (`PUT /orgs/{org}`) invalidates `GET /orgs/:org/members/:id`, which it can only partly resolve. */
const ORGS = doc({
	"/orgs/{org}": {
		put: {
			operationId: "orgs.update",
			parameters: [param("org")],
			responses: OK,
			"x-invalidate": ["GET /orgs/:org/members/:id"],
		},
	},
	"/orgs/{org}/members/{id}": {
		get: { operationId: "members.get", parameters: [param("org"), param("id")], responses: OK },
	},
})

/** The emitted SDK for `document` with invalidation on, recording each request's view from `onRequest`. */
async function staleSdk(
	document: Json,
	answer?: (request: Request) => Response,
	config: Json = {},
): Promise<{ calls: Request[]; sdk: Sdk; views: View[] }> {
	const { TestSDK } = (await emittedSdk(document)) as unknown as { TestSDK: new (config: Json) => Sdk }
	const { calls, fetch } = recordingFetch(answer)
	const views: View[] = []
	const onRequest = [
		(ctx: View) => void views.push({ invalidatedBy: ctx.invalidatedBy, isStale: ctx.isStale, selector: ctx.selector }),
	]
	const sdk = new TestSDK({
		baseURL: "https://api.test.com",
		fetch,
		invalidation: { staleTime: 5_000 },
		onRequest,
		...config,
	})
	return { calls, sdk, views }
}

/** A fetch answer that fails the `failing`-th request (0-based) with a 500 and answers `{}` otherwise. */
function failingAt(failing: number): (request: Request) => Response {
	let n = 0
	return () => (n++ === failing ? Response.json({ error: "fail" }, { status: 500 }) : Response.json({}))
}

describe("invalidation: a successful mutation marks its targets stale for the next read", () => {
	// v0: 1732d1d03b
	it("marks the collection stale after a create", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }))
		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		expect(views.map((view) => view.isStale)).toEqual([false, true])
	})

	// v0: bb125595cf
	it("names the mutation's concrete selector in invalidatedBy", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }))
		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		expect(views[1]?.invalidatedBy).toEqual(["POST /users"])
	})

	// v0: 8d32f6c1d6
	it("accumulates every mutation that marked a target in invalidatedBy", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"], update: ["GET /users"] }))
		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.update({ json: { name: "Bob" }, params: { id: "5" } })
		await sdk.users.list()
		expect(views[2]?.invalidatedBy).toEqual(["POST /users", "PATCH /users/5"])
	})
})

describe("invalidation: the request view hooks see", () => {
	// v0: d7aee41a8e
	it("reads not stale, with an empty invalidatedBy, when nothing was mutated", async () => {
		const { sdk, views } = await staleSdk(users({}))
		await sdk.users.list()
		expect(views).toEqual([{ invalidatedBy: [], isStale: false, selector: "GET /users" }])
	})

	// v0: bb2d9fd994
	it("gives the read's selector with its path parameters filled in", async () => {
		const { sdk, views } = await staleSdk(users({}))
		await sdk.users.get({ params: { id: "2" } })
		expect(views[0]?.selector).toBe("GET /users/2")
	})

	// v0: 57e1399b05
	it("shows onResponse the same isStale and invalidatedBy", async () => {
		const seen: View[] = []
		const onResponse = [(ctx: View) => void seen.push({ invalidatedBy: ctx.invalidatedBy, isStale: ctx.isStale })]
		const { sdk } = await staleSdk(users({ create: ["GET /users"] }), undefined, { onResponse })
		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		expect(seen[1]).toEqual({ invalidatedBy: ["POST /users"], isStale: true })
	})

	// v0: 3483b59c8b
	it("adds no invalidation fields to the hook context when invalidation is not configured", async () => {
		const contexts: Json[] = []
		const { sdk } = await staleSdk(users({ create: ["GET /users"] }), undefined, {
			invalidation: undefined,
			onRequest: [(ctx: Json) => void contexts.push(ctx)],
		})
		await sdk.users.list()
		expect(["invalidatedBy", "isStale", "selector"].filter((key) => contexts[0]?.[key] !== undefined)).toEqual([])
	})
})

describe("invalidation: which reads a mark reaches", () => {
	// v0: 314714aff6
	it("stales only the mutated instance of a pattern target", async () => {
		const { sdk, views } = await staleSdk(users({ update: ["GET /users/:id"] }))
		await sdk.users.update({ json: { name: "Bob" }, params: { id: "2" } })
		await sdk.users.get({ params: { id: "2" } })
		await sdk.users.get({ params: { id: "3" } })
		expect(views.slice(1).map(({ isStale, selector }) => [selector, isStale])).toEqual([
			["GET /users/2", true],
			["GET /users/3", false],
		])
	})

	// v0: 18612a8343
	it("stales the instance and the collection, not other instances", async () => {
		const { sdk, views } = await staleSdk(users({ update: ["GET /users/:id", "GET /users"] }))
		await sdk.users.update({ json: { name: "Bob" }, params: { id: "2" } })
		await sdk.users.get({ params: { id: "2" } })
		await sdk.users.list()
		await sdk.users.get({ params: { id: "3" } })
		expect(views.slice(1).map((view) => view.isStale)).toEqual([true, true, false])
	})

	// v0: 3bad44de1d
	// v0: b61a128a87
	it("marks a partially resolvable target as the narrower pattern", async () => {
		const { calls, sdk, views } = await staleSdk(ORGS)
		await sdk.orgs.update({ params: { org: "acme" } })
		await sdk.members.get({ params: { id: "1", org: "acme" } })
		await sdk.members.get({ params: { id: "1", org: "other" } })
		expect([calls.length, views.map((view) => view.isStale)]).toEqual([3, [false, true, false]])
	})
})

describe("invalidation: concrete and nested targets", () => {
	// v0: 60cb7791ec
	it("treats a concrete target containing ':' as one resource, not a pattern", async () => {
		const { sdk, views } = await staleSdk(
			doc({
				"/ops/{id}:cancel": {
					get: { operationId: "ops.get", parameters: [param("id")], responses: OK },
					post: {
						operationId: "ops.cancel",
						parameters: [param("id")],
						responses: OK,
						"x-invalidate": ["GET /ops/1:cancel"],
					},
				},
			}),
		)
		await sdk.ops.cancel({ params: { id: "1" } })
		await sdk.ops.get({ params: { id: "2" } })
		await sdk.ops.get({ params: { id: "1" } })
		expect(views.map((view) => view.isStale)).toEqual([false, false, true])
	})

	// v0: f03959040b
	it("marks stale from a method nested two namespaces deep", async () => {
		const { calls, sdk, views } = await staleSdk(
			doc({
				"/users": {
					get: { operationId: "admin.users.list", responses: OK },
					post: { operationId: "admin.users.create", requestBody: BODY, responses: OK, "x-invalidate": ["GET /users"] },
				},
			}),
		)
		const admin = sdk.admin as unknown as Record<string, Record<string, Op>>
		await admin.users?.create?.({ json: { name: "Alice" } })
		await admin.users?.list?.()
		expect([calls.map((call) => call.method), views.map((view) => view.isStale)]).toEqual([
			["POST", "GET"],
			[false, true],
		])
	})
})

describe("invalidation: when a mark is set and cleared", () => {
	// v0: 57194d84d8
	it("does not mark anything when the mutation fails", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }), failingAt(0))
		const failed = await sdk.safe.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		expect([failed.ok, views[1]?.isStale]).toEqual([false, false])
	})

	// v0: eb7dbb0cc1
	// v0: fb33cc6ae8
	it("marks stale after a 204 mutation, which has no data", async () => {
		const created = { 204: { description: "created" } }
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }, created), (request) =>
			request.method === "POST" ? new Response(null, { status: 204 }) : Response.json([]),
		)
		await sdk.users.create({ json: { name: "Bob" } })
		await sdk.users.list()
		expect(views[1]).toMatchObject({ invalidatedBy: ["POST /users"], isStale: true })
	})

	// v0: 6296b0d960
	it("marks stale on a 2xx mutation even when its body fails to parse", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }), (request) =>
			request.method === "POST"
				? new Response("{not json", { headers: { "content-type": "application/json" } })
				: Response.json([]),
		)
		const created = await sdk.safe.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		expect([created.response.status, created.error?.name, views[1]?.isStale]).toEqual([200, "DecodeError", true])
	})
})

describe("invalidation: when a mark clears", () => {
	// v0: 2b55346cbe
	it("clears a mark after one successful read", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }))
		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		await sdk.users.list()
		expect(views.map((view) => view.isStale)).toEqual([false, true, false])
	})

	// v0: 69d633b367
	it("keeps a mark after a failed read", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }), failingAt(1))
		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.safe.users.list()
		await sdk.users.list()
		expect(views.slice(1).map((view) => view.isStale)).toEqual([true, true])
	})

	// v0: 1889e96a5a
	it("lets a mark expire after staleTime", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users"] }), undefined, {
			invalidation: { staleTime: 50 },
		})
		await sdk.users.create({ json: { name: "Alice" } })
		await new Promise((resolve) => setTimeout(resolve, 60))
		await sdk.users.list()
		expect(views[1]?.isStale).toBe(false)
	})

	// v0: e137c4fbc0
	it("clears a pattern mark per instance: each instance reads stale once", async () => {
		const { sdk, views } = await staleSdk(users({ create: ["GET /users/:id"] }))
		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.get({ params: { id: "2" } })
		await sdk.users.get({ params: { id: "3" } })
		await sdk.users.get({ params: { id: "2" } })
		expect(views.slice(1).map((view) => view.isStale)).toEqual([true, true, false])
	})

	// v0: 4c89e536df
	it("clears only the read instance's share of a partially resolved pattern mark", async () => {
		const { sdk, views } = await staleSdk(ORGS)
		await sdk.orgs.update({ params: { org: "acme" } })
		await sdk.members.get({ params: { id: "1", org: "acme" } })
		await sdk.members.get({ params: { id: "1", org: "acme" } })
		await sdk.members.get({ params: { id: "2", org: "acme" } })
		expect(views.slice(1).map((view) => view.isStale)).toEqual([true, false, true])
	})
})
