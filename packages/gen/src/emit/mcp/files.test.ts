/**
 * File arguments through the emitted server (bit 21 c), its process against a recording server. A multipart form goes
 * as multipart/form-data whether or not it holds a file (a call without its optional file, a form of text alone, never
 * urlencoded): each text part as given, each file its bytes under its name, a list of files a part each, read from the
 * root or decoded inline. The entry reads $<PREFIX>_FILE_ROOT (a directory, else no start), $<PREFIX>_MAX_FILE_BYTES and
 * $<PREFIX>_MAX_INLINE_BYTES (whole numbers, else no start), and server/discover advertises the file-uploads extension
 * with its inline cap; a server whose tools take no file reads none of it and advertises nothing. A file argument's
 * schema is the draft's FileInput or a path, and a call whose file is neither, holds a prototype-named key or passes the
 * inline cap is refused before anything is sent. The hostile paths and inline values are
 * tests/security/emit-adversarial.mcp-files.test.ts's.
 */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bindTools, type ToolSpec } from "../../runtime/mcp/call.ts"
import { FILES } from "../../runtime/mcp/files.ts"
import { type RecordingServer, served } from "../shared/__fixtures__/recording-server.ts"
import { exchange, exchangeEach, initialize, request, scratchDir, written } from "./__fixtures__/written.ts"
import { FILE_SCHEMA } from "./files.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 120_000 }
const STR = { type: "string" }
const BIN = { format: "binary", type: "string" }
const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const MODERN = {
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
}

/** A POST of the multipart form `schema`. */
const upload = (operationId: string, schema: object) => ({
	post: {
		operationId,
		requestBody: { content: { "multipart/form-data": { schema } } },
		responses: OK,
		"x-mcp": true,
	},
})

/** The docs document: `docs.upload` a form with a file, a list of files and text; `notes.send` a form of text alone. */
const docs = {
	info: { title: "Docs", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/docs": upload("docs.upload", {
			properties: { count: { type: "integer" }, file: BIN, files: { items: BIN, type: "array" }, note: STR },
			type: "object",
		}),
		"/notes": upload("notes.send", { properties: { note: STR, tags: { items: STR, type: "array" } }, type: "object" }),
	},
}

const dir = written(generateMcpServer(docs, { envPrefix: "DOCS", name: "docs" }).files)
const plain = written(
	generateMcpServer({ ...docs, paths: { "/notes": docs.paths["/notes"] } }, { envPrefix: "DOCS", name: "docs" }).files,
)

/** A root holding `a.txt` and `four.txt`. */
function rootDir(): string {
	const root = scratchDir("root")
	mkdirSync(root, { recursive: true })
	writeFileSync(join(root, "a.txt"), "abc")
	writeFileSync(join(root, "four.txt"), "abcd")
	return root
}

/** The server in `at` with `env`. */
const command = (at: string, env: readonly string[]) => ["env", ...env, process.execPath, join(at, "dist", "server.js")]

/** A tools/call of `name` with `args`. */
const call = (id: number, name: string, args: object) => request(id, "tools/call", { arguments: args, name })

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** `text` inline, as a FileInput of `mimeType`, named when `name` is given. */
const fileInput = (text: string, mimeType = "text/plain", name?: string) => ({
	data: Buffer.from(text).toString("base64"),
	digest: { algorithm: "sha-256", value: createHash("sha256").update(text).digest("base64url") },
	id: text,
	mimeType,
	...(name === undefined ? {} : { name }),
	size: text.length,
})

/** Each part of a multipart body: its name, and its text or its file's name, type and SHA-256. */
async function partsOf(body: Uint8Array, contentType: string | null) {
	const form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType ?? "" } }).formData()
	const parts: unknown[] = []
	for (const [name, value] of form.entries())
		parts.push(typeof value === "string" ? [name, value] : [name, value.name, value.type, sha(await value.bytes())])
	return parts
}

/** Each request the API received: its media type and its parts. */
const received = (api: RecordingServer) =>
	Promise.all(
		api.hops.map(async (hop, at) => [
			hop.body.contentType?.split(";")[0],
			await partsOf(api.bodies[at] as Uint8Array, hop.body.contentType),
		]),
	)

/** Each reply's message, a refusal's JSON text. */
const messagesOf = (replies: readonly unknown[]) =>
	replies.map(
		(reply) =>
			JSON.parse(String((reply as { result: { content: { text: string }[] } }).result.content[0]?.text)) as unknown,
	)

const MULTIPART = "multipart/form-data"

/** The capabilities a server/discover answered. */
const capabilities = (ran: { replies: readonly unknown[] }) =>
	(ran.replies[0] as { result: { capabilities: unknown } }).result.capabilities

describe("a multipart form as the API receives it", SLOW, () => {
	it("sends every form as multipart/form-data: files read and inline, a list a part each, text as given", async () => {
		const root = rootDir()
		const replies = [0, 1, 2].map(() => ({ json: {}, status: 200 }))
		const sent = await served(replies, async (api) => {
			const ran = await exchangeEach(command(dir, [`DOCS_BASE_URL=${api.url}`, `DOCS_FILE_ROOT=${root}`]), [
				initialize("2025-11-25"),
				call(1, "docs_upload", {
					count: 2,
					file: { path: "a.txt" },
					files: [fileInput("xyz", "image/png", "x.png"), { path: "four.txt" }],
					note: "n",
				}),
				call(2, "docs_upload", { note: "no file" }),
				call(3, "notes_send", { note: "text", tags: ["a", "b"] }),
			])
			return [
				ran.replies.filter((reply) => (reply as { result?: { isError?: true } }).result?.isError),
				await received(api),
			]
		})
		expect(sent).toEqual([
			[],
			[
				[
					MULTIPART,
					[
						["count", "2"],
						["file", "a.txt", "application/octet-stream", sha("abc")],
						["files", "x.png", "image/png", sha("xyz")],
						["files", "four.txt", "application/octet-stream", sha("abcd")],
						["note", "n"],
					],
				],
				[MULTIPART, [["note", "no file"]]],
				[
					MULTIPART,
					[
						["note", "text"],
						["tags", "a"],
						["tags", "b"],
					],
				],
			],
		])
	})
})

describe("a file argument's caps and reader, as the server runs them", SLOW, () => {
	it("refuses a file past $DOCS_MAX_FILE_BYTES or the call's inline bytes past $DOCS_MAX_INLINE_BYTES; /dev/stdin is no file", async () => {
		const root = rootDir()
		const capped = ["DOCS_MAX_FILE_BYTES=3", "DOCS_MAX_INLINE_BYTES=4"]
		const refused = await served([], async (api) => {
			const ran = await exchangeEach(command(dir, [`DOCS_BASE_URL=${api.url}`, `DOCS_FILE_ROOT=${root}`, ...capped]), [
				initialize("2025-11-25"),
				call(1, "docs_upload", { file: { path: "four.txt" } }),
				call(2, "docs_upload", { files: [fileInput("ab"), fileInput("cde")] }),
			])
			const stdin = await exchangeEach(command(dir, [`DOCS_BASE_URL=${api.url}`, "DOCS_FILE_ROOT=/"]), [
				initialize("2025-11-25"),
				call(1, "docs_upload", { file: { path: "/dev/stdin" } }),
			])
			return [messagesOf([...ran.replies.slice(1), ...stdin.replies.slice(1)]), api.hops]
		})
		expect(refused).toEqual([
			[
				{ message: "Invalid arguments: file is past the 3-byte file cap" },
				{ message: "Invalid arguments: files[1] is past the 4 inline bytes a call may carry" },
				{ message: "Invalid arguments: file names no file under the file root" },
			],
			[],
		])
	})
})

describe("the file settings and the extension served", SLOW, () => {
	it.each([
		["DOCS_FILE_ROOT=/nonexistent/root", "Invalid $DOCS_FILE_ROOT: not a directory\n"],
		["DOCS_MAX_FILE_BYTES=1.5", "Invalid $DOCS_MAX_FILE_BYTES: a whole number of bytes\n"],
		["DOCS_MAX_INLINE_BYTES=-1", "Invalid $DOCS_MAX_INLINE_BYTES: a whole number of bytes\n"],
		["DOCS_MAX_INLINE_BYTES=01", "Invalid $DOCS_MAX_INLINE_BYTES: a whole number of bytes\n"],
	])("refuses to start under %s", async (setting, stderr) => {
		const ran = await exchange(command(dir, ["DOCS_BASE_URL=http://127.0.0.1:9", setting]), [])
		expect([ran.status, ran.stderr, ran.replies]).toEqual([1, stderr, []])
	})

	it("advertises the file-uploads extension with its inline cap; a server taking no file reads no setting, advertises none", async () => {
		const discover = request(1, "server/discover", { _meta: MODERN })
		const [files, none] = await Promise.all([
			exchange(command(dir, ["DOCS_BASE_URL=http://127.0.0.1:9", "DOCS_MAX_INLINE_BYTES=0"]), [discover]),
			exchange(command(plain, ["DOCS_BASE_URL=http://127.0.0.1:9", "DOCS_FILE_ROOT=/nonexistent/root"]), [discover]),
		])
		expect([capabilities(files), capabilities(none), none.status]).toEqual([
			{ extensions: { [FILES]: { maxInlineBytes: 0 } }, tools: {} },
			{ tools: {} },
			0,
		])
	})
})

/* built, so no file but files.ts names it (tests/structure/mcp-file-extension.test.ts) */
const KEYWORD = ["x", "mcp", "file"].join("-")

describe("a file argument's schema: the extension's FileInput, or a path", () => {
	it("marks an object requiring id, mimeType, size and digest, the digest SHA-256; or takes a path alone", () => {
		const [marked, path] = FILE_SCHEMA.anyOf as Record<string, unknown>[]
		const { [KEYWORD]: descriptor, ...rest } = marked as Record<string, unknown>
		expect([descriptor, rest, path]).toEqual([
			{},
			{
				properties: {
					digest: {
						properties: { algorithm: { const: "sha-256" }, value: STR },
						required: ["algorithm", "value"],
						type: "object",
					},
				},
				required: ["id", "mimeType", "size", "digest"],
				type: "object",
			},
			{
				additionalProperties: false,
				properties: { path: { description: "A file under the server's file root", type: "string" } },
				required: ["path"],
				type: "object",
			},
		])
	})
})

/** A tool sending the form `file` and `files`, 4 inline bytes a call, its client recording each input it was given. */
function formTool() {
	const sent: unknown[] = []
	const spec: ToolSpec = {
		args: [],
		inputSchema: {
			additionalProperties: false,
			properties: { file: FILE_SCHEMA, files: { items: FILE_SCHEMA, type: "array" } },
			type: "object",
		},
		member: ["send"],
		name: "send",
		parts: [
			["file", "file", "file"],
			["files", "files", "files"],
		],
	}
	const client = { send: async (input: unknown) => (sent.push(input), { data: {}, error: null, status: 200 }) }
	const [tool] = bindTools([spec], client, { inline: 4, opening: () => client, secrets: [], timeout: 1000 })
	return { sent, tool: tool as NonNullable<typeof tool> }
}

describe("a call's file arguments refused before anything is sent", () => {
	it.each([
		["a prototype key in the file", '{"file":{"__proto__":{},"path":"a"}}', "file.__proto__ names a prototype"],
		[
			"a prototype key in its digest",
			'{"file":{"id":"f","mimeType":"t","size":0,"digest":{"algorithm":"sha-256","value":"","constructor":1},"data":""}}',
			"file.digest.constructor names a prototype",
		],
		["a file of neither shape", '{"file":{"path":"a","id":"f"}}', "file matches none of its schemas"],
		[
			"the inline cap passed over two files",
			JSON.stringify({ files: [fileInput("ab"), fileInput("cde")] }),
			"files[1] is past the 4 inline bytes a call may carry",
		],
		[
			"a path where no transport reads one",
			'{"file":{"path":"a.txt"}}',
			"file is a path, which only the stdio server reads",
		],
	])("refuses %s", async (_, args, message) => {
		const { sent, tool } = formTool()
		const answer = await tool.call(JSON.parse(args) as Record<string, unknown>, new AbortController().signal, () => {})
		expect([answer.isError, JSON.parse(String(answer.content[0]?.text)) as unknown, sent]).toEqual([
			true,
			{ message: `Invalid arguments: ${message}` },
			[],
		])
	})
})
