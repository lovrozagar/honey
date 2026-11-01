/**
 * The vendored TanStack Query adapter's behavior (bit 22). Phase 2 drives the runtime module directly;
 * phase 3 adds the leg over the emitted `<stem>.tanstack-query.gen.ts`, which is what proves the vendored
 * text an SDK ships is this text. The invalidation cases come from the package this replaces,
 * `monorepo/packages/query-client/src/repo.query-client.invalidation.test.ts`, so a read-after-write that
 * worked there works here.
 */
import { QueryClient, type QueryKey } from "@tanstack/query-core"
import { describe, expect, it } from "vitest"
import type { ServiceMap } from "../../runtime/ts/sdk.ts"
import type { Surface } from "../../runtime/ts-tanstack-query/query.ts"
import { emittedTanstackQuery } from "./__fixtures__/emitted.ts"
import { queryHelpers } from "../../runtime/ts-tanstack-query/query.ts"

const ORG = "org_1"
const SDK_NAME = "anyrow"

/* the shape serviceMapOf emits: `{p}` kept in `path`, `params` naming the path slots, flags only when set */
const serviceMap: ServiceMap = {
	extract: {
		stream: {
			invalidate: ["GET /v1/projects/rows"],
			method: "POST",
			path: "/v1/projects/extract-stream",
			sse: true,
		},
		watch: { method: "GET", path: "/v1/projects/watch", ws: true },
	},
	org: {
		create: { invalidate: ["GET /v1/organizations"], method: "POST", path: "/v1/organizations" },
		get: { method: "GET", params: ["organization_id"], path: "/v1/organizations/{organization_id}" },
		list: { method: "GET", path: "/v1/organizations" },
		update: {
			invalidate: ["GET /v1/organizations", "GET /v1/organizations/:organization_id"],
			method: "PATCH",
			params: ["organization_id"],
			path: "/v1/organizations/{organization_id}",
		},
	},
	other: {
		noop: { method: "POST", path: "/v1/other" },
		unknown: { invalidate: ["GET /v1/nope"], method: "POST", path: "/v1/other/unknown" },
	},
}

const sdk = {
	extract: { stream: () => ({ events: true }), watch: () => ({ socket: true }) },
	org: {
		explode: (): Promise<{ ok: boolean }> => Promise.reject(new Error("boom")),
		get: (req?: { params: { organization_id: string } }) => Promise.resolve({ id: req?.params.organization_id ?? "" }),
		list: () => Promise.resolve([]),
		/* params is optional here only so the missing-param case can reach the real mutationFn */
		update: (req: { json?: { name: string }; params?: { organization_id: string } }) =>
			Promise.resolve({ id: req.params?.organization_id ?? "", name: req.json?.name ?? "" }),
	},
	other: { noop: () => Promise.resolve({}), unknown: () => Promise.resolve({}) },
}

/** A client that records what was invalidated instead of invalidating it. */
function trackingClient(): { client: QueryClient; keys: QueryKey[] } {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
	const keys: QueryKey[] = []
	client.invalidateQueries = async (filters) => {
		if (filters && "queryKey" in filters && filters.queryKey !== undefined) keys.push(filters.queryKey)
	}
	return { client, keys }
}

const helpersWith = (client?: QueryClient) =>
	queryHelpers(sdk, serviceMap, SDK_NAME, client === undefined ? {} : { getQueryClient: () => client })

describe("the adapter's surfaces follow the service map, not method names", () => {
	it("keys a read by its member path and request, and seeds nothing", async () => {
		const options = helpersWith().query.org.get({ reqOptions: { req: { params: { organization_id: ORG } } } })
		expect(options.queryKey).toEqual([SDK_NAME, "org", "get", { params: { organization_id: ORG } }])
		/* solid-query reads `initialData?: Data | undefined` as the seeded overload, so it is present and undefined */
		expect("initialData" in options).toBe(true)
		expect(options.initialData).toBeUndefined()
		await expect((options.queryFn as () => Promise<{ id: string }>)()).resolves.toEqual({ id: ORG })
	})

	it("splits by method, so a write is never a query and `list`/`retrieve` names decide nothing", () => {
		const helpers = helpersWith()
		expect(helpers.query.org.list).toBeTypeOf("function")
		expect(helpers.query.org.get).toBeTypeOf("function")
		expect(helpers.mutation.org.update).toBeTypeOf("function")
		expect(helpers.mutation.org.create).toBeTypeOf("function")
		/* `update` is a PATCH: it is not a read, however it is named */
		expect(helpers.query.org.update).toBeUndefined()
		/* `get` is a GET: it is not a write */
		expect(helpers.mutation.org.get).toBeUndefined()
	})

	it("leaves an event stream and a websocket out of both surfaces", () => {
		const helpers = helpersWith()
		expect(helpers.mutation.extract.stream).toBeUndefined()
		expect(helpers.query.extract.stream).toBeUndefined()
		expect(helpers.query.extract.watch).toBeUndefined()
		expect(helpers.mutation.extract.watch).toBeUndefined()
	})

	it("keys a mutation by its member path", () => {
		expect(helpersWith().mutationKey.org.update({ params: { organization_id: ORG } })).toEqual([
			SDK_NAME,
			"org",
			"update",
			{ params: { organization_id: ORG } },
		])
	})
})

describe("a write invalidates what its x-invalidate names", () => {
	it("invalidates the list and that one org, with the params filled in", async () => {
		const { client, keys } = trackingClient()
		const options = helpersWith(client).mutation.org.update()
		await options.mutationFn({ json: { name: "Acme" }, params: { organization_id: ORG } })
		expect(keys).toEqual([
			[SDK_NAME, "org", "list"],
			[SDK_NAME, "org", "get", { params: { organization_id: ORG } }],
		])
	})

	it("reads a `{id}` path and a `:id` selector as one key", async () => {
		const braced: ServiceMap = {
			item: {
				get: { method: "GET", params: ["id"], path: "/v1/items/{id}" },
				patch: { invalidate: ["GET /v1/items/:id"], method: "PATCH", params: ["id"], path: "/v1/items/{id}" },
			},
		}
		const { client, keys } = trackingClient()
		const sdkItem = { item: { get: () => Promise.resolve({}), patch: () => Promise.resolve({}) } }
		const helpers = queryHelpers(sdkItem, braced, SDK_NAME, { getQueryClient: () => client })
		await helpers.mutation.item.patch().mutationFn({ params: { id: "i1" } })
		expect(keys).toEqual([[SDK_NAME, "item", "get", { params: { id: "i1" } }]])
	})

	it("keeps the mutation's body off the read's key", async () => {
		const { client, keys } = trackingClient()
		await helpersWith(client)
			.mutation.org.update()
			.mutationFn({ json: { name: "Acme" }, params: { organization_id: ORG } })
		expect(keys[1]).toEqual([SDK_NAME, "org", "get", { params: { organization_id: ORG } }])
		expect(JSON.stringify(keys)).not.toContain("Acme")
	})

	it("falls back to the read's prefix when a param has no value", async () => {
		const { client, keys } = trackingClient()
		await helpersWith(client)
			.mutation.org.update()
			.mutationFn({ json: { name: "x" } })
		expect(keys).toEqual([
			[SDK_NAME, "org", "list"],
			[SDK_NAME, "org", "get"],
		])
	})
})

const json = () => ({ content: { "application/json": { schema: { type: "object" } } }, description: "" })

describe("the emitted adapter is this adapter", () => {
	/* the vendored text is only worth testing above if what an SDK ships is the same text, run end to end */
	const document = {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/orgs": {
				get: { operationId: "org.list", responses: { 200: json() } },
				post: { operationId: "org.create", responses: { 201: json() }, "x-invalidate": ["GET /orgs"] },
			},
		},
	}

	it("keys a read and invalidates a write through the file generateSdk wrote", async () => {
		const { client, keys } = trackingClient()
		const emitted = (await emittedTanstackQuery(document)) as unknown as {
			createQueryHelpers: (
				sdk: unknown,
				options: { getQueryClient: () => QueryClient },
			) => {
				mutation: Surface
				query: Surface
			}
		}
		const helpers = emitted.createQueryHelpers(
			{ org: { create: () => Promise.resolve({ id: "o1" }), list: () => Promise.resolve([]) } },
			{ getQueryClient: () => client },
		)
		expect(helpers.query.org.list().queryKey).toEqual(["TestSDK", "org", "list"])
		await helpers.mutation.org.create().mutationFn({})
		expect(keys).toEqual([["TestSDK", "org", "list"]])
		/* the stream guard travels too: `org.create` is a write here, and a read is not on the write surface */
		expect(helpers.mutation.org.list).toBeUndefined()
	})
})

describe("a write invalidates nothing when there is nothing to make stale", () => {
	it("invalidates nothing for an empty or unknown selector", async () => {
		const { client, keys } = trackingClient()
		const helpers = helpersWith(client)
		await helpers.mutation.other.noop().mutationFn({})
		await helpers.mutation.other.unknown().mutationFn({})
		expect(keys).toEqual([])
	})

	it("invalidates nothing when the call throws", async () => {
		const { client, keys } = trackingClient()
		const rejecting = queryHelpers({ ...sdk, org: { ...sdk.org, update: sdk.org.explode } }, serviceMap, SDK_NAME, {
			getQueryClient: () => client,
		})
		await expect(rejecting.mutation.org.update().mutationFn({ params: { organization_id: ORG } })).rejects.toThrow(
			"boom",
		)
		expect(keys).toEqual([])
	})

	it("still answers the call when no query client was given", async () => {
		const options = helpersWith().mutation.org.update()
		await expect(options.mutationFn({ json: { name: "Acme" }, params: { organization_id: ORG } })).resolves.toEqual({
			id: ORG,
			name: "Acme",
		})
	})
})
