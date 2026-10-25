/**
 * A tool call through the emitted server (bit 18 phases b and c), its process against a recording server: each argument
 * where its parameter goes (the path escaped as the SDK escapes it, the query, a header), the body as JSON or a form;
 * the API key as the API's scheme says, none sent without one, from $<PREFIX>_API_KEY; the API at $<PREFIX>_BASE_URL,
 * and with no server and none set no start at all; an answer outside 2xx the tool's own failure, isError with its
 * status and body; arguments the inputSchema rejects refused before anything is sent, each refusal naming the argument.
 * The adversarial corpus (H18.11, prototype keys, the key's redaction) is tests/security/emit-adversarial.mcp.test.ts.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { exchange, exchangeEach, initialize, request, written } from "./__fixtures__/written.ts"
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
					{ in: "query", name: "sort", schema: { enum: ["asc", "desc"], type: "string" } },
					{ in: "header", name: "X-Trace", schema: STR },
				],
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: {
									both: {
										allOf: [
											{ properties: { a: STR }, type: "object" },
											{ properties: { b: STR }, type: "object" },
										],
									},
									kind: { const: "note" },
									labels: { additionalProperties: STR, type: "object" },
									name: STR,
									note: { type: ["string", "null"] },
									pair: { items: false, prefixItems: [STR, { type: "integer" }], type: "array" },
									price: { type: "number" },
								},
								type: "object",
							},
						},
					},
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
		const ran = await exchangeEach(["env", ...env(server.url), process.execPath, join(dir, "dist", "server.js")], lines)
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
			{
				_meta: { "honey/status": 200 },
				content: [{ text: '{"id":"1"}', type: "text" }],
				structuredContent: { id: "1" },
			},
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
	it("answers an API's status outside 2xx as the tool's own failure, isError with its status and body", async () => {
		const { results } = await called(
			shop(),
			[{ arguments: { body: {}, id: "1" }, name: "items_update" }],
			[{ json: { message: "no such item" }, status: 404 }],
			(url) => [`SHOP_BASE_URL=${url}`],
		)
		const result = results[0] as { content: [{ text: string }]; isError?: true }
		const { body, status } = JSON.parse(result.content[0].text) as { body: unknown; status: number }
		expect([result.isError, status, body]).toEqual([true, 404, { message: "no such item" }])
	})
})

/** A call of `items_update` with `args` over the defaults (a path id and an empty body). */
const update = (args: Record<string, unknown>) => ({ arguments: { body: {}, id: "1", ...args }, name: "items_update" })

describe("a tool call's arguments (phase c)", SLOW, () => {
	// v0: 2472ceb3b5
	// v0: 9f544c8800
	// v0: 93048b91fd
	it("refuses arguments the inputSchema rejects, naming each, and sends nothing; conforming ones go", async () => {
		const refused = [
			[update({ id: 1 }), "id must be string"],
			[{ arguments: { id: "1" }, name: "items_update" }, "body is required"],
			[update({ extra: 1 }), "extra is not a declared property"],
			[update({ dryRun: "yes" }), "dryRun must be boolean"],
			[update({ sort: "up" }), 'sort must be one of ["asc","desc"]'],
			[update({ tags: ["x", 2] }), "tags[1] must be string"],
			[update({ body: { name: 5 } }), "body.name must be string"],
			[update({ body: { note: 5 } }), "body.note matches none of its schemas"],
			[update({ body: [] }), "body must be object"],
			[update({ body: { price: "1" } }), "body.price must be number"],
			[update({ body: { kind: "memo" } }), 'body.kind must be "note"'],
			[update({ body: { both: { a: 1 } } }), "body.both.a must be string"],
			[update({ body: { both: { b: 1 } } }), "body.both.b must be string"],
			[update({ body: { labels: { x: 1 } } }), "body.labels.x must be string"],
			[update({ body: { pair: ["a"] } }), "body.pair has too few items"],
			[update({ body: { pair: ["a", "b"] } }), "body.pair[1] must be integer"],
			[update({ body: { pair: ["a", 1, 2] } }), "body.pair[2] is past the last item"],
			[{ arguments: { body: { a: 1 } }, name: "forms_send" }, "body.a must be string"],
		] as const
		const { hops, results } = await called(
			shop(),
			[
				...refused.map(([call]) => call),
				update({
					body: {
						both: { a: "x", b: "y" },
						kind: "note",
						labels: { x: "y" },
						name: "n",
						note: null,
						pair: ["a", 1],
						price: 3,
					},
					sort: "asc",
				}),
			],
			[{ json: {}, status: 200 }],
			(url) => [`SHOP_BASE_URL=${url}`],
		)
		expect([results, hops.map((hop) => hop.url)]).toEqual([
			[
				...refused.map(([, why]) => ({
					content: [{ text: JSON.stringify({ message: `Invalid arguments: ${why}` }), type: "text" }],
					isError: true,
				})),
				{ _meta: { "honey/status": 200 }, content: [{ text: "{}", type: "text" }], structuredContent: {} },
			],
			["/items/1?sort=asc"],
		])
	})
})

describe("a server's timeout (phase d)", SLOW, () => {
	it("refuses to start on a $<PREFIX>_TIMEOUT_MS that is no whole number of milliseconds from 1 to 2147483647", async () => {
		const dir = written(generateMcpServer(shop()).files)
		const bad = ["abc", "-5", "0", "1.5", "007", "2147483648", "1e3"]
		const runs = await Promise.all(
			[...bad, "2147483647"].map((value) =>
				exchange(
					[
						"env",
						"SHOP_BASE_URL=http://127.0.0.1:9",
						`SHOP_TIMEOUT_MS=${value}`,
						process.execPath,
						join(dir, "dist", "server.js"),
					],
					[initialize("2025-11-25")],
				),
			),
		)
		const refused = "Invalid $SHOP_TIMEOUT_MS: a whole number of milliseconds, 1 to 2147483647\n"
		expect(runs.map((ran) => [ran.status, ran.stderr, ran.replies.length])).toEqual([
			...bad.map(() => [1, refused, 0]),
			[0, "", 1],
		])
	})
})

describe("a server's base URL (phase c)", SLOW, () => {
	// v0: 0f9382a357
	it("refuses to start with no base URL when the API names no server, and starts on the one set", async () => {
		const dir = written(generateMcpServer(shop()).files)
		const run = (env: string[]) =>
			exchange(
				["env", "-u", "SHOP_BASE_URL", ...env, process.execPath, join(dir, "dist", "server.js")],
				[initialize("2025-11-25")],
			)
		const [none, set] = await Promise.all([run([]), run(["SHOP_BASE_URL=http://127.0.0.1:9"])])
		expect([none.status, none.replies, none.stderr, set.status, set.replies.length]).toEqual([
			1,
			[],
			"No API to call: set $SHOP_BASE_URL, since the API names no server\n",
			0,
			1,
		])
	})
})
