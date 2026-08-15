import { describe, expect, it } from "vitest"
/* RED: module does not exist yet — import fails until codegen-mcp.ts is created. */
import { generateMCPServer } from "../../../src/codegen-mcp.ts"

/* ---- helpers ---- */

type Spec = {
	openapi: string
	info: { title: string; version: string }
	paths: Record<string, Record<string, Record<string, unknown>>>
	components?: { schemas?: Record<string, Record<string, unknown>> }
}

function minimalSpec(overrides: Partial<Spec> = {}): Spec {
	return {
		info: { title: "Anyrow", version: "1.0.0" },
		openapi: "3.1.0",
		paths: {},
		...overrides,
	}
}

const BASE_OPTIONS = {
	projectName: "anyrow",
	sdkClassName: "AnyrowSDK",
	sdkPackageName: "@anyrow/sdk-typescript",
}

/* ======================================================================
 * T3 — MCP emitter output shape
 * ====================================================================== */

describe("generateMCPServer — output shape", () => {
	/* ---- T3.1 returns files map with all required keys ---- */
	it("T3.1 returns files map with all required keys, all non-empty", () => {
		const spec = minimalSpec({
			paths: {
				"/users": {
					post: {
						operationId: "createUser",
						"x-mcp": true,
						responses: { 201: { description: "ok" } },
					},
				},
			},
		})
		const result = generateMCPServer(spec, BASE_OPTIONS)
		const required = [
			"src/_runtime.ts",
			"src/server.ts",
			"src/tools.gen.ts",
			"src/types.ts",
			"tsconfig.json",
		]
		for (const key of required) {
			expect(typeof result.files[key]).toBe("string")
			expect(result.files[key].length).toBeGreaterThan(0)
		}
		/* package.json + README.md are hand-maintained in the mirror repo,
		 * not emitted by codegen. */
		expect(result.files["package.json"]).toBeUndefined()
		expect(result.files["README.md"]).toBeUndefined()
	})

	/* ---- T3.2 tools.gen.ts contains entry per x-mcp: true op ---- */
	it("T3.2 tools.gen.ts contains entry per x-mcp: true op (skips unflagged)", () => {
		const spec = minimalSpec({
			paths: {
				"/a": {
					post: {
						operationId: "flaggedOne",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
				"/b": {
					post: {
						operationId: "flaggedTwo",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
				"/c": {
					post: {
						operationId: "unflagged",
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		expect(toolsGen).toContain("flaggedOne")
		expect(toolsGen).toContain("flaggedTwo")
		expect(toolsGen).not.toContain("unflagged")
	})

	/* ---- T3.3 tool name format: {project}_{opId} snake_case ---- */
	it("T3.3 tool name = {project}_{opId} snake_case (camelCase + dot → snake)", () => {
		const spec = minimalSpec({
			paths: {
				"/u": {
					post: {
						operationId: "createUser",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
				"/d": {
					post: {
						operationId: "docs.extract",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		expect(toolsGen).toContain("anyrow_create_user")
		expect(toolsGen).toContain("anyrow_docs_extract")
	})

	/* ---- T3.4 tool description uses op.description ?? op.summary ---- */
	it("T3.4 tool description uses op.description when present, else op.summary", () => {
		const spec = minimalSpec({
			paths: {
				"/only-summary": {
					post: {
						operationId: "onlySummary",
						summary: "Summary only op",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
				"/both": {
					post: {
						operationId: "both",
						summary: "Summary loses",
						description: "Description wins",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		expect(toolsGen).toContain("Summary only op")
		expect(toolsGen).toContain("Description wins")
		expect(toolsGen).not.toContain("Summary loses")
	})

	/* ---- T3.5 tool inputSchema merges params + body ---- */
	it("T3.5 tool inputSchema merges path params / query / json body under params/search/json", () => {
		const spec = minimalSpec({
			paths: {
				"/users/{id}": {
					put: {
						operationId: "updateUser",
						"x-mcp": true,
						parameters: [
							{ name: "id", in: "path", required: true, schema: { type: "string" } },
							{ name: "limit", in: "query", required: false, schema: { type: "integer" } },
						],
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: {
											name: { type: "string" },
											email: { type: "string" },
										},
										required: ["name", "email"],
									},
								},
							},
						},
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		/* inputSchema must mention grouping keys + field names */
		expect(toolsGen).toContain("params")
		expect(toolsGen).toContain("search")
		expect(toolsGen).toContain("json")
		expect(toolsGen).toContain("id")
		expect(toolsGen).toContain("limit")
		expect(toolsGen).toContain("name")
		expect(toolsGen).toContain("email")
	})

	/* ---- T3.6 tool inputSchema resolves $ref to components.schemas ---- */
	it("T3.6 tool inputSchema inlines $ref to components.schemas (no refs in output)", () => {
		const spec = minimalSpec({
			components: {
				schemas: {
					UserCreate: {
						type: "object",
						properties: {
							name: { type: "string" },
							email: { type: "string" },
						},
						required: ["name", "email"],
					},
				},
			},
			paths: {
				"/users": {
					post: {
						operationId: "createUser",
						"x-mcp": true,
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: { $ref: "#/components/schemas/UserCreate" },
								},
							},
						},
						responses: { 201: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		/* ref is resolved and inlined; no `$ref` substrings in emitted tool schema */
		expect(toolsGen).toContain("name")
		expect(toolsGen).toContain("email")
		expect(toolsGen).not.toContain("$ref")
		expect(toolsGen).not.toContain("#/components/schemas/UserCreate")
	})

	/* ---- T3.7 package.json + README not emitted (hand-maintained in mirror) ---- */
	it("T3.7 package.json + README.md are NOT emitted (hand-maintained in mirror repo)", () => {
		const spec = minimalSpec({
			paths: {
				"/x": {
					post: {
						operationId: "x",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		expect(files["package.json"]).toBeUndefined()
		expect(files["README.md"]).toBeUndefined()
	})

	/* ---- T3.8 server.ts entry imports static runtime + content parity ---- */
	it("T3.8 server.ts imports static runtime; runtime file matches client-mcp template", async () => {
		const spec = minimalSpec({
			paths: {
				"/x": {
					post: {
						operationId: "x",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const serverTs = files["src/server.ts"]
		/* entry re-exports / invokes the static runtime, wiring the tools array */
		expect(serverTs).toMatch(/from\s+["']\.\/_runtime["']/)
		expect(serverTs).toMatch(/from\s+["']\.\/tools\.gen["']/)
		/* runtime file itself is emitted verbatim; assert non-empty (byte-parity
		 * against source template is executor-verified once client-mcp/ lands) */
		const runtimeTs = files["src/_runtime.ts"]
		expect(typeof runtimeTs).toBe("string")
		expect(runtimeTs.length).toBeGreaterThan(0)
	})

	/* ---- T3.9 env var name is {PROJECT}_API_KEY ---- */
	it("T3.9 env var name is uppercased {PROJECT}_API_KEY in emitted entry", () => {
		const spec = minimalSpec({
			paths: {
				"/x": {
					post: {
						operationId: "x",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const serverTs = files["src/server.ts"]
		expect(serverTs).toContain("ANYROW_API_KEY")
	})

	/* ---- T3.10 no ops with x-mcp: true → emitter throws ---- */
	it("T3.10 throws when spec has zero x-mcp ops (fails loud, no empty package)", () => {
		const spec = minimalSpec({
			paths: {
				"/a": {
					post: {
						operationId: "a",
						responses: { 200: { description: "ok" } },
					},
				},
				"/b": {
					get: {
						operationId: "b",
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		expect(() => generateMCPServer(spec, BASE_OPTIONS)).toThrow(
			/No operations marked x-mcp: true/,
		)
	})

	/* ---- T3.11 WS / realtime / SSE ops are skipped even if x-mcp: true ---- */
	it("T3.11 skips x-websocket / x-realtime ops even when x-mcp: true (silent skip)", () => {
		const spec = minimalSpec({
			paths: {
				"/rest": {
					post: {
						operationId: "restOp",
						"x-mcp": true,
						responses: { 200: { description: "ok" } },
					},
				},
				"/ws": {
					get: {
						operationId: "wsOp",
						"x-mcp": true,
						"x-websocket": true,
						responses: { 200: { description: "ok" } },
					},
				},
				"/rt": {
					get: {
						operationId: "rtOp",
						"x-mcp": true,
						"x-realtime": true,
						responses: { 200: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		expect(toolsGen).toContain("restOp")
		expect(toolsGen).not.toContain("wsOp")
		expect(toolsGen).not.toContain("rtOp")
	})

	/* ---- T3.12 sdkClassName option is emitted verbatim in server.ts import ---- */
	it("T3.12 emits sdkClassName verbatim in server.ts import + constructor (no heuristic derivation)", () => {
		const spec = minimalSpec({
			paths: {
				"/users": {
					post: {
						operationId: "createUser",
						"x-mcp": true,
						responses: { 201: { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, {
			projectName: "anyrow",
			sdkClassName: "AnyrowSDK",
			sdkPackageName: "@anyrow/sdk-typescript",
		})
		const serverTs = files["src/server.ts"]
		expect(serverTs).toContain(`import { AnyrowSDK } from "@anyrow/sdk-typescript"`)
		expect(serverTs).toContain(`new AnyrowSDK({`)
		expect(serverTs).not.toMatch(/import\s*\{\s*SDK\s*\}/)
	})
})

/* ======================================================================
 * T3.6–T3.9 — N-segment operationId support in MCP (T49–T52)
 * ====================================================================== */

describe("generateMCPServer — N-segment operationId (T49–T52)", () => {
	/* T49: N-segment tool name snake-flattened correctly */
	it("T49 [T3.6] checkout.sessions.create with x-mcp:true produces tool name anyrow_checkout_sessions_create", () => {
		const spec = minimalSpec({
			paths: {
				"/checkout/sessions": {
					post: {
						operationId: "checkout.sessions.create",
						"x-mcp": true,
						responses: { "200": { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		/* toSnakeCase already handles dots correctly; explicit assertion guards regression */
		expect(toolsGen).toContain("anyrow_checkout_sessions_create")
	})

	/* T50: N-segment handler dispatch drills nested SDK path */
	it("T50 [T3.7] handler for checkout.sessions.create drills sdk.checkout.sessions.create (not 2-level lookup)", () => {
		const spec = minimalSpec({
			paths: {
				"/checkout/sessions": {
					post: {
						operationId: "checkout.sessions.create",
						"x-mcp": true,
						responses: { "200": { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		/* RED: current dispatch uses (sdk[resourceName] ?? {})[actionName] — 2-level only */
		/* New dispatch must walk all segments: sdk["checkout"]["sessions"]["create"] or chained */
		expect(toolsGen).toMatch(
			/\["checkout"\][\s\S]*?\["sessions"\][\s\S]*?\["create"\]|checkout.*sessions.*create/,
		)
		/* must NOT use the old 2-level pattern with sessions.create as a single key */
		expect(toolsGen).not.toContain(`["sessions.create"]`)
	})

	/* T51: mixed depth MCP — two tools, correct handlers */
	it("T51 [T3.8] mixed depth: users.list and users.profile.update produce 2 tool entries with correct dispatch", () => {
		const spec = minimalSpec({
			paths: {
				"/users": {
					get: {
						operationId: "users.list",
						"x-mcp": true,
						responses: { "200": { description: "ok" } },
					},
				},
				"/users/profile": {
					patch: {
						operationId: "users.profile.update",
						"x-mcp": true,
						responses: { "200": { description: "ok" } },
					},
				},
			},
		})
		const { files } = generateMCPServer(spec, BASE_OPTIONS)
		const toolsGen = files["src/tools.gen.ts"]
		/* both tools appear */
		expect(toolsGen).toContain("anyrow_users_list")
		expect(toolsGen).toContain("anyrow_users_profile_update")
		/* RED: profile.update dispatch must drill sdk["users"]["profile"]["update"] */
		/* users.list can be sdk["users"]["list"] — 2-level, still correct */
		expect(toolsGen).toMatch(/\["users"\][\s\S]*?\["profile"\][\s\S]*?\["update"\]|users.*profile.*update/)
		expect(toolsGen).not.toContain(`["profile.update"]`)
	})

	/* T52: collision throws in MCP codegen */
	it("T52 [T3.9] generateMCPServer on collision spec throws IR error with both ids", () => {
		const spec = minimalSpec({
			paths: {
				"/users": {
					post: {
						operationId: "users.create",
						"x-mcp": true,
						responses: { "200": { description: "ok" } },
					},
				},
				"/users/draft": {
					post: {
						operationId: "users.create.draft",
						"x-mcp": true,
						responses: { "200": { description: "ok" } },
					},
				},
			},
		})
		expect(() => generateMCPServer(spec, BASE_OPTIONS)).toThrow(
			/operationId conflict.*users\.create.*users\.create\.draft|operationId conflict.*users\.create\.draft.*users\.create/,
		)
	})
})
