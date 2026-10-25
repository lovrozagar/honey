/**
 * The Go SDK's API error text (bit 19 d2, sweep item 6): `HTTP <status>: <message>`, or `HTTP <status>` without a
 * message, as the Python, C#, Java and TS SDKs read; no reason phrase, which no target can spell alike (Java's client
 * has none, and Python's drifts between interpreter versions).
 */
import { describe, expect, it } from "vitest"
import { check, seen } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const MODULE = "example.com/errtext"

/** One GET of an item by id, answering it as JSON. */
const DOCUMENT = {
	info: { title: "Text", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
}

describe.skipIf(!GO)("the Go SDK's API error text (bit 19 d2)", () => {
	it("reads HTTP <status>: <message>, HTTP <status> without one, and no reason phrase for any status", () => {
		const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
		const run = check(
			files,
			MODULE,
			`	api := client("http://api.test")
	replies["GET /items/a"] = reply{status: 404, body: \`{"message":"x"}\`}
	replies["GET /items/b"] = reply{status: 404, body: \`\`}
	replies["GET /items/c"] = reply{status: 418, body: \`{"message":"m"}\`}
	for _, id := range []string{"a", "b", "c"} {
		_, err := api.Items.Get(ctx, id, nil)
		note(err.Error())
	}`,
			[],
		)
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: [
				"GET http://api.test/items/a",
				"HTTP 404: x",
				"GET http://api.test/items/b",
				"HTTP 404",
				"GET http://api.test/items/c",
				"HTTP 418: m",
			],
			vet: [],
		})
	}, 600_000)
})
