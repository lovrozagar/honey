import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { generateSdk } from "../src/emit/ts/sdk.ts"
import type { IROperation } from "../src/ir/model.ts"
import {
	ceilingOf,
	cliSurfaces,
	countTokens,
	documentOperationText,
	irOperationText,
	markAllMcp,
	mcpSurfaces,
	oversizedOperations,
	sdkSurfaces,
	v1SdkSurfaces,
} from "./capture-token-budget.ts"

describe("the pinned tokenizer", () => {
	it("counts with o200k_base", () => {
		expect(countTokens("hello world")).toBe(2)
		expect(countTokens("")).toBe(0)
	})
})

describe("markAllMcp", () => {
	it("opts every operation into the MCP server without touching the input", () => {
		const spec = { paths: { "/a": { get: { operationId: "a" }, parameters: [] }, "/b": { post: {} } } }
		expect(markAllMcp(spec)).toEqual({
			paths: { "/a": { get: { operationId: "a", "x-mcp": true }, parameters: [] }, "/b": { post: { "x-mcp": true } } },
		})
		expect(spec.paths["/a"].get).toEqual({ operationId: "a" })
	})
})

describe("mcpSurfaces", () => {
	it("reads each tool's name, description and inputSchema from tools.gen.ts", () => {
		const source = [
			"export function buildTools(sdk: Record<string, unknown>): Tool[] {",
			"\treturn [",
			"\t\ttool(",
			'\t\t\t"app_users_get",',
			'\t\t\t"Get a user",',
			'\t\t\t{"type":"object","properties":{"id":{"type":"string"}}},',
			'\t\t\t["users","get"],',
			'\t\t\t{"path":["id"]},',
			"\t\t),",
			"\t\ttool(",
			'\t\t\t"app_health",',
			"\t\t\tundefined,",
			'\t\t\t{"type":"object"},',
			'\t\t\t["health"],',
			"\t\t\t{},",
			"\t\t),",
			"\t]",
			"}",
		].join("\n")
		expect(mcpSurfaces(source)).toEqual(
			new Map([
				[
					"app_users_get",
					'{"name":"app_users_get","description":"Get a user","inputSchema":{"type":"object","properties":{"id":{"type":"string"}}}}',
				],
				["app_health", '{"name":"app_health","inputSchema":{"type":"object"}}'],
			]),
		)
	})
})

describe("sdkSurfaces", () => {
	it("takes each method signature with the shared aliases it names", () => {
		const types = [
			'type _Errs0 = { 401: _ErrEnvelope<401, "unauthorized"> }',
			"type _Inp0 = { params: { id: string } }",
			"export type SDK<TThrow extends boolean = false> = {",
			"\tgetUser(input: _Expand<_Inp0> & _HttpOpts): Promise<SDKResult<{ id: string }, _Expand<_Errs0>>>",
			"\tgetHealth(input?: _HttpOpts): Promise<SDKResult<void>>",
			"}",
		].join("\n")
		expect(sdkSurfaces(types)).toEqual(
			new Map([
				[
					"getUser",
					[
						"getUser(input: _Expand<_Inp0> & _HttpOpts): Promise<SDKResult<{ id: string }, _Expand<_Errs0>>>",
						'type _Errs0 = { 401: _ErrEnvelope<401, "unauthorized"> }',
						"type _Inp0 = { params: { id: string } }",
					].join("\n"),
				],
				["getHealth", "getHealth(input?: _HttpOpts): Promise<SDKResult<void>>"],
			]),
		)
	})
})

describe("cliSurfaces", () => {
	it("takes each command's help text: use, short, long, and its flags", () => {
		const files = {
			"cmd/getUser.go": [
				"var getUserCmd = &cobra.Command{",
				'\tUse:   "get-user",',
				'\tShort: "get-user commands",',
				"}",
				'\tLong:  "Reads one user.",',
				'\tgetUserCallCmd.Flags().StringVar(&getUserCallCmdIdVar, "id", "", "Path parameter id")',
				'\tgetUserCallCmd.MarkFlagRequired("id")',
				'\tpath := "/users/" + id',
			].join("\n"),
			"cmd/root.go": 'Use: "app"',
			"internal/cli/config.go": 'Use: "ignored"',
		}
		expect(cliSurfaces(files)).toEqual(
			new Map([["getUser", "get-user\nget-user commands\nReads one user.\n--id Path parameter id (required)"]]),
		)
	})
})

describe("ceilingOf", () => {
	it("is the largest per-operation count plus headroom, rounded up", () => {
		expect(ceilingOf([120, 300, 280], 0.2)).toBe(360)
		expect(ceilingOf([101], 0.2)).toBe(122)
	})

	it("has nothing to bound without a measurement", () => {
		expect(() => ceilingOf([], 0.2)).toThrow(/no operations/)
	})
})

describe("irOperationText", () => {
	it("writes an operation with every component it reaches inlined, a cycle and an unknown name kept as refs", () => {
		const op = {
			extensions: {},
			id: "users.get",
			method: "GET",
			params: { header: [], path: [], query: [] },
			path: "/users",
			responses: { "200": { schema: { items: { kind: "ref", name: "User" }, kind: "array" }, status: "200" } },
		} as unknown as IROperation
		const schemas = {
			Team: { fields: [{ name: "lead", required: true, schema: { kind: "ref", name: "User" } }], kind: "object" },
			User: {
				fields: [
					{ name: "team", required: false, schema: { kind: "ref", name: "Team" } },
					{ name: "x", required: false, schema: { kind: "ref", name: "Missing" } },
				],
				kind: "object",
			},
		} as never
		const team = {
			fields: [{ name: "lead", required: true, schema: { kind: "ref", name: "User" } }],
			kind: "object",
		}
		expect(JSON.parse(irOperationText(op, schemas))).toEqual({
			...op,
			responses: {
				"200": {
					schema: {
						items: {
							fields: [
								{ name: "team", required: false, schema: team },
								{ name: "x", required: false, schema: { kind: "ref", name: "Missing" } },
							],
							kind: "object",
						},
						kind: "array",
					},
					status: "200",
				},
			},
		})
	})
})

/** A document whose GET /nodes/{id} returns a recursive Node, and whose POST /notes carries `description`. */
const documented = (description: string) => ({
	components: {
		schemas: {
			Node: {
				properties: { children: { items: { $ref: "#/components/schemas/Node" }, type: "array" } },
				type: "object",
			},
		},
	},
	openapi: "3.1.0",
	paths: {
		"/nodes/{id}": {
			get: {
				operationId: "getNode",
				responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } },
			},
		},
		"/notes": {
			post: { description, operationId: "postNote", requestBody: { $ref: "#/components/requestBodies/Missing" } },
		},
	},
})

describe("documentOperationText", () => {
	it("writes an operation as the document holds it, every component it reaches inlined, a cycle and an unknown name kept as refs", () => {
		expect(JSON.parse(documentOperationText(documented("d"), "/nodes/{id}", "get"))).toEqual({
			operationId: "getNode",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: {
								properties: { children: { items: { $ref: "#/components/schemas/Node" }, type: "array" } },
								type: "object",
							},
						},
					},
				},
			},
		})
		expect(
			(JSON.parse(documentOperationText(documented("d"), "/notes", "post")) as { requestBody: unknown }).requestBody,
		).toEqual({
			$ref: "#/components/requestBodies/Missing",
		})
	})
})

describe("oversizedOperations", () => {
	it("flags each operation whose document text runs over the ceiling, by id", () => {
		const spec = documented("word ".repeat(400))
		const small = countTokens(documentOperationText(spec, "/nodes/{id}", "get"))
		expect([oversizedOperations(spec, small), oversizedOperations(spec, 10_000)]).toEqual([["postNote"], []])
	})
})

const REPO = resolve(import.meta.dirname, "../../..")
const APPS = ["compose", "defaults", "gateway", "kitchen", "surface"]

describe("the v1 SDK within the budget (bit 11)", () => {
	it("reads each operation's signature lines, its raw overload with its call, a repeated name numbered", () => {
		const raw = "get(input: A & { raw: true }): Promise<Response>"
		const types = `interface Ops {\n\titems: {\n\t\t${raw}\n\t\tget(input?: A): R\n\t}\n\tusers: {\n\t\tget(input?: B): S\n\t}\n\t"x-y"(input?: C): T\n}`
		expect(Object.fromEntries(v1SdkSurfaces(types))).toEqual({
			'"x-y"': '"x-y"(input?: C): T',
			get: `${raw}\nget(input?: A): R`,
			"get#2": "get(input?: B): S",
		})
	})

	it("keeps every e2e app's operations within the sdkCli and document ceilings", () => {
		const baseline = JSON.parse(readFileSync(join(REPO, "blueprint/baselines/tokens.json"), "utf8")) as {
			document: { ceiling: number }
			sdkCli: { ceiling: number }
		}
		const over: string[] = []
		for (const app of APPS) {
			const file = join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`)
			const spec = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { paths: Record<string, never> }
			const { files, stem } = generateSdk(spec, { name: "SDK" })
			for (const [name, text] of v1SdkSurfaces(files[`${stem}.types.gen.ts`] ?? ""))
				if (countTokens(text) > baseline.sdkCli.ceiling) over.push(`${app}/${name}`)
			over.push(...oversizedOperations(spec, baseline.document.ceiling).map((id) => `${app}/${id} (document)`))
		}
		expect(over).toEqual([])
	})
})
