/**
 * The MCP handler an app mounts (bit 21 e): its entry (the tool table, `mcpHandler` over the portable runtime and the
 * API's own SDK, each in the companion directory) type-checked strict, whether it is secured and which headers it
 * carries, read from each tool's security; and the written handler serving Anyrow's five operations in process: a file
 * inline reaches the API intact under `ApiKey <key>`, a stream is collected, and with no credential the call is the
 * endpoint's 401, its challenge the scheme's.
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { anyrow } from "./__fixtures__/anyrow.ts"
import { typeErrors, written } from "./__fixtures__/written.ts"
import { MOUNTED_FILE_SCHEMA } from "./files.ts"
import { generateMcpHandler } from "./mounted.ts"
import { MCP_PORTABLE, mcpRuntimeSource } from "./runtime.ts"
import { toolsOf } from "./tools.ts"
import { toIR, type OpenApiDocument } from "../../ir/build.ts"
import type { Mounted } from "../../runtime/mcp/mount.ts"

const KEY = "ApiKey ak_0123456789abcdef"
const CSV = new TextEncoder().encode("name,qty\nbolt,4\n")
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** The handler `document` generates, written under `src/` and imported. */
async function mounted(document: Record<string, unknown>) {
	const { entry, files } = generateMcpHandler(document)
	const dir = written({
		"src/mcp.gen.ts": entry,
		...Object.fromEntries(Object.entries(files).map(([name, text]) => [`src/mcp/${name}`, text])),
	})
	const module = (await import(join(dir, "src/mcp.gen.ts"))) as { mcpHandler: Mounted }
	return { dir, handler: module.mcpHandler }
}

/** A document of one GET tool, `security` on the operation and `top` on the document when given. */
const oneTool = (security?: unknown, top?: unknown, schemes: Record<string, unknown> = {}) => ({
	components: { securitySchemes: schemes },
	info: { title: "One", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/v1/ping": {
			get: {
				operationId: "ping",
				responses: { 200: { description: "OK" } },
				...(security === undefined ? {} : { security }),
				"x-mcp": true,
			},
		},
	},
	...(top === undefined ? {} : { security: top }),
})

/** The `secured` and `credentials` an entry states. */
const stated = (document: Record<string, unknown>) => {
	const { entry } = generateMcpHandler(document)
	return [/secured: (\w+)/.exec(entry)?.[1], /credentials: (\[[^\]]*\])/.exec(entry)?.[1]]
}

describe("the mounted handler's files (bit 21 e)", () => {
	it("writes the tool table and mcpHandler over the portable runtime and the SDK, strict tsc clean", async () => {
		const document = anyrow()
		const { entry, files, skipped } = generateMcpHandler(document)
		const specs = toolsOf(toIR(document as OpenApiDocument, { deriveOperationIds: true }))
		const { dir } = await mounted(document)
		expect([
			Object.keys(files).sort(),
			files["runtime.gen.ts"] === mcpRuntimeSource(MCP_PORTABLE),
			specs.every((spec) => entry.includes(JSON.stringify(spec.name))),
			/challenge: "ApiKey"[\s\S]*credentials: \["authorization"\][\s\S]*secured: true,\n\tserver: "\/api"/.test(entry),
			skipped,
			typeErrors(dir),
		]).toEqual([
			[
				"api.client.gen.ts",
				"api.index.gen.ts",
				"api.map.gen.ts",
				"api.runtime.gen.ts",
				"api.types.gen.ts",
				"runtime.gen.ts",
			],
			true,
			true,
			true,
			[],
			[],
		])
	})

	it("is secured only when a tool requires a credential: its own security, else the document's, none empty", () => {
		const schemes = {
			bearer: { scheme: "bearer", type: "http" },
			cookie: { in: "cookie", name: "sid", type: "apiKey" },
			key: { in: "header", name: "X-Api-Key", type: "apiKey" },
			mtls: { type: "mutualTLS" },
			query: { in: "query", name: "k", type: "apiKey" },
		}
		expect([
			stated(oneTool()),
			stated(oneTool(undefined, [{ key: [] }], schemes)),
			stated(oneTool([], [{ key: [] }], schemes)),
			stated(oneTool([{}, { key: [] }], undefined, schemes)),
			stated(oneTool([{ cookie: [] }, { mtls: [] }, { query: [] }], undefined, schemes)),
			stated(oneTool([{ bearer: [], key: [] }], undefined, schemes)),
			stated({ ...oneTool([{ key: [] }]), components: undefined }),
		]).toEqual([
			["false", '["authorization"]'],
			["true", '["authorization","x-api-key"]'],
			["false", '["authorization"]'],
			["false", '["authorization","x-api-key"]'],
			["true", '["authorization","cookie"]'],
			["true", '["authorization","x-api-key"]'],
			["true", '["authorization"]'],
		])
	})
})

describe("the mounted handler's files (bit 21 e), continued (2)", () => {
	it("names an API key scheme with no prefix ApiKey, and a document with no version 0.0.0", () => {
		const keyed = { ...oneTool([{ key: [] }], undefined, { key: { in: "header", name: "X-Key", type: "apiKey" } }) }
		const { entry } = generateMcpHandler({ ...keyed, info: { title: "One" } })
		expect([/challenge: "(\w+)"/.exec(entry)?.[1], /version: "([\d.]+)"/.exec(entry)?.[1]]).toEqual(["ApiKey", "0.0.0"])
	})

	it("refuses a directory no import can name and a document with no tool, naming each skipped operation", () => {
		const refusals = [
			() => generateMcpHandler(anyrow(), { dir: "../out" }),
			() => generateMcpHandler(oneTool(), { name: "Not A Name" }),
			() => generateMcpHandler({ ...oneTool(), paths: {} }),
		].map((generate) => {
			try {
				generate()
				return "generated"
			} catch (error) {
				return (error as Error).message
			}
		})
		const document = anyrow() as { paths: Record<string, unknown> }
		document.paths["/v1/live"] = { get: { operationId: "live", responses: {}, "x-mcp": true, "x-websocket": true } }
		document.paths["/v1/quiet"] = { get: { operationId: "quiet", responses: {} } }
		expect([refusals, generateMcpHandler(document).skipped]).toEqual([
			[
				'Invalid dir: "../out"',
				'Invalid name: "Not A Name"',
				"No operation marked x-mcp is one a tool can call: nothing to mount",
			],
			["live (a WebSocket)"],
		])
	})
})

/** Anyrow, in process: each request recorded by its line, credential and parts; extract answers, the stream streams. */
function anyrowApp() {
	const received: unknown[] = []
	const dispatch = async (request: Request) => {
		const { pathname } = new URL(request.url)
		if (request.headers.get("authorization") === null) return new Response(null, { status: 401 })
		const parts: unknown[] = []
		for (const [name, value] of (await request.formData()).entries())
			parts.push(typeof value === "string" ? [name, value] : [name, value.name, sha(await value.bytes())])
		received.push([`${request.method} ${pathname}`, request.headers.get("authorization"), parts])
		if (pathname.endsWith("-stream"))
			return new Response('event: batch\ndata: {"batch_id":"b1"}\n\nevent: complete\ndata: {"rows":2}\n\n', {
				headers: { "content-type": "text/event-stream" },
			})
		return Response.json({ columns: [{ name: "name", type: "text" }], confidence: 0.8 })
	}
	return { dispatch, received }
}

/** A 2025-11-25 tools/call of `name` with `args`, `headers` beside a conforming client's. */
const calling = (name: string, args: object, headers: Record<string, string> = {}) =>
	new Request("https://anyrow.example/mcp", {
		body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2025-11-25",
			...headers,
		},
		method: "POST",
	})

describe("the mounted handler serving Anyrow in process (bit 21 e)", () => {
	it("sends an inline file intact and collects a stream, each under the caller's ApiKey; with none, HTTP 401", async () => {
		const { handler } = await mounted(anyrow())
		const app = anyrowApp()
		const file = {
			data: Buffer.from(CSV).toString("base64"),
			digest: { algorithm: "sha-256", value: createHash("sha256").update(CSV).digest("base64url") },
			id: "rows.csv",
			mimeType: "text/csv",
			name: "rows.csv",
			size: CSV.length,
		}
		const suggest = await handler.fetch(
			calling("suggest_schema", { file, project_id: "p1", text: "a hint" }, { authorization: KEY }),
			app,
		)
		const stream = await handler.fetch(
			calling("extract_table_stream", { project_id: "p1", table_id: "t1", text: "t" }, { authorization: KEY }),
			app,
		)
		const refused = await handler.fetch(calling("extract_table_once", { project_id: "p1", table_id: "t1" }), app)
		/* each answer's structuredContent; an empty body (a refusal) none */
		const results = await Promise.all(
			[suggest, stream].map(async (answer) => {
				const text = await answer.text()
				return text === "" ? null : (JSON.parse(text) as { result: { structuredContent: object } }).result
			}),
		)
		expect([
			[suggest.status, stream.status, refused.status, refused.headers.get("www-authenticate")],
			results.map((result) => result?.structuredContent),
			app.received,
		]).toEqual([
			[200, 200, 401, "ApiKey"],
			[{ columns: [{ name: "name", type: "text" }], confidence: 0.8 }, expect.objectContaining({ ended: "end" })],
			[
				[
					"POST /api/v1/projects/p1/suggest-schema",
					KEY,
					[
						["file", "rows.csv", sha(CSV)],
						["text", "a hint"],
					],
				],
				["POST /api/v1/projects/p1/tables/t1/extract-stream", KEY, [["text", "t"]]],
			],
		])
	})
})

/* built, so no file but runtime/mcp/files.ts names it (tests/structure/mcp-file-extension.test.ts) */
const EXTENSION = ["io.modelcontextprotocol", "files"].join("/")

/** `handler`'s answer to a JSON-RPC `method` with `params`: modern when `params` has `_meta`, else 2025-11-25. */
async function answerOf(handler: Mounted, method: string, params: Record<string, unknown>, mount = {}) {
	const modern = "_meta" in params
	const answer = await handler.fetch(
		new Request("https://anyrow.example/mcp", {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": modern ? "2026-07-28" : "2025-11-25",
				...(modern && { "mcp-method": method }),
			},
			method: "POST",
		}),
		{ dispatch: async () => new Response(null, { status: 500 }), ...mount },
	)
	return ((await answer.json()) as { result: Record<string, unknown> }).result
}

const META = {
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
}
const INITIALIZE = { capabilities: {}, clientInfo: { name: "c", version: "1" }, protocolVersion: "2025-11-25" }

/** A URL fetch the mount is given, fetching nothing. */
const fetchFile = async () => ({ bytes: new Uint8Array(), type: "text/plain" })

/** What `handler` advertises in server/discover, then in a legacy initialize. */
const capabilities = async (handler: Mounted) => [
	(await answerOf(handler, "server/discover", { _meta: META })).capabilities,
	(await answerOf(handler, "initialize", INITIALIZE)).capabilities,
]

describe("the mounted handler's files and their advertisement (bit 21 g)", () => {
	it("shows each file argument as the mounted schema with a URL fetch, the FileInput alone without one", async () => {
		const { handler } = await mounted(anyrow())
		const fileOf = async (mount: object) => {
			const { tools } = (await answerOf(handler, "tools/list", {}, mount)) as {
				tools: { inputSchema: { properties: { file?: unknown } } }[]
			}
			return [...new Set(tools.map((tool) => JSON.stringify(tool.inputSchema.properties.file)))]
		}
		const [first] = MOUNTED_FILE_SCHEMA.anyOf as object[]
		expect([await fileOf({ fetchFile }), await fileOf({})]).toEqual([
			[JSON.stringify(MOUNTED_FILE_SCHEMA)],
			[JSON.stringify({ anyOf: [first] })],
		])
	})

	it("advertises the extension with its 1 MiB inline cap in both eras when a tool takes a file; else nothing", async () => {
		const [files, none] = await Promise.all([mounted(anyrow()), mounted(oneTool())])
		const advertised = { extensions: { [EXTENSION]: { maxInlineBytes: 1_048_576 } }, tools: {} }
		expect([await capabilities(files.handler), await capabilities(none.handler)]).toEqual([
			[advertised, advertised],
			[{ tools: {} }, { tools: {} }],
		])
	})
})
