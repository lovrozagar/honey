/**
 * The MCP server's tools (bit 18 phase b): only operations marked x-mcp that a tool can call, in the IR's order; a name
 * in snake case, sanitized, at most 64 characters, a taken one suffixed after truncating; the description or summary,
 * controls dropped; a flat inputSchema of the path, query and header parameters and the body, a taken name suffixed,
 * credential headers never arguments; each tool at the SDK member its operation sits at.
 */
import { describe, expect, it } from "vitest"
import { toIR, type OpenApiDocument } from "../../ir/build.ts"
import { erased, generateMcpServer } from "./server.ts"
import { anyrow } from "./__fixtures__/anyrow.ts"
import { FILE_SCHEMA } from "./files.ts"
import { NAME_MAX, toolName, toolsOf } from "./tools.ts"

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const STR = { type: "string" }
const json = (schema: unknown) => ({ content: { "application/json": { schema } }, required: true })

/** The tools of a document of `paths`, with `security` its credential scheme. */
const tools = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	toolsOf(
		toIR({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths, ...extra } as unknown as OpenApiDocument, {
			deriveOperationIds: true,
		}),
	)

const op = (operationId: string, more: Record<string, unknown> = {}) => ({
	operationId,
	responses: OK,
	"x-mcp": true,
	...more,
})

describe("which operations are tools (phase b)", () => {
	// v0: c22e287e6e
	// v0: 787e53db6d
	it("makes one of each operation marked x-mcp a tool can call, in the IR's order; no socket; a multipart form its parts (bit 21 c); an event stream a collect", () => {
		const listed = tools({
			"/a": { get: op("a.list"), post: op("a.create", { requestBody: json({ type: "object" }) }) },
			"/b": { get: { operationId: "b.list", responses: OK } },
			"/events": {
				get: op("events.watch", {
					responses: { 200: { content: { "text/event-stream": { schema: STR } }, description: "e" } },
				}),
			},
			"/chat": { get: op("chat.open", { responses: { 101: { description: "up" } }, "x-websocket": true }) },
			"/upload": {
				post: op("upload.send", {
					requestBody: { content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } } },
				}),
			},
			"/text": { post: op("text.send", { requestBody: { content: { "text/plain": { schema: STR } } } }) },
			"/png": {
				post: op("png.send", {
					requestBody: { content: { "image/png": { schema: { format: "binary", type: "string" } } } },
				}),
			},
			"/parts": {
				post: op("parts.send", {
					requestBody: { content: { "multipart/form-data": { schema: { properties: { a: STR }, type: "object" } } } },
				}),
			},
			"/form": {
				post: op("form.send", {
					requestBody: {
						content: { "application/x-www-form-urlencoded": { schema: { properties: { a: STR }, type: "object" } } },
					},
				}),
			},
		})
		expect(listed.map((tool) => [tool.name, tool.member, tool.body?.slice(1)])).toEqual([
			["a_list", ["a", "list"], undefined],
			["a_create", ["a", "create"], ["json"]],
			["events_watch", ["events", "watch"], undefined],
			["upload_send", ["upload", "send"], ["bytes", "application/octet-stream"]],
			["text_send", ["text", "send"], ["text", "text/plain"]],
			["png_send", ["png", "send"], ["bytes", "image/png"]],
			["parts_send", ["parts", "send"], undefined],
			["form_send", ["form", "send"], ["form"]],
		])
		expect(listed.find((tool) => tool.name === "parts_send")?.parts).toEqual([["a", "a", "text"]])
	})
})

describe("a tool's name (phase b)", () => {
	// v0: 31c0da95e0
	// v0: ba83b05d44
	// v0: f550f89729
	it("is the operation id in snake case, every segment kept, a camelCase word split, its SDK member every segment deep", () => {
		const listed = tools({
			"/c": { post: op("checkout.sessions.create") },
			"/u": { get: op("users.list") },
			"/u/p": { patch: op("users.profile.update") },
			"/x": { get: op("getHTTPStatus") },
		})
		expect(listed.map((tool) => [tool.name, tool.member])).toEqual([
			["checkout_sessions_create", ["checkout", "sessions", "create"]],
			["users_list", ["users", "list"]],
			["users_profile_update", ["users", "profile", "update"]],
			["get_http_status", ["getHTTPStatus"]],
		])
	})

	it("keeps [A-Za-z0-9_-] only, at most 64 characters, a taken name suffixed after truncating so it still fits", () => {
		const taken = new Set<string>()
		const long = `a${"b".repeat(69)}`
		const names = ["a.b", "a_b", 'evil"); process.exit(1); ("', long, `${long}.x`, "--"].map((id) =>
			toolName(id, taken),
		)
		expect(names).toEqual([
			"a_b",
			"a_b_2",
			"evil_process_exit_1",
			long.slice(0, NAME_MAX),
			`${long.slice(0, NAME_MAX - 2)}_2`,
			"tool",
		])
		expect(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true)
	})

	// v0: db50c4348b
	it("refuses an id that is also another's namespace, naming both, as the IR does", () => {
		const paths = { "/u": { post: op("users.create") }, "/u/d": { post: op("users.create.draft") } }
		expect(() => generateMcpServer({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })).toThrow(
			'operationId conflict: "users.create" is callable but also a namespace prefix of "users.create.draft".',
		)
	})
})

describe("a tool's description (phase b)", () => {
	// v0: d157827d54
	it("is the description, else the summary, its controls dropped, none when both are empty", () => {
		const listed = tools({
			"/a": { get: op("a", { description: "Lists\u001b[2J the a\u0000s", summary: "short" }) },
			"/b": { get: op("b", { summary: "Only a summary" }) },
			"/c": { get: op("c", { summary: " " }) },
		})
		expect(listed.map((tool) => tool.description)).toEqual(["Lists[2J the as", "Only a summary", undefined])
	})
})

describe("a tool's inputSchema (phase b)", () => {
	// v0: 4ad3a5947d
	it("holds each parameter flat under its own name, the body under body, credential headers never, no other key", () => {
		const parameters = [
			{ in: "path", name: "id", required: true, schema: STR },
			{ in: "query", name: "limit", schema: { type: "integer" } },
			{ in: "query", name: "id", schema: STR },
			{ in: "query", name: "body", schema: STR },
			{ in: "header", name: "X-Trace", schema: STR },
			...["Authorization", "Cookie", "Proxy-Authorization", "X-API-Key"].map((name) => ({
				in: "header",
				name,
				schema: STR,
			})),
		]
		const security = {
			components: { securitySchemes: { key: { in: "header", name: "X-API-Key", type: "apiKey" } } },
			security: [{ key: [] }],
		}
		const [tool] = tools(
			{
				"/i/{id}": { put: op("i.put", { parameters, requestBody: json({ properties: { n: STR }, type: "object" }) }) },
			},
			security,
		)
		expect([tool?.inputSchema, tool?.args, tool?.body]).toEqual([
			{
				properties: {
					body: STR,
					body2: { properties: { n: STR }, type: "object" },
					id: STR,
					id2: STR,
					limit: { type: "integer" },
					"X-Trace": STR,
				},
				required: ["id", "body2"],
				type: "object",
				additionalProperties: false,
			},
			[
				["id", "params", "id"],
				["limit", "search", "limit"],
				["id2", "search", "id"],
				["body", "search", "body"],
				["X-Trace", "headers", "X-Trace"],
			],
			["body2", "json"],
		])
	})
})

describe("a tool's SDK member (phase b)", () => {
	it("takes a path-item parameter and a derived id as the TS SDK does, at the member the SDK has", () => {
		const listed = tools({
			"/orgs/{org}/members": {
				get: { responses: OK, "x-mcp": true },
				parameters: [{ in: "path", name: "org", required: true, schema: STR }],
			},
			"/state": { get: op("state.get") },
		})
		expect(listed.map((tool) => [tool.name, tool.member, tool.inputSchema.required])).toEqual([
			["state_get", ["state_", "get"], undefined],
			["get_orgs_members_by_org", ["getOrgsMembersByOrg"], ["org"]],
		])
	})
})

describe("spec text in tools.gen.ts (F2, phase b)", () => {
	// v0: 99a5e00889
	it("parses as written, a hostile id, description and enum injecting nothing", () => {
		const evil = 'x"); process.exit(1); ("` */ ${1}'
		const paths = {
			"/x": {
				get: op(evil, {
					description: evil,
					parameters: [{ in: "query", name: evil, schema: { enum: [evil], type: "string" } }],
				}),
			},
		}
		const files = generateMcpServer({ info: { title: evil, version: "1" }, openapi: "3.1.0", paths }).files
		const source = files["src/tools.gen.ts"] as string
		expect(
			[
				() => erased("src/tools.gen.ts", source),
				/^\s*process\.exit/m.test(source),
				source.includes(JSON.stringify(evil).slice(1, -1)),
			].map((check) => (typeof check === "function" ? (check(), "parsed") : check)),
		).toEqual(["parsed", false, true])
	})
})

describe("a multipart form's parts, each its own argument (bit 21 c)", () => {
	it("makes a text part its schema, a file part files.ts's schema, a list of files an array of it; a clash suffixed", () => {
		const form = {
			properties: {
				file: { description: "The upload", format: "binary", type: "string" },
				files: { items: { format: "binary", type: "string" }, maxItems: 3, type: "array" },
				id: STR,
				n: { type: "integer" },
			},
			required: ["file"],
			type: "object",
		}
		const [tool] = tools({
			"/p/{id}": {
				post: op("p.send", {
					parameters: [{ in: "path", name: "id", required: true, schema: STR }],
					requestBody: { content: { "multipart/form-data": { schema: form } } },
				}),
			},
		})
		expect([tool?.inputSchema, tool?.parts, tool?.body]).toEqual([
			{
				additionalProperties: false,
				properties: {
					file: { ...FILE_SCHEMA, description: "The upload" },
					files: { items: FILE_SCHEMA, maxItems: 3, type: "array" },
					id: STR,
					id2: STR,
					n: { type: "integer" },
				},
				required: ["id", "file"],
				type: "object",
			},
			[
				["file", "file", "file"],
				["files", "files", "files"],
				["id2", "id", "text"],
				["n", "n", "text"],
			],
			undefined,
		])
	})
})

describe("a multipart form's parts, by the form (bit 21 c)", () => {
	it("takes a multipart form with no schema as no arguments", () => {
		const [tool] = tools({
			"/p": { post: op("p.send", { requestBody: { content: { "multipart/form-data": {} } } }) },
		})
		expect([tool?.inputSchema.properties, tool?.parts]).toEqual([{}, []])
	})

	it("makes each of Anyrow's five multipart operations a tool, its form a ref, its path parameters first", () => {
		const listed = toolsOf(toIR(anyrow() as unknown as OpenApiDocument, { deriveOperationIds: true }))
		const parts = (kind: string) =>
			listed.map((tool) => (tool.parts ?? []).filter((part) => part[2] === kind).map(([, name]) => name))
		expect([
			listed.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties as object)]),
			parts("file"),
		]).toEqual([
			[
				["extract_once", ["project_id", "columns", "file", "instruction", "schema", "strictness", "text"]],
				[
					"extract_stream",
					[
						"project_id",
						"columns",
						"file",
						"instruction",
						"schema",
						"strictness",
						"text",
						"max_events",
						"last_event_id",
					],
				],
				["suggest_schema", ["project_id", "file", "text"]],
				["extract_table_once", ["project_id", "table_id", "file", "text"]],
				["extract_table_stream", ["project_id", "table_id", "file", "text", "max_events", "last_event_id"]],
			],
			[["file"], ["file"], ["file"], ["file"], ["file"]],
		])
	})
})
