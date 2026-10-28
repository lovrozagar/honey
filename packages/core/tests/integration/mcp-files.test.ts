/**
 * Remote files under the official TS clients (bit 21 g): sdk 1.32.2 (2025-11-25) and client 2.4.0 pinned to 2026-07-28,
 * gen's pinned install, over Streamable HTTP against an app served on a loopback port the OS picks, MCP mounted with
 * `urlFiles` and `uploads`. Each client lists a file argument with its `{url}` value and sends a file by URL, which
 * the app fetches from a local file host and its route reads intact. Neither client declares the file-uploads
 * extension, so a file without data is a tool error, never an upload request: the extension's own flow runs under the
 * minimal client (security/mcp-uploads-adversarial.test.ts).
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as z from "zod"
import { httpSession, withClients } from "../../../gen/src/emit/mcp/__fixtures__/clients.ts"
import { written } from "../../../gen/src/emit/mcp/__fixtures__/written.ts"
import { generateMcpHandler } from "../../../gen/src/emit/mcp/mounted.ts"
import { serve, type ServeHandle } from "../../src/adapters/serve.ts"
import { type McpHandler, mcp } from "../../src/mcp/mount.ts"
import { memoryUploadStore, uploads } from "../../src/mcp/uploads.ts"
import { urlFiles } from "../../src/mcp/url-files.ts"
import { generateOpenApi } from "../../src/openapi/generate.ts"
import { honey } from "../../src/routing/app.ts"
import { fileInput } from "./mcp-files/client.ts"
import { SPAWN_TIMEOUT } from "../../../gen/src/gen/__fixtures__/spawn-timeout.ts"

const KEY = "ApiKey ak_files"
const SCHEMES = {
	apiKey: { description: "Format: ApiKey {key}", in: "header", name: "Authorization", type: "apiKey" },
}
const CSV = new TextEncoder().encode("name,qty\nbolt,4\n")
const FILES = ["io.modelcontextprotocol", "files"].join("/")

/** The app: one file tool, `docs_save`, answering the file's name, size and SHA-256 (hex). */
function app() {
	return honey()
		.post("/docs")
		.meta({ mcp: true, operationId: "docs.save", security: [{ apiKey: [] }] })
		.input({ form: z.object({ file: z.file() }) })
		.output({ "application/json": { ok: z.object({ name: z.string(), sha256: z.string(), size: z.number() }) } })
		.handler(async (ctx) => {
			const { file } = ctx.input.form
			const sha256 = createHash("sha256")
				.update(new Uint8Array(await file.arrayBuffer()))
				.digest("hex")
			return ctx.res.json("ok", { name: file.name, sha256, size: file.size })
		})
}

const servers: ServeHandle[] = []
let endpoint = ""
const hosted: string[] = []

beforeAll(async () => {
	const document = generateOpenApi(app(), { info: { title: "Docs", version: "1.0.0" }, securitySchemes: SCHEMES })
	const { entry, files } = generateMcpHandler(document as unknown as Record<string, unknown>)
	const dir = written({
		"mcp.gen.ts": entry,
		...Object.fromEntries(Object.entries(files).map(([name, text]) => [`mcp/${name}`, text])),
	})
	const handler = ((await import(join(dir, "mcp.gen.ts"))) as { mcpHandler: McpHandler }).mcpHandler
	const fileHost = await serve(
		{
			fetch: async (request: Request) => {
				hosted.push(`${new URL(request.url).pathname} ${request.headers.get("authorization")}`)
				return new Response(CSV, { headers: { "content-type": "text/csv" } })
			},
		},
		{ hostname: "127.0.0.1", port: 0 },
	)
	servers.push(fileHost)
	/* the listed host, https as the guard asks, reached on the local file host's port */
	const local = (request: Request) => {
		const url = new URL(request.url)
		return fetch(`http://127.0.0.1:${fileHost.port}${url.pathname}`, {
			redirect: request.redirect,
			signal: request.signal,
		})
	}
	const mounted = mcp(app(), "/mcp", handler, {
		authenticate: (request) => request.headers.get("authorization") === KEY,
		uploads: uploads({ secret: "an-app-secret-of-at-least-32-characters", store: memoryUploadStore() }),
		urlFiles: urlFiles({ fetch: local, hosts: ["files.example"] }),
	})
	const server = await serve(mounted, { hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	endpoint = `http://127.0.0.1:${server.port}/mcp`
})

afterAll(async () => {
	await Promise.all(servers.map((server) => server.close()))
})

describe.skipIf(!withClients())("remote files under the official TS clients (bit 21 g)", () => {
	it.each(["sdk", "modern"] as const)(
		"%s lists the {url} value, sends a file by URL, gets no upload request",
		{ timeout: SPAWN_TIMEOUT },
		async (client) => {
			hosted.length = 0
			const metadata = await fileInput("f-1", CSV, "text/csv")
			const [listed, fetched, unasked] = await httpSession(client, { headers: { authorization: KEY }, url: endpoint }, [
				{ list: true },
				{ call: { arguments: { file: { url: "https://files.example/rows.csv" } }, name: "docs_save" } },
				{ call: { arguments: { file: metadata }, name: "docs_save" } },
			])
			const file = (
				(listed?.tools?.[0]?.inputSchema ?? {}) as { properties: { file: { anyOf: { properties: object }[] } } }
			).properties.file
			const sha256 = createHash("sha256").update(CSV).digest("hex")
			expect([
				file.anyOf.map((value) => Object.keys(value.properties)),
				(fetched?.result as { structuredContent?: unknown })?.structuredContent,
				hosted,
				(unasked?.result as { content: { text: string }[] })?.content[0]?.text,
			]).toEqual([
				[["digest"], ["url"]],
				{ name: "rows.csv", sha256, size: CSV.length },
				["/rows.csv null"],
				JSON.stringify({
					message: `Invalid arguments: file has no data, and an upload needs a 2026-07-28 request declaring ${FILES}`,
				}),
			])
		},
	)
})
