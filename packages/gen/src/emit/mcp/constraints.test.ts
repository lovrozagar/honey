/**
 * A tool's arguments held to the spec's constraint keywords (bit 19 c, carry-in #10): the IR carries minLength,
 * maxLength, pattern, minimum, maximum, exclusiveMinimum, exclusiveMaximum, minItems and maxItems, the inputSchema
 * states them, and the server's guard refuses an argument past any of them, naming it, before anything is sent. A
 * string's length counts code points, as JSON Schema does. `pattern` is stated but never run (a spec regex run on
 * agent input is a ReDoS surface, and the API validates it), so an argument against it is sent.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { exchangeEach, initialize, request, written } from "./__fixtures__/written.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 120_000 }

/** One POST whose query, header and body arguments carry every constraint keyword. */
const DOCUMENT = {
	info: { title: "Notes", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/notes": {
			post: {
				operationId: "notes.create",
				parameters: [
					{ in: "query", name: "limit", required: true, schema: { maximum: 100, minimum: 1, type: "integer" } },
					{
						in: "query",
						name: "ratio",
						required: true,
						schema: { exclusiveMaximum: 1, exclusiveMinimum: 0, type: "number" },
					},
				],
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: {
									tags: { items: { type: "string" }, maxItems: 2, minItems: 1, type: "array" },
									title: { maxLength: 5, minLength: 2, pattern: "^[a-z]+$", type: "string" },
								},
								required: ["tags", "title"],
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
				"x-mcp": true,
			},
		},
	},
}

/** A call of `notes_create` with `changes` over arguments that meet every constraint. */
const create = (changes: Record<string, unknown>, body: Record<string, unknown> = {}) => ({
	arguments: { body: { tags: ["a"], title: "ok", ...body }, limit: 1, ratio: 0.5, ...changes },
	name: "notes_create",
})

describe("a tool's arguments held to the spec's constraint keywords (bit 19 c)", SLOW, () => {
	it("states each keyword in the inputSchema, refuses an argument past one by name with nothing sent, and never runs a pattern", async () => {
		const refused = [
			[create({ limit: 0 }), "limit must be at least 1"],
			[create({ limit: 101 }), "limit must be at most 100"],
			[create({ ratio: 0 }), "ratio must be more than 0"],
			[create({ ratio: 1 }), "ratio must be less than 1"],
			[create({}, { title: "a" }), "body.title is too short"],
			[create({}, { title: "abcdef" }), "body.title is too long"],
			[create({}, { tags: [] }), "body.tags has too few items"],
			[create({}, { tags: ["a", "b", "c"] }), "body.tags has too many items"],
		] as const
		/* three code points in six UTF-16 units: within maxLength 5; and a title against the pattern, sent as it is */
		const sent = [create({}, { title: "\u{1F600}\u{1F600}\u{1F600}" }), create({ limit: 100 }, { title: "UP" })]
		const dir = written(generateMcpServer(DOCUMENT).files)
		const { hops, listed, results } = await served([{ json: {}, status: 200 }], async (server) => {
			const calls = [...refused.map(([call]) => call), ...sent]
			const lines = [
				initialize("2025-11-25"),
				request(1, "tools/list"),
				...calls.map((call, i) => request(i + 2, "tools/call", call)),
			]
			const command = ["env", `NOTES_BASE_URL=${server.url}`, process.execPath, join(dir, "dist", "server.js")]
			const ran = await exchangeEach(command, lines)
			const replies = ran.replies.slice(1).map((reply) => (reply as { result: Record<string, unknown> }).result)
			return { hops: [...server.hops], listed: replies[0], results: replies.slice(1) }
		})
		const schema = (listed as { tools: [{ inputSchema: { properties: Record<string, unknown> } }] }).tools[0]
			.inputSchema
		expect([
			schema.properties,
			results.slice(0, refused.length).map((result) => (result.content as [{ text: string }])[0].text),
			results.slice(refused.length).map((result) => result.isError ?? false),
			hops.length,
		]).toEqual([
			{
				body: {
					properties: {
						tags: { items: { type: "string" }, maxItems: 2, minItems: 1, type: "array" },
						title: { maxLength: 5, minLength: 2, pattern: "^[a-z]+$", type: "string" },
					},
					required: ["tags", "title"],
					type: "object",
				},
				limit: { maximum: 100, minimum: 1, type: "integer" },
				ratio: { exclusiveMaximum: 1, exclusiveMinimum: 0, type: "number" },
			},
			refused.map(([, why]) => JSON.stringify({ message: `Invalid arguments: ${why}` })),
			[false, false],
			sent.length,
		])
	})
})
