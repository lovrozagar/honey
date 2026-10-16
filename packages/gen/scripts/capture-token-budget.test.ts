import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { runtimeFileNames } from "../src/emit/go/http.ts"
import { generateGoSdk, goCallPlans } from "../src/emit/go/sdk.ts"
import { compareCodeUnits } from "../src/emit/shared/lang.ts"
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
	v1GoSdkSurfaces,
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

/*
 * G13 (bit 12): Go's own per-operation ceiling, not sdkCli's 234. Measured over the five e2e apps'
 * 72 operations in both throwOnError modes (144 surfaces, `v1GoSdkSurfaces` over the pre-gofmt
 * client.go): max 78 (surface, PutInAllByResourceId, safe mode), median 43; gofmt's field alignment
 * moves the max to 79. 78 + 20% headroom = 94. Each language holds its own ceiling, set from its
 * own measurement: Go's surface is a third of TS's, so the shared one would let it triple unseen.
 * An operation over it is fixed in the schema, never by raising the ceiling; revisit only for a
 * genuinely large, legitimate operation.
 */
const GO_SDK_CEILING = 94

const GO_CLIENT = `package sdk

// Get calls GET /a.
func (r *Client) Get(ctx context.Context, opts *GetOpts, reqOpts ...RequestOption) (SDKResult[A], error) {
\treturn get(ctx)
}

func (r *ItemsResource) Get(ctx context.Context, id string, reqOpts ...RequestOption) error {
\treturn nil
}

func (r *Client) helper(x int) {
}

// GetOpts holds the optional parameters of get.
type GetOpts struct {
\t// Limit caps the page.
\tLimit *int
}

type EmptyOpts struct {
}
`

describe("the v1 Go SDK within the budget (bit 12, G13)", () => {
	it("reads each method's signature with its Opts block, keyed receiver.method", () => {
		expect(Object.fromEntries(v1GoSdkSurfaces(GO_CLIENT))).toEqual({
			"Client.Get": [
				"func (r *Client) Get(ctx context.Context, opts *GetOpts, reqOpts ...RequestOption) (SDKResult[A], error)",
				"type GetOpts struct {",
				"\t// Limit caps the page.",
				"\tLimit *int",
				"}",
			].join("\n"),
			"ItemsResource.Get":
				"func (r *ItemsResource) Get(ctx context.Context, id string, reqOpts ...RequestOption) error",
		})
	})

	it("refuses a method whose Opts struct is never declared, so a missed block never measures short", () => {
		const text = GO_CLIENT.replace("type GetOpts struct", "type OtherOpts struct")
		expect(() => v1GoSdkSurfaces(text)).toThrow("Client.Get takes GetOpts, which is never declared")
	})

	it(`keeps every e2e app's Go operations within ${GO_SDK_CEILING} tokens, in both throwOnError modes`, () => {
		const over: string[] = []
		for (const app of APPS) {
			const file = join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`)
			const spec = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
			for (const throwOnError of [true, false]) {
				const options = { modulePath: "example.com/budget", throwOnError }
				const surfaces = v1GoSdkSurfaces(generateGoSdk(spec, options).files["client.go"] ?? "")
				/* completeness: a surface the regex misses can never pass by going unmeasured */
				const plans = Object.keys(goCallPlans(spec, options)).length
				if (surfaces.size !== plans) over.push(`${app}: ${surfaces.size} of ${plans} measured`)
				for (const [key, text] of surfaces) {
					const tokens = countTokens(text)
					if (tokens > GO_SDK_CEILING) over.push(`${app}/${key}${throwOnError ? "" : " (safe)"}: ${tokens}`)
				}
			}
		}
		expect(over).toEqual([])
	})
})

/*
 * G14 (bit 12): the vendored Go runtime's bloat guard, in bytes on disk as shipped (00-rules:160),
 * never string length (errors.go and stale.go hold multi-byte characters). v0's client-go/* was
 * 77,086 B; +15% gave the original 88,649 gate. Bit 12 phases d and e re-baselined it to 90,000 for
 * named feature bytes: the realtime dial honoring ctx (+113), openChain's ctx check (+186), a fresh
 * X-Request-Id per dial (+450), SSE-open OnResponse/OnLog parity (+851; net +193 after the shared
 * exchange -658 and the shared hook loop -25), the ResumableConnection.Close race fix (+232), the
 * close-code godoc pointer (+95), and a benign WebSocket Close after a server close (+100). No
 * runtime file goes unshipped (dead code). A future raise names its feature bytes and cuts dead and
 * duplicate code first; it is never silent.
 */
const GO_RUNTIME_BYTES = 90_000

describe("the Go runtime within its byte budget (bit 12, G14)", () => {
	it(`ships every runtime file it holds, all of them within ${GO_RUNTIME_BYTES} bytes`, () => {
		const dir = join(REPO, "packages/gen/src/runtime/go")
		const names = readdirSync(dir)
			.filter((name) => name.endsWith(".go"))
			.sort(compareCodeUnits)
		const bytes = names.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
		expect({ names, over: Math.max(0, bytes - GO_RUNTIME_BYTES) }).toEqual({
			names: runtimeFileNames({ realtime: true, ws: true }),
			over: 0,
		})
	})
})
