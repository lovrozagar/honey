import { describe, expect, it } from "vitest"
import { ceilingOf, cliSurfaces, countTokens, markAllMcp, mcpSurfaces, sdkSurfaces } from "./capture-token-budget.ts"

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
