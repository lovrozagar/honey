/**
 * A tool call through the emitted server (bit 18 phase b), its process against a recording server: each argument where
 * its parameter goes (the path escaped as the SDK escapes it, the query, a header), the body as JSON or a form; the API
 * key as the API's scheme says, none sent without one, from $<PREFIX>_API_KEY; the API at $<PREFIX>_BASE_URL; an answer
 * outside 2xx the tool's own failure, isError with its status.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { exchange, initialize, request, written } from "./__fixtures__/written.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 120_000 }
const STR = { type: "string" }
const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

/** The shop document: `items.update` with every kind of parameter and a JSON body, `forms.send` a urlencoded form. */
const shop = (security: Record<string, unknown> = {}) => ({
	info: { title: "Shop", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/forms": {
			post: {
				operationId: "forms.send",
				requestBody: {
					content: {
						"application/x-www-form-urlencoded": { schema: { properties: { a: STR, b: STR }, type: "object" } },
					},
				},
				responses: OK,
				"x-mcp": true,
			},
		},
		"/items/{id}": {
			put: {
				operationId: "items.update",
				parameters: [
					{ in: "path", name: "id", required: true, schema: STR },
					{ in: "query", name: "dryRun", schema: { type: "boolean" } },
					{ in: "query", name: "tags", schema: { items: STR, type: "array" } },
					{ in: "header", name: "X-Trace", schema: STR },
				],
				requestBody: {
					content: { "application/json": { schema: { properties: { name: STR }, type: "object" } } },
					required: true,
				},
				responses: OK,
				"x-mcp": true,
			},
		},
	},
	...security,
})

/** The server for `document` run against a recording server answering `replies`, with `env`: its replies and the hops. */
async function called(
	document: Record<string, unknown>,
	calls: readonly object[],
	replies: readonly Reply[],
	env: (url: string) => string[],
) {
	const dir = written(generateMcpServer(document).files)
	return served(replies, async (server) => {
		const lines = [initialize("2025-11-25"), ...calls.map((call, i) => request(i + 1, "tools/call", call))]
		const ran = await exchange(["env", ...env(server.url), process.execPath, join(dir, "dist", "server.js")], lines)
		return { hops: server.hops, results: ran.replies.slice(1).map((reply) => (reply as { result: unknown }).result) }
	})
}

describe("a tool call's wire (phase b)", SLOW, () => {
	it("sends each argument where its parameter goes, the body as JSON, a form as a form", async () => {
		const { hops, results } = await called(
			shop(),
			[
				{
					arguments: { body: { name: "n" }, dryRun: true, id: "a b", tags: ["x", "y"], "X-Trace": "t" },
					name: "items_update",
				},
				{ arguments: { body: { a: "1", b: "two words" } }, name: "forms_send" },
			],
			[
				{ json: { id: "1" }, status: 200 },
				{ json: {}, status: 200 },
			],
			(url) => [`SHOP_BASE_URL=${url}`],
		)
		expect([
			hops.map((hop) => [hop.method, hop.url, hop.headers["x-trace"], hop.body.contentType, hop.body.json]),
			results[0],
		]).toEqual([
			[
				["PUT", "/items/a%20b?dryRun=true&tags=x&tags=y", "t", "application/json", { name: "n" }],
				["POST", "/forms", undefined, "application/x-www-form-urlencoded", undefined],
			],
			{ content: [{ text: '{"id":"1"}', type: "text" }] },
		])
	})

	it("sends the API key as the API's scheme says, and none without one", async () => {
		const apiKey = {
			components: { securitySchemes: { key: { in: "header", name: "X-API-Key", type: "apiKey" } } },
			security: [{ key: [] }],
		}
		const call = { arguments: { body: {}, id: "1" }, name: "items_update" }
		const answer: Reply = { json: {}, status: 200 }
		const runs = await Promise.all([
			called(shop(apiKey), [call], [answer], (url) => [`SHOP_BASE_URL=${url}`, "SHOP_API_KEY=k1"]),
			called(shop(), [call], [answer], (url) => [`SHOP_BASE_URL=${url}`, "SHOP_API_KEY=k2"]),
			called(shop(), [call], [answer], (url) => [`SHOP_BASE_URL=${url}`]),
		])
		expect(runs.map(({ hops }) => [hops[0]?.headers["x-api-key"], hops[0]?.headers.authorization])).toEqual([
			["k1", undefined],
			[undefined, "Bearer k2"],
			[undefined, undefined],
		])
	})
})

describe("a tool call's failure (phase b)", SLOW, () => {
	it("answers an API's status outside 2xx as the tool's own failure, isError with its status", async () => {
		const { results } = await called(
			shop(),
			[{ arguments: { body: {}, id: "1" }, name: "items_update" }],
			[{ json: { message: "no such item" }, status: 404 }],
			(url) => [`SHOP_BASE_URL=${url}`],
		)
		const result = results[0] as { content: [{ text: string }]; isError?: true }
		expect([result.isError, (JSON.parse(result.content[0].text) as { status: number }).status]).toEqual([true, 404])
	})
})
