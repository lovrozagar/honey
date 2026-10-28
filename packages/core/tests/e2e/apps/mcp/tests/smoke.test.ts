import { describe, expect, test } from "bun:test"
import { compareApps, probesFromTree } from "../../../differential.ts"
import { routeTree } from "../src/_gen/routes.gen.ts"
import { createApp, KEY } from "../src/app.ts"

const app = createApp()
const CSV = new TextEncoder().encode("name,qty\nbolt,4\n")

/** A 2025-11-25 JSON-RPC request to the mounted endpoint, `headers` beside a conforming client's. */
const rpc = (method: string, params: object, headers: Record<string, string> = {}) =>
	app.fetch(
		new Request("http://honey.test/api/mcp", {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": "2025-11-25",
				...headers,
			},
			method: "POST",
		}),
		{},
	)

const sha = async (bytes: Uint8Array) =>
	[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")

describe("e2e mcp mounts the app's own tools", () => {
	test("refuses tools/list without an ApiKey credential, 401 naming the scheme", async () => {
		const res = await rpc("tools/list", {})
		expect([res.status, res.headers.get("www-authenticate")]).toEqual([401, "ApiKey"])
	})

	test("lists the five operations and sends an inline file intact under the caller's key", async () => {
		const listed = (await (await rpc("tools/list", {}, { authorization: `ApiKey ${KEY}` })).json()) as {
			result: { tools: { name: string }[] }
		}
		const file = {
			data: Buffer.from(CSV).toString("base64"),
			digest: {
				algorithm: "sha-256",
				value: Buffer.from(await crypto.subtle.digest("SHA-256", CSV)).toString("base64url"),
			},
			id: "rows.csv",
			mimeType: "text/csv",
			name: "rows.csv",
			size: CSV.length,
		}
		const args = { file, project_id: "p1", text: "a hint" }
		const called = (await (
			await rpc("tools/call", { arguments: args, name: "suggest_schema" }, { authorization: `ApiKey ${KEY}` })
		).json()) as { result: { structuredContent: unknown } }
		expect([listed.result.tools.map((tool) => tool.name), called.result.structuredContent]).toEqual([
			["extract_once", "extract_stream", "suggest_schema", "extract_table_once", "extract_table_stream"],
			{
				files: [{ file_name: "rows.csv", sha256: await sha(CSV), size: CSV.length }],
				status: "complete",
				texts: { text: "a hint" },
			},
		])
	})

	test("answers 401 with the inner route's challenge when it rejects the key", async () => {
		const args = { project_id: "p1", text: "t" }
		const res = await rpc("tools/call", { arguments: args, name: "suggest_schema" }, { authorization: "ApiKey wrong" })
		expect([res.status, res.headers.get("www-authenticate")]).toEqual([401, 'ApiKey realm="honey-e2e"'])
	})
})

describe("serves identically from its generated route tree", () => {
	test("boots with .routeTree() and answers every probe like the runtime trie", async () => {
		const probes = probesFromTree(routeTree, (p) => p)
		expect(probes.length).toBeGreaterThan(3)
		expect(await compareApps(createApp(), createApp(undefined, { routeTree }), probes)).toEqual([])
	})
})
