/**
 * The MCP registry's server.json (plan 39 8.8). The registry's own check (`mcp-publisher validate`) is a call to the
 * live registry, so each file is held offline to the 2025-12-11 schema it names, vendored as
 * `__fixtures__/server.schema.json` and pinned by the sha256 of its canonical JSON (the published file's bytes hash to
 * 3fba0959…14de0), with ajv; the registry's other rules are held here: its name is package.json's `mcpName`, its version
 * the one npm publishes, its package the npm one. Every environment variable it lists is one the server reads over stdio.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Ajv } from "ajv"
import addFormats from "ajv-formats"
import { describe, expect, it } from "vitest"
import { generated, type GenerateRun } from "../../index.ts"
import { generateMcpServer } from "./server.ts"

const SCHEMA_TEXT = readFileSync(resolve(import.meta.dirname, "__fixtures__/server.schema.json"), "utf8")
/* the sha256 of the schema's canonical JSON, the same for the published bytes and oxfmt's */
const SCHEMA_SHA256 = "64cff5eeae54d30932207dfb38324e12eeaeb4abaa09f73dc42c9a9ca319f76e"

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats.default(ajv)
const valid = ajv.compile(JSON.parse(SCHEMA_TEXT) as object)

/** The schema's verdict on `text`: its errors, none when valid. */
const errorsOf = (text: string) =>
	valid(JSON.parse(text)) ? [] : (valid.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const BIN = { format: "binary", type: "string" }
const SHOP = {
	components: { securitySchemes: { key: { in: "header", name: "X-Api-Key", type: "apiKey" } } },
	info: { title: "Shop", version: "1.2.0" },
	openapi: "3.1.0",
	paths: { "/items": { get: { operationId: "items.list", responses: OK, "x-mcp": true } } },
	servers: [{ url: "https://shop.example.test" }],
}
/* a file-taking tool, and no server */
const DOCS = {
	info: { title: "Docs", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/docs": {
			post: {
				operationId: "docs.upload",
				requestBody: { content: { "multipart/form-data": { schema: { properties: { file: BIN }, type: "object" } } } },
				responses: OK,
				"x-mcp": true,
			},
		},
	},
}

const RUN: GenerateRun = {
	metadata: {
		description: "Shop's tools for agents",
		homepage: "https://acme.dev",
		repository: "https://github.com/acme/shop-mcp.git",
	},
	options: { mcp: { mcpName: "io.github.acme/shop", packageName: "@acme/shop-mcp" } },
	targets: ["mcp"],
}

/** The mcp target's files for `run` over `document`. */
async function filesOf(run: GenerateRun, document: object = SHOP) {
	return (
		(await generated(run, document as Record<string, unknown>, { env: {}, report: () => undefined })).mcp?.files ?? {}
	)
}

describe("the server.json the MCP registry reads (plan 39 8.8)", () => {
	it("holds the vendored schema to the published 2025-12-11 one", () => {
		expect(
			createHash("sha256")
				.update(JSON.stringify(JSON.parse(SCHEMA_TEXT)))
				.digest("hex"),
		).toBe(SCHEMA_SHA256)
	})

	it("writes the registry's fields from the run, each the one package.json carries", async () => {
		const files = await filesOf(RUN)
		const server = JSON.parse(files["server.json"] ?? "{}") as Record<string, unknown>
		const npm = JSON.parse(files["package.json"] ?? "{}") as Record<string, unknown>
		expect({
			errors: errorsOf(files["server.json"] ?? "{}"),
			npm: [npm.mcpName, npm.name, npm.version],
			server,
		}).toEqual({
			errors: [],
			npm: ["io.github.acme/shop", "@acme/shop-mcp", "1.2.0"],
			server: {
				$schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
				description: "Shop's tools for agents",
				name: "io.github.acme/shop",
				packages: [
					{
						environmentVariables: [
							{ description: "The API key, sent as X-Api-Key: <key>", isSecret: true, name: "SHOP_API_KEY" },
							{ default: "https://shop.example.test", description: "The API's base URL", name: "SHOP_BASE_URL" },
							{
								default: "30000",
								description: "A call's limit in milliseconds",
								format: "number",
								name: "SHOP_TIMEOUT_MS",
							},
							{ description: "A JSON object of headers sent on every call", isSecret: true, name: "SHOP_HEADERS" },
							{
								choices: ["same-origin", "follow"],
								default: "same-origin",
								description: "Whether a call follows a redirect to another origin",
								name: "SHOP_REDIRECT",
							},
						],
						identifier: "@acme/shop-mcp",
						registryType: "npm",
						transport: { type: "stdio" },
						version: "1.2.0",
					},
				],
				repository: { source: "github", url: "https://github.com/acme/shop-mcp" },
				version: "1.2.0",
				websiteUrl: "https://acme.dev",
			},
		})
	})
})

describe("the server.json's package environment and its refusals (plan 39 8.8)", () => {
	it("lists every variable the server reads over stdio, and only those", async () => {
		const files = generateMcpServer(DOCS, { envPrefix: "DOCS", mcpName: "io.github.acme/docs", name: "docs" }).files
		const listed = (
			JSON.parse(files["server.json"] ?? "{}") as { packages: { environmentVariables: { name: string }[] }[] }
		).packages[0]?.environmentVariables.map((variable) => variable.name)
		/* the HTTP transport's own, which a stdio package never reads */
		const http = new Set(["DOCS_MAX_BODY_BYTES", "DOCS_MCP_ORIGINS", "DOCS_MCP_TOKEN"])
		const read = [...new Set((files["src/server.ts"] ?? "").match(/"DOCS_[A-Z_]+"/g))].map(
			(name) => JSON.parse(name) as string,
		)
		expect([listed?.sort(), errorsOf(files["server.json"] ?? "{}")]).toEqual([
			read.filter((name) => !http.has(name)).sort(),
			[],
		])
	})

	it("marks the base URL required when the API names no server, and links GitLab, but no other forge", () => {
		const docs = (repository: string) =>
			JSON.parse(
				generateMcpServer(DOCS, { mcpName: "io.github.acme/docs" }, { repository }).files["server.json"] ?? "{}",
			) as { repository?: unknown; packages: { environmentVariables: { name: string; isRequired?: boolean }[] }[] }
		const [gitlab, other] = [docs("https://gitlab.com/acme/docs"), docs("https://code.acme.dev/docs")]
		expect([
			gitlab.packages[0]?.environmentVariables.find((variable) => variable.name.endsWith("_BASE_URL"))?.isRequired,
			gitlab.repository,
			"repository" in other,
		]).toEqual([true, { source: "gitlab", url: "https://gitlab.com/acme/docs" }, false])
	})

	it("writes none without an mcpName, and the version npm takes when the document's is not semver", async () => {
		const bare = await filesOf({ targets: ["mcp"] })
		const docs = generateMcpServer(DOCS, { mcpName: "io.github.acme/docs" }).files
		expect(["server.json" in bare, (JSON.parse(docs["server.json"] ?? "{}") as { version: string }).version]).toEqual([
			false,
			"0.0.0",
		])
	})

	it("refuses a description past the registry's 100 characters, naming the field", async () => {
		const long = "x".repeat(101)
		await expect(filesOf({ ...RUN, metadata: { description: long } })).rejects.toThrow(
			`Invalid metadata.description: "${long}": the MCP registry takes 100 characters at most`,
		)
		expect(errorsOf(JSON.stringify({ description: long, name: "io.github.acme/shop", version: "1.0.0" }))).toEqual([
			"/description must NOT have more than 100 characters",
		])
	})
})
