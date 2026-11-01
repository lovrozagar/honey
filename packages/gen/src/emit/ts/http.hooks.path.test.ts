/**
 * A hook's `ctx.path` is the operation's path template as the document spells it (`/items/{id}`), never the
 * URL the call filled in (`/items/7`). That is what lets a hook key a table by operation — a read-your-writes
 * map, a per-route budget — instead of parsing an id back out. `onLog`'s `operation` is `METHOD` and the same
 * path, so one spelling serves both. 0.7.3 handed honey's own colon form (`/items/:id`), which a document
 * never carries, and a client generated from a third party's document had no such form at all.
 */
import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Items = Record<"get", (input: Json) => Promise<unknown>>

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

/** The emitted SDK for one templated operation, `items.get` at `GET /items/{id}`. */
async function itemsSdk(config: Json): Promise<{ calls: Request[]; items: Items }> {
	const document = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/items/{id}": {
				get: {
					operationId: "items.get",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					responses: OK,
				},
			},
		},
	}
	const { TestSDK } = (await emittedSdk(document)) as unknown as { TestSDK: new (c: Json) => { items: Items } }
	const { calls, fetch } = recordingFetch()
	const sdk = new TestSDK({ baseURL: "https://api.test.com", fetch, ...config })
	return { calls, items: sdk.items }
}

describe("a hook's ctx.path", () => {
	it("is the path template, while the request it sends carries the filled URL", async () => {
		const seen: Array<{ method: string; path: string; url: string }> = []
		const { calls, items } = await itemsSdk({
			onRequest: [
				(ctx: { method: string; path: string; url: string }) =>
					void seen.push({ method: ctx.method, path: ctx.path, url: ctx.url }),
			],
		})
		await items.get({ params: { id: "7" } })
		expect(seen).toEqual([{ method: "GET", path: "/items/{id}", url: "https://api.test.com/items/7" }])
		expect(calls[0]?.url).toBe("https://api.test.com/items/7")
	})

	it("is the same template on the way back", async () => {
		const seen: string[] = []
		const { items } = await itemsSdk({
			onResponse: [(ctx: { path: string }) => void seen.push(ctx.path)],
		})
		await items.get({ params: { id: "7" } })
		expect(seen).toEqual(["/items/{id}"])
	})

	it("names the operation onLog reports, so a table keyed by either agrees", async () => {
		const operations: string[] = []
		const paths: string[] = []
		const { items } = await itemsSdk({
			onLog: (entry: { operation: string }) => void operations.push(entry.operation),
			onRequest: [(ctx: { path: string }) => void paths.push(ctx.path)],
		})
		await items.get({ params: { id: "7" } })
		expect(new Set(operations)).toEqual(new Set(["GET /items/{id}"]))
		expect(paths).toEqual(["/items/{id}"])
	})
})
