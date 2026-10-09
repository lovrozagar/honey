/* Every emitter reads the IR, never the raw document: what the IR carries is what the SDKs see. */
import { describe, expect, it } from "vitest"
import { generateSDK, sdkIR, sdkMemberPaths, serviceMapOf } from "../../../src/codegen.ts"
import type { OpenApiSpecInput } from "../../../src/codegen.ts"
import { generateGoCLI } from "../../../src/codegen-go-cli.ts"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { bodiesOf, irErrorEnvelope, irResolver, toIR } from "../../../src/codegen-ir.ts"
import { generateMCPServer } from "../../../src/codegen-mcp.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"

const spec = (paths: Record<string, unknown>, components: Record<string, unknown> = {}): OpenApiSpecInput =>
	({ components, info: { description: "Shop API", title: "Shop", version: "1" }, openapi: "3.1.0", paths }) as never

const ok = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

const envelope = (status: number, keys: string[]) => ({
	properties: {
		error_key: { enum: keys, type: "string" },
		fields: {
			additionalProperties: { items: { $ref: "#/components/schemas/ErrField" }, type: "array" },
			type: "object",
		},
		message: { type: "string" },
		status: { enum: [status], type: "integer" },
		status_key: { type: "string" },
		success: { const: false },
	},
	required: ["success", "error_key", "message", "status", "status_key", "fields"],
	type: "object",
})

const errField = {
	properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } },
	type: "object",
}

describe("IR carries what emitters used to read off the document", () => {
	it("cookie params, wildcard flags, defaults, every body content type", () => {
		const ir = toIR(
			spec({
				"/files/{rest}": {
					parameters: [
						{ in: "path", name: "rest", required: true, schema: { type: "string" }, "x-honey-wildcard": true },
					],
					post: {
						operationId: "upload",
						parameters: [
							{ in: "cookie", name: "sid", required: true, schema: { type: "string" } },
							{ in: "query", name: "limit", schema: { default: 20, type: "integer" } },
						],
						requestBody: {
							content: {
								"application/octet-stream": { schema: { format: "binary", type: "string" } },
								"application/json": { schema: { type: "object" } },
							},
							required: true,
						},
						responses: ok,
					},
				},
			}),
		)
		const op = ir.operations[0]
		expect(op.params.cookie?.map((p) => p.name)).toEqual(["sid"])
		expect(op.params.path[0]?.wildcard).toBe(true)
		expect(op.params.query[0]?.default).toBe(20)
		expect(bodiesOf(op).map((b) => b.contentType)).toEqual(["application/json", "application/octet-stream"])
		expect(op.body?.contentType).toBe("application/json")
	})

	it("auth, info and component descriptions", () => {
		const ir = toIR({
			...spec(
				{},
				{
					schemas: { User: { description: "A shop user", type: "object" } },
					securitySchemes: { key: { in: "header", name: "X-Api-Key", type: "apiKey" } },
				},
			),
		})
		expect(ir.auth).toEqual({ headerName: "X-Api-Key", prefix: "" })
		expect(ir.info).toEqual({ description: "Shop API", title: "Shop", version: "1" })
		expect(ir.schemaDescriptions).toEqual({ User: "A shop user" })
	})

	it("reads the standard error envelope through refs", () => {
		const ir = toIR(spec({}, { schemas: { E404: envelope(404, ["not_found"]), ErrField: errField } }))
		expect(irErrorEnvelope({ kind: "ref", name: "E404" }, irResolver(ir.schemas))).toEqual({
			keys: ["not_found"],
			status: 404,
		})
		expect(irErrorEnvelope({ fields: [], kind: "object" }, irResolver(ir.schemas))).toBeNull()
	})
})

describe("TypeScript SDK from the IR", () => {
	it("types path-item params, XML as text and +json bodies", () => {
		const out = generateSDK(
			spec({
				"/orgs/{org}/feed": {
					get: {
						operationId: "feed.get",
						responses: {
							200: { content: { "application/xml": { schema: { type: "string" } } }, description: "ok" },
						},
					},
					parameters: [{ in: "path", name: "org", required: true, schema: { type: "integer" } }],
				},
				"/problems": {
					get: {
						operationId: "problems.list",
						responses: {
							200: {
								content: {
									"application/problem+json": {
										schema: { properties: { title: { type: "string" } }, type: "object" },
									},
								},
								description: "ok",
							},
						},
					},
				},
			}),
		)
		/* a path-item param reaches the input type with its schema */
		expect(out.files.types).toContain("params: { org: number }")
		/* the runtime parses XML as text, and the type says so */
		expect(out.files.types).toMatch(/"get"\(input: .*Promise<string>/)
		expect(out.files.client).toContain('ct === "application/xml" || ct.endsWith("+xml")')
		/* a +json body is JSON, typed from its schema */
		expect(out.files.types).toContain("{ title?: string }")
	})

	it("one IR feeds the service map and the member paths", () => {
		const ir = sdkIR(
			spec({
				"/state": { get: { operationId: "state.get", responses: ok } },
				"/users/{id}": { get: { responses: ok } },
			}),
		)
		const map = serviceMapOf(ir)
		expect(Object.keys(map).sort()).toEqual(["getUsersById", "state"])
		/* `state` shadows the client's own `state` member, so the method lives under `state_` */
		expect(sdkMemberPaths(ir).get("state.get")).toEqual(["state_", "get"])
		expect(sdkMemberPaths(ir).get("getUsersById")).toEqual(["getUsersById"])
	})
})

describe("MCP tools follow the TypeScript SDK", () => {
	it("derived ids, renamed members and path-item params", () => {
		const doc = spec({
			"/orgs/{org}/members": {
				get: { responses: ok, "x-mcp": true },
				parameters: [{ in: "path", name: "org", required: true, schema: { minLength: 2, type: "string" } }],
			},
			"/state": { get: { operationId: "state.get", responses: ok, "x-mcp": true } },
		})
		const tools = generateMCPServer(doc, {
			projectName: "shop",
			sdkClassName: "ShopSDK",
			sdkPackageName: "@shop/sdk",
		}).files["src/tools.gen.ts"]
		/* no operationId: the SDK derives one, and so does the tool */
		expect(tools).toContain('"shop_get_orgs_members_by_org"')
		expect(tools).toContain('["getOrgsMembersByOrg"]')
		/* the path-item param is a required tool argument, its JSON Schema intact */
		expect(tools).toContain('"org":{"minLength":2,"type":"string"}')
		/* the tool walks the renamed member the SDK actually has */
		expect(tools).toContain('["state_","get"]')
	})
})

describe("Go, Rust and the Go CLI read only the IR", () => {
	it("auth, docs, flag defaults and error envelopes", () => {
		const doc = spec(
			{
				"/items": {
					get: {
						operationId: "items.list",
						parameters: [{ in: "query", name: "limit", schema: { default: 25, type: "integer" } }],
						responses: {
							...ok,
							404: {
								content: { "application/json": { schema: { $ref: "#/components/schemas/E404" } } },
								description: "missing",
							},
						},
					},
				},
			},
			{
				schemas: { E404: envelope(404, ["item_missing"]), ErrField: errField },
				securitySchemes: { basic: { scheme: "basic", type: "http" } },
			},
		)
		const go = generateGoSDK(doc as never).files
		expect(go["doc.go"]).toContain("Package sdk is an auto-generated client for Shop. Shop API")
		expect(go["client.go"]).toContain('"Basic "')

		const cli = generateGoCLI(doc as never, { binaryName: "shop" }).files
		expect(Object.values(cli).join("\n")).toMatch(/"limit", 25,/)

		const rust = generateRustSDK(doc as never, { throwOnError: false }).files
		expect(rust["src/client.rs"] + rust["src/types.rs"] + Object.values(rust).join("")).toContain("ItemMissing")
	})
})

describe("ref inlining is bounded", () => {
	it("deeply shared $refs fail loudly instead of exhausting memory", () => {
		const schemas: Record<string, unknown> = { L0: { type: "string" } }
		for (let i = 1; i <= 30; i++) {
			schemas[`L${i}`] = {
				properties: { a: { $ref: `#/components/schemas/L${i - 1}` }, b: { $ref: `#/components/schemas/L${i - 1}` } },
				type: "object",
			}
		}
		const doc = spec(
			{
				"/n": {
					post: {
						operationId: "deep.make",
						requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/L30" } } } },
						responses: {},
					},
				},
			},
			{ schemas },
		)
		const started = Date.now()
		expect(() => generateSDK(doc)).toThrow(/inlined schemas exceed/)
		expect(Date.now() - started).toBeLessThan(2000)
	})
})
