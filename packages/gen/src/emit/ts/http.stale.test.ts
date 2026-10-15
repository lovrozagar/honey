import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, any>
type Ctx = Record<string, any>
type Seen = { invalidatedBy?: string[]; isStale?: boolean; method: string; selector?: string }

const BASE = "https://api.test"
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "" } }
const BODY = { content: { "application/json": { schema: {} } } }
const T0 = Date.UTC(2026, 0, 1)

/** An OpenAPI 3.1 document of `paths`; each operation answers JSON and declares its `{name}` path parameters. */
function doc(paths: Record<string, Record<string, Json>>): Json {
	const filled = Object.entries(paths).map(([path, ops]) => {
		const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
			in: "path",
			name,
			required: true,
			schema: { type: "string" },
		}))
		return [
			path,
			Object.fromEntries(Object.entries(ops).map(([verb, op]) => [verb, { parameters, responses: OK, ...op }])),
		]
	})
	return { info: { title: "T", version: "1" }, openapi: "3.1.0", paths: Object.fromEntries(filled) }
}

/** A mutation `operationId` with a JSON body that invalidates `targets`. */
const mutation = (operationId: string, targets: string[]) => ({
	operationId,
	requestBody: BODY,
	"x-invalidate": targets,
})

const RESOURCES = doc({
	"/v1/feed": { get: { operationId: "feed.get" } },
	"/v1/a": { post: mutation("feed.a", ["GET /v1/feed"]) },
	"/v1/b": { post: mutation("feed.b", ["GET /v1/feed"]) },
	"/v1/c": { post: mutation("feed.c", ["GET /v1/feed"]) },
	"/v1/posts/{id}": { get: { operationId: "posts.get" }, patch: mutation("posts.update", ["GET /v1/posts/:id"]) },
	"/v1/users": {
		get: { operationId: "users.list" },
		post: mutation("users.create", ["GET /v1/users", "GET /v1/users/:id"]),
	},
	"/v1/users/{id}": {
		delete: { operationId: "users.remove" },
		get: { operationId: "users.get" },
		patch: mutation("users.update", ["GET /v1/users/:id"]),
	},
	"/v1/users/{id}/archive": { post: mutation("users.archive", ["DELETE /v1/users/:id"]) },
})

/** A `TestSDK` over RESOURCES with stale tracking on, recording each request's stale view in `seen`. */
async function staleSdk(fetch: typeof globalThis.fetch, invalidation: Json = {}): Promise<{ sdk: any; seen: Seen[] }> {
	const seen: Seen[] = []
	const { TestSDK } = await emittedSdk(RESOURCES)
	const onRequest = [
		({ invalidatedBy, isStale, method, selector }: Ctx) => void seen.push({ invalidatedBy, isStale, method, selector }),
	]
	const config = { baseURL: BASE, fetch, invalidation: { staleTime: 60_000, ...invalidation }, onRequest }
	return { sdk: new (TestSDK as new (config: Json) => unknown)(config), seen }
}

/** A fetch whose answers wait for `release(i)`; `sent(n)` waits until n requests went out. */
function deferredFetch() {
	const pending: Array<(response: Response) => void> = []
	const { fetch } = recordingFetch(() => new Promise<Response>((resolve) => pending.push(resolve)))
	const sent = async (n: number) => {
		while (pending.length < n) await new Promise((resolve) => setTimeout(resolve, 0))
	}
	return { fetch, release: (i: number) => pending[i]?.(Response.json({})), sent }
}

/** The isStale each GET in `seen` saw, in order. */
const getsStale = (seen: Seen[]) => seen.filter((ctx) => ctx.method === "GET").map((ctx) => ctx.isStale === true)

afterEach(() => {
	vi.useRealTimers()
})

describe("stale marks across sequential calls", () => {
	// v0: 1240da6d29
	it("a read, then a mutation: only the read after the mutation is stale", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.get({ params: { id: "1" } })
		await sdk.users.update({ json: { name: "Alice" }, params: { id: "1" } })
		await sdk.users.get({ params: { id: "1" } })
		expect(getsStale(seen)).toEqual([false, true])
	})

	// v0: b6af16a158
	it("the GET after a PATCH that invalidates it is stale", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.update({ json: {}, params: { id: "2" } })
		await sdk.users.get({ params: { id: "2" } })
		expect(getsStale(seen)).toEqual([true])
	})

	// v0: 7f2e37104b
	it("a POST invalidating GET /v1/users marks the list stale for the next list call", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.create({ json: { email: "b@c.com" } })
		await sdk.users.list()
		expect(getsStale(seen)).toEqual([true])
	})

	// v0: 660c7536bd
	it("the onRequest ctx carries isStale, the invalidating mutations and the concrete selector", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.update({ json: {}, params: { id: "1" } })
		await sdk.users.get({ params: { id: "1" } })
		expect(seen[1]).toEqual({
			invalidatedBy: ["PATCH /v1/users/1"],
			isStale: true,
			method: "GET",
			selector: "GET /v1/users/1",
		})
	})
})

describe("stale marks cleared and kept apart", () => {
	// v0: 6e050970dd
	it("a stale read clears its mark, so the read after it is fresh", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.update({ json: {}, params: { id: "3" } })
		await sdk.users.get({ params: { id: "3" } })
		await sdk.users.get({ params: { id: "3" } })
		expect(getsStale(seen)).toEqual([true, false])
	})

	// v0: bd83477c9a
	it("mutations on different resources each mark only their own resource", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.update({ json: {}, params: { id: "1" } })
		await sdk.posts.update({ json: {}, params: { id: "1" } })
		await sdk.users.get({ params: { id: "1" } })
		await sdk.posts.get({ params: { id: "1" } })
		expect(seen.slice(2).map((ctx) => ctx.invalidatedBy)).toEqual([["PATCH /v1/users/1"], ["PATCH /v1/posts/1"]])
	})

	// v0: 4467ff0b60
	it("after five mutations, a read of the first and of the last target is stale, naming its mutation", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		for (const id of ["0", "1", "2", "3", "4"]) await sdk.users.update({ json: {}, params: { id } })
		await sdk.users.get({ params: { id: "0" } })
		await sdk.users.get({ params: { id: "4" } })
		expect(seen.slice(5).map((ctx) => [ctx.isStale, ctx.invalidatedBy])).toEqual([
			[true, ["PATCH /v1/users/0"]],
			[true, ["PATCH /v1/users/4"]],
		])
	})

	// v0: 6485294e4d
	it("a 2xx mutation whose body fails to parse still marks its targets stale", async () => {
		const { fetch } = recordingFetch((request) =>
			request.method === "PATCH"
				? new Response("{not valid json", { headers: { "content-type": "application/json" } })
				: Response.json({}),
		)
		const { sdk, seen } = await staleSdk(fetch)
		const patched = await sdk.users.update({ json: {}, params: { id: "1" } })
		await sdk.users.get({ params: { id: "1" } })
		expect([patched.status, patched.data, Boolean(patched.error), getsStale(seen)]).toEqual([200, null, true, [true]])
	})

	// v0: 80774fb17b
	it("a mark for another method on the same path leaves this method's read fresh", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.archive({ json: {}, params: { id: "1" } })
		await sdk.users.get({ params: { id: "1" } })
		await sdk.users.remove({ params: { id: "1" } })
		expect(seen.slice(1).map((ctx) => [ctx.method, ctx.isStale === true])).toEqual([
			["GET", false],
			["DELETE", true],
		])
	})
})

describe("stale marks across interleaved calls", () => {
	// v0: 0faac62d4a
	// v0: ea9b7c2ff8
	it("a read sent before a mutation is fresh, and finishing after it leaves the mutation's mark for the next read", async () => {
		const { fetch, release, sent } = deferredFetch()
		const { sdk, seen } = await staleSdk(fetch)
		const read = sdk.users.get({ params: { id: "7" } })
		await sent(1)
		const write = sdk.users.update({ json: {}, params: { id: "7" } })
		await sent(2)
		release(1)
		await write
		release(0)
		await read
		const next = sdk.users.get({ params: { id: "7" } })
		await sent(3)
		release(2)
		await next
		expect(getsStale(seen)).toEqual([false, true])
	})

	// v0: e1786bbb53
	it("a stale read sent before a newer mutation never clears that mutation's mark", async () => {
		const { fetch, release, sent } = deferredFetch()
		const { sdk, seen } = await staleSdk(fetch)
		const first = sdk.users.update({ json: {}, params: { id: "6" } })
		await sent(1)
		release(0)
		await first
		const read = sdk.users.get({ params: { id: "6" } })
		await sent(2)
		const second = sdk.users.update({ json: {}, params: { id: "6" } })
		await sent(3)
		release(2)
		await second
		release(1)
		await read
		const next = sdk.users.get({ params: { id: "6" } })
		await sent(4)
		release(3)
		await next
		expect(seen.filter((ctx) => ctx.method === "GET").map((ctx) => [ctx.isStale, ctx.invalidatedBy])).toEqual([
			[true, ["PATCH /v1/users/6"]],
			[true, ["PATCH /v1/users/6"]],
		])
	})
})

describe("stale mark lifetime", () => {
	// v0: 024ded11f0
	// v0: a40289b351
	it("a mark expires after staleTime: reads past it are fresh", async () => {
		vi.useFakeTimers({ now: T0, toFake: ["Date"] })
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		const ids = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
		for (const id of ids) await sdk.users.update({ json: {}, params: { id } })
		vi.setSystemTime(T0 + 59_999)
		await sdk.users.get({ params: { id: "10" } })
		vi.setSystemTime(T0 + 60_000)
		for (const id of ids.slice(0, 10)) await sdk.users.get({ params: { id } })
		expect(getsStale(seen)).toEqual([true, ...ids.slice(0, 10).map(() => false)])
	})

	// v0: ef7a387d44
	it("sweeping an expired mark keeps a live mark's sources and expiry", async () => {
		vi.useFakeTimers({ now: T0, toFake: ["Date"] })
		const { sdk, seen } = await staleSdk(recordingFetch().fetch)
		await sdk.users.update({ json: {}, params: { id: "old" } })
		vi.setSystemTime(T0 + 30_000)
		await sdk.users.update({ json: {}, params: { id: "new" } })
		vi.setSystemTime(T0 + 60_000)
		await sdk.users.get({ params: { id: "other" } })
		await sdk.users.get({ params: { id: "old" } })
		vi.setSystemTime(T0 + 89_999)
		await sdk.users.get({ params: { id: "new" } })
		expect(seen.slice(2).map((ctx) => [ctx.isStale === true, ctx.invalidatedBy ?? []])).toEqual([
			[false, []],
			[false, []],
			[true, ["PATCH /v1/users/new"]],
		])
	})
})

describe("stale mark bounds", () => {
	// v0: c06c2bfe35
	it("staleMaxEntries bounds the marks: past it the oldest mark is dropped", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch, { staleMaxEntries: 2 })
		for (const id of ["1", "2", "3"]) await sdk.users.update({ json: {}, params: { id } })
		for (const id of ["1", "2", "3"]) await sdk.users.get({ params: { id } })
		expect(getsStale(seen)).toEqual([false, true, true])
	})

	// v0: f6fdef6f18
	it("past staleMaxEntries a new mark sweeps expired marks before dropping a live one", async () => {
		vi.useFakeTimers({ now: T0, toFake: ["Date"] })
		const { sdk, seen } = await staleSdk(recordingFetch().fetch, { staleMaxEntries: 2 })
		await sdk.users.update({ json: {}, params: { id: "a" } })
		await sdk.users.update({ json: {}, params: { id: "b" } })
		vi.setSystemTime(T0 + 50_000)
		await sdk.users.update({ json: {}, params: { id: "a" } })
		vi.setSystemTime(T0 + 70_000)
		await sdk.users.update({ json: {}, params: { id: "c" } })
		for (const id of ["a", "c"]) await sdk.users.get({ params: { id } })
		expect(getsStale(seen)).toEqual([true, true])
	})

	// v0: 7731ace5a8
	it("maxSourcesPerTarget keeps only the latest mutations in invalidatedBy", async () => {
		const { sdk, seen } = await staleSdk(recordingFetch().fetch, { maxSourcesPerTarget: 2 })
		await sdk.feed.a({ json: {} })
		await sdk.feed.b({ json: {} })
		await sdk.feed.c({ json: {} })
		await sdk.feed.get()
		expect(seen[3]?.invalidatedBy).toEqual(["POST /v1/b", "POST /v1/c"])
	})
})
