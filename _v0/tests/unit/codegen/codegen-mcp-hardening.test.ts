import { transformWithOxc } from "vite"
import { describe, expect, it, vi } from "vitest"
import { callTool, validateArgs } from "../../../src/client-mcp/server.ts"
import { generateMCPServer } from "../../../src/codegen-mcp.ts"

const OPTIONS = { projectName: "anyrow", sdkClassName: "AnyrowSDK", sdkPackageName: "@anyrow/sdk-typescript" }

function spec(paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) {
	return { components: { schemas }, info: { title: "Anyrow", version: "1" }, openapi: "3.1.0", paths }
}

async function expectParses(code: string, name: string) {
	const result = await transformWithOxc(code, name, { lang: "ts" })
	expect(result.code.length).toBeGreaterThan(0)
}

describe("MCP codegen — emitted source stays well-formed", () => {
	// regression: L (codegen-mcp.ts:241,254,329)
	it("an operationId with quotes and a project name with */ do not inject code", async () => {
		const out = generateMCPServer(
			spec({ "/x": { get: { operationId: 'evil"); process.exit(1); ("', responses: {}, "x-mcp": true } } }),
			{ ...OPTIONS, projectName: "a*/b" },
		)
		const tools = out.files["src/tools.gen.ts"] ?? ""
		await expectParses(tools, "tools.gen.ts")
		await expectParses(out.files["src/server.ts"] ?? "", "server.ts")
		expect(tools).not.toMatch(/^\s*process\.exit/m)
		expect(tools).toContain("/* project: a*\\/b */")
	})

	// regression: L (codegen-mcp.ts:241,254,329)
	it("tool names are sanitized to [A-Za-z0-9_-], capped at 64, and collisions fail loudly", () => {
		const out = generateMCPServer(
			spec({
				"/a": { get: { operationId: "users.get$weird name", responses: {}, "x-mcp": true } },
				"/b": { get: { operationId: `x.${"y".repeat(100)}`, responses: {}, "x-mcp": true } },
			}),
			OPTIONS,
		)
		const names = [...(out.files["src/tools.gen.ts"] ?? "").matchAll(/^\t\t\t"([^"]+)",$/gm)].map((m) => m[1] ?? "")
		const toolNames = names.filter((n) => n.startsWith("anyrow_"))
		expect(toolNames.length).toBe(2)
		for (const n of toolNames) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/)

		expect(() =>
			generateMCPServer(
				spec({
					"/a": { get: { operationId: "usersList", responses: {}, "x-mcp": true } },
					"/b": { get: { operationId: "users_list", responses: {}, "x-mcp": true } },
				}),
				OPTIONS,
			),
		).toThrow(/both map to tool "anyrow_users_list"/)
	})

	it("a self-referential $ref terminates", () => {
		const out = generateMCPServer(
			spec(
				{
					"/n": {
						post: {
							operationId: "nodes.create",
							requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } },
							responses: {},
							"x-mcp": true,
						},
					},
				},
				{
					Node: {
						properties: { children: { items: { $ref: "#/components/schemas/Node" }, type: "array" } },
						type: "object",
					},
				},
			),
			OPTIONS,
		)
		expect(out.files["src/tools.gen.ts"]).not.toContain("$ref")
	})

	// regression: M (codegen-mcp.ts:74-87)
	it("a pure $ref cycle is an error, not a hang", () => {
		expect(() =>
			generateMCPServer(
				spec(
					{
						"/n": {
							post: {
								operationId: "a.b",
								requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } },
								responses: {},
								"x-mcp": true,
							},
						},
					},
					{ A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } },
				),
				OPTIONS,
			),
		).toThrow(/\$ref cycle/)
	})

	// regression: M (codegen-mcp.ts:74-87)
	it("shared $refs are expanded once each (no exponential blowup)", () => {
		const schemas: Record<string, unknown> = { L0: { type: "string" } }
		for (let i = 1; i <= 30; i++) {
			schemas[`L${i}`] = {
				properties: { a: { $ref: `#/components/schemas/L${i - 1}` }, b: { $ref: `#/components/schemas/L${i - 1}` } },
				type: "object",
			}
		}
		const started = Date.now()
		expect(() =>
			generateMCPServer(
				spec(
					{
						"/n": {
							post: {
								operationId: "deep.make",
								requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/L30" } } } },
								responses: {},
								"x-mcp": true,
							},
						},
					},
					schemas,
				),
				OPTIONS,
			),
		).toThrow(/exceeds/)
		expect(Date.now() - started).toBeLessThan(2000)
	})

	// regression: M (codegen-mcp.ts:267,275-281)
	it("server.ts requires an explicit base URL", () => {
		const out = generateMCPServer(
			spec({ "/x": { get: { operationId: "x.get", responses: {}, "x-mcp": true } } }),
			OPTIONS,
		)
		const server = out.files["src/server.ts"] ?? ""
		expect(server).not.toContain("https://api.anyrow.com")
		expect(server).toContain("ANYROW_BASE_URL is required")
	})

	// regression: M (codegen-mcp.ts:228-245)
	it("credential headers are never tool arguments", () => {
		const out = generateMCPServer(
			spec({
				"/x": {
					get: {
						operationId: "x.get",
						parameters: [
							{ in: "header", name: "Authorization", schema: { type: "string" } },
							{ in: "header", name: "x-trace", schema: { type: "string" } },
						],
						responses: {},
						"x-mcp": true,
					},
				},
			}),
			OPTIONS,
		)
		const tools = out.files["src/tools.gen.ts"] ?? ""
		expect(tools).not.toContain("Authorization")
		expect(tools).toContain("x-trace")
	})
})

describe("MCP runtime — callTool", () => {
	const schema = {
		properties: {
			json: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
			params: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
			search: { properties: { limit: { type: "integer" } }, type: "object" },
		},
		required: ["params"],
		type: "object",
	}
	const allowed = { json: true as const, params: ["id"], search: ["limit"] }

	function sdkWith(fn: (input: unknown) => unknown) {
		return { users: { update: vi.fn(async (input: unknown) => fn(input)) } }
	}

	it("forwards only declared keys", async () => {
		const sdk = sdkWith(() => ({ ok: true }))
		const result = await callTool(
			sdk,
			["users", "update"],
			{
				body: "raw",
				cookies: { sid: "x" },
				headers: { authorization: "Bearer stolen" },
				json: { name: "a" },
				params: { extra: "1", id: "7" },
				search: { limit: 5, other: "x" },
			},
			schema,
			allowed,
		)
		expect(result.isError).toBeUndefined()
		expect(sdk.users.update).toHaveBeenCalledWith({ json: { name: "a" }, params: { id: "7" }, search: { limit: 5 } })
	})

	it("rejects arguments that do not match the schema", async () => {
		const sdk = sdkWith(() => null)
		const result = await callTool(
			sdk,
			["users", "update"],
			{ params: { id: 7 }, search: { limit: 1.5 } },
			schema,
			allowed,
		)
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain("arguments.params.id")
		expect(sdk.users.update).not.toHaveBeenCalled()
	})

	it("rejects dot-segment path params", async () => {
		const sdk = sdkWith(() => null)
		for (const id of ["..", ".", ""]) {
			const result = await callTool(sdk, ["users", "update"], { json: { name: "a" }, params: { id } }, schema, allowed)
			expect(result.isError).toBe(true)
		}
		expect(sdk.users.update).not.toHaveBeenCalled()
	})

	it("binary results are described, not serialized as {}; large results are capped", async () => {
		const bin = await callTool(
			sdkWith(() => new ArrayBuffer(10)),
			["users", "update"],
			{ json: { name: "a" }, params: { id: "1" } },
			schema,
			allowed,
		)
		expect(bin.content[0]?.text).toContain('"bytes":10')
		const big = await callTool(
			sdkWith(() => "x".repeat(300_000)),
			["users", "update"],
			{ json: { name: "a" }, params: { id: "1" } },
			schema,
			allowed,
		)
		expect(big.content[0]?.text.length).toBeLessThan(110_000)
		expect(big.content[0]?.text).toContain("[truncated")
	})

	it("validateArgs covers type, required, enum and nested items", () => {
		const s = {
			properties: { tags: { items: { enum: ["a", "b"] }, type: "array" } },
			required: ["tags"],
			type: "object",
		}
		expect(validateArgs(s, { tags: ["a"] })).toEqual([])
		expect(validateArgs(s, {})).toEqual(["arguments.tags: required"])
		expect(validateArgs(s, { tags: ["c"] })[0]).toContain("arguments.tags[0]")
	})
})
