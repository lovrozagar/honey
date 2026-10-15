import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, any>
type Ctx = Record<string, any>

const OK = { 200: { content: { "application/json": { schema: {} } }, description: "" } }

/** The path parameters `{name}` in `path` declares. */
function pathParams(path: string): Json[] {
	return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
		in: "path",
		name,
		required: true,
		schema: { type: "string" },
	}))
}

/**
 * Whether each GET of `reads` (literal paths) is stale after one `PATCH mutation` called with `params`
 * that invalidates `targets`.
 */
async function staleReads(
	mutation: string,
	params: Record<string, string> | undefined,
	targets: string[],
	reads: string[],
): Promise<boolean[]> {
	const paths: Json = {
		[mutation]: {
			patch: { operationId: "mutate", parameters: pathParams(mutation), responses: OK, "x-invalidate": targets },
		},
	}
	const unique = [...new Set(reads)]
	for (const [i, read] of unique.entries()) paths[read] = { get: { operationId: `read${i}`, responses: OK } }
	const { TestSDK } = await emittedSdk({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })
	const stale: boolean[] = []
	const sdk = new (TestSDK as new (config: Json) => any)({
		baseURL: "https://api.test",
		fetch: recordingFetch().fetch,
		invalidation: { staleTime: 60_000 },
		onRequest: [(ctx: Ctx) => void (ctx.method === "GET" && stale.push(ctx.isStale === true))],
	})
	await sdk.mutate(params === undefined ? {} : { params })
	for (const read of reads) await sdk[`read${unique.indexOf(read)}`]()
	return stale
}

describe("stale matching: a pattern mark against a concrete read", () => {
	it.each([
		// v0: 9e444a90cf
		["/v1/users", "/v1/users", true],
		// v0: 94c455dadf
		["/v1/users/:id", "/v1/users/123", true],
		// v0: bb8c6cd751
		["/v1/users/:id/comments/:cid", "/v1/users/123/comments/456", true],
		// v0: 2336f5389a
		["/v1/:org/users", "/v1/acme/posts", false],
		// v0: 1f2fb78e42
		["/v1/:org/a.c", "/v1/acme/a.c", true],
		// v0: ce47584f84
		["/v1/:org/.", "/v1/acme/x", false],
		// v0: b11701874d
		["/v1/:org/(admin|user)", "/v1/acme/admin", false],
		// v0: c07376999d
		["/v1/:org/a+b", "/v1/acme/aab", false],
	] as const)("a mark on GET %s stales GET %s: %s", async (pattern, read, stale) => {
		expect(await staleReads("/m", undefined, [`GET ${pattern}`], [read])).toEqual([stale])
	})
})

/** One resolution case: `mutation` called with `params` invalidates `targets`; `stale` is what each of `reads` sees. */
type Resolution = {
	title: string
	mutation: string
	params?: Record<string, string>
	targets: string[]
	reads: string[]
	stale: boolean[]
}

describe("invalidation targets resolved from the mutation's params", () => {
	it.each<Resolution>([
		// v0: 2b1b556f1a
		{
			mutation: "/m/{id}",
			params: { id: "42" },
			reads: ["/v1/x"],
			stale: [true],
			targets: ["GET /v1/x"],
			title: "a target without placeholders passes through",
		},
		// v0: 359cf9c663
		{
			mutation: "/m",
			reads: ["/v1/x/9"],
			stale: [true],
			targets: ["GET /v1/x/:id"],
			title: "a mutation without params keeps the target a pattern",
		},
		// v0: b740ce0bfe
		{
			mutation: "/m/{id}",
			params: { id: "1" },
			reads: ["/v1/x/1"],
			stale: [false],
			targets: [],
			title: "an empty target list marks nothing",
		},
		// v0: bb778cc79c
		{
			mutation: "/m/{id}",
			params: { id: "42" },
			reads: ["/v1/x/42", "/v1/x/43"],
			stale: [true, false],
			targets: ["GET /v1/x/:id"],
			title: "a :param is substituted from the params",
		},
		// v0: e9ba60ceb5
		{
			mutation: "/m/{org_id}",
			params: { org_id: "x" },
			reads: ["/v1/tenants/t1/rows"],
			stale: [true],
			targets: ["GET /v1/tenants/:tenant_id/rows"],
			title: "an unresolved :param keeps the target a pattern, never dropped",
		},
		// v0: f38504b4bf
		{
			mutation: "/m/{a}",
			params: { a: "1" },
			reads: ["/v1/x/1/5", "/v1/x/2/5"],
			stale: [true, false],
			targets: ["GET /v1/x/:a/:b"],
			title: "a partly resolved target substitutes what it can and stays a pattern for the rest",
		},
	])("$title", async ({ mutation, params, reads, stale, targets }) => {
		expect(await staleReads(mutation, params, targets, reads)).toEqual(stale)
	})
})

describe("a stale read against a pattern mark", () => {
	// v0: f3123a5717
	it("refreshes only its own path; another path under the same pattern stays stale", async () => {
		const paths = ["/v1/items/1", "/v1/items/1", "/v1/items/2"]
		expect(await staleReads("/m", undefined, ["GET /v1/items/:id"], paths)).toEqual([true, false, true])
	})
})
