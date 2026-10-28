/**
 * The file-uploads extension's upload flow and URL values on the mounted handler (bit 21 g), the runtime alone, in
 * process: a stub of the mount's uploads (deterministic tokens, bytes from a map) and of its URL fetch. A 2026-07-28
 * call declaring the extension, with a FileInput without data, answers the draft's input request (PR head 6101d34,
 * :200-240), one `omit` target a data-less file and its tokens as requestState, nothing sent; its retry takes each
 * file's bytes once and sends them. Every malformed retry is invalid params; a failed upload, a rule a take resolves, a
 * repeated id or a malformed FileInput is the tool's error. A `{url}` value is fetched under the call's signal, or
 * shown and taken nowhere without a fetch.
 */
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import type { ToolSpec } from "../../src/runtime/mcp/call.ts"
import type { FetchFile, Uploads } from "../../src/runtime/mcp/files.ts"
import { type Mount, mountedMcp } from "../../src/runtime/mcp/mount.ts"
import { type Answer, codeOf, META, MODERN, modernHeaders, posting, read } from "./mcp-http.ts"

const URL_MCP = "https://app.example/mcp"
const BASE = "https://app.example/mcp/uploads"
/* built, so no file but runtime/mcp/files.ts names the identifier, nor any but emit/mcp/files.ts the keyword */
const EXTENSION = ["io.modelcontextprotocol", "files"].join("/")
const KEYWORD = ["x", "mcp", "file"].join("-")
const DECLARED = { ...META, "io.modelcontextprotocol/clientCapabilities": { extensions: { [EXTENSION]: {} } } }
const HEADERS = { authorization: "ApiKey k-1", "x-api-key": "x-1", "x-trace": "t-1" }
const CREDENTIAL = "authorization: ApiKey k-1\nx-api-key: x-1"

const FILE = {
	anyOf: [
		{
			type: "object",
			[KEYWORD]: {},
			properties: {
				digest: {
					type: "object",
					properties: { algorithm: { const: "sha-256" }, value: { type: "string" } },
					required: ["algorithm", "value"],
				},
			},
			required: ["id", "mimeType", "size", "digest"],
		},
		{
			type: "object",
			properties: { url: { type: "string", description: "An https URL the server fetches" } },
			required: ["url"],
			additionalProperties: false,
		},
	],
}

const spec = (name: string, file: object = FILE): ToolSpec => ({
	args: [],
	inputSchema: {
		additionalProperties: false,
		properties: { file, files: { items: file, type: "array" }, note: { type: "string" } },
		type: "object",
	},
	member: ["docs", "upload"],
	name,
	parts: [
		["file", "file", "file"],
		["files", "files", "files"],
		["note", "note", "text"],
	],
})

/** What the SDK stub was sent: each call's multipart body and headers. */
const sent: { body: Uint8Array; headers: Record<string, string> }[] = []
/** Each issue and take the uploads stub saw. */
/* an upload's call and file, as the mount hands them over */
type UploadScope = Parameters<Uploads["issue"]>[0]
type Declared = Parameters<Uploads["issue"]>[1]

const issued: [UploadScope, Declared][] = []
const taken: [UploadScope, Declared, string][] = []
/** The bytes each token's upload left. */
const stored = new Map<string, Uint8Array>()
/** Each fetch the URL stub saw: its URL and signal. */
const fetched: [string, AbortSignal][] = []

const client = () => ({
	docs: {
		upload: async (input: { body: Uint8Array; headers: Record<string, string> }) => {
			sent.push(input)
			return { data: { ok: true }, error: undefined, response: new Response("{}"), status: 200 }
		},
	},
})

const handler = mountedMcp({
	challenge: "ApiKey",
	client,
	credentials: ["authorization", "x-api-key"],
	info: { name: "uploads", version: "1.0.0" },
	secured: false,
	server: "/api",
	specs: [spec("upload"), spec("loose", { anyOf: [{ type: "object" }] })],
})

const uploads: Uploads = {
	base: BASE,
	issue: async (scope, file) => {
		issued.push([scope, file])
		return `tok-${file.id}`
	},
	max: 1000,
	take: async (scope, file, token) => {
		taken.push([scope, file, token])
		if (!token.startsWith("tok-")) throw new Error("requestState holds no upload token of this app's")
		return stored.get(token) ?? "was not uploaded"
	},
}

const fetchFile: FetchFile = async (url, signal) => {
	fetched.push([url, signal])
	if (url.endsWith("/refused")) throw new Error("answered 404")
	return { bytes: new TextEncoder().encode("fetched"), name: "f.csv", type: "text/csv" }
}

const mount = (extra: Partial<Mount> = {}): Mount => ({
	dispatch: async () => new Response(null, { status: 500 }),
	uploads,
	...extra,
})

const digestOf = (text: string) => createHash("sha256").update(text).digest("base64url")

/** `text` as a FileInput of `id` without data: an upload asked for. */
const pending = (text: string, id: string) => ({
	digest: { algorithm: "sha-256", value: digestOf(text) },
	id,
	mimeType: "text/plain",
	name: `${id}.txt`,
	size: new TextEncoder().encode(text).length,
})
/** `text` as a FileInput of `id` inline. */
const inline = (text: string, id: string) => ({ ...pending(text, id), data: btoa(text) })

/** A tools/call of `name` with `args` and `params` beside, modern and declaring the extension; `meta` null: 2025-11-25. */
function call(
	args: Record<string, unknown>,
	params: Record<string, unknown> = {},
	{ meta = DECLARED as object | null, name = "upload", with: extra = {} as Partial<Mount> } = {},
) {
	const headers = meta ? modernHeaders(name) : { "mcp-protocol-version": "2025-11-25" }
	const post = posting((request) => handler.fetch(request, mount(extra)), URL_MCP)
	return post(
		{
			id: 1,
			jsonrpc: "2.0",
			method: "tools/call",
			params: { ...(meta && { _meta: meta }), arguments: args, name, ...params },
		},
		{ ...headers, ...HEADERS },
	).then(read)
}

/** An answer's JSON-RPC result. */
const resultOf = (answer: Answer) => (answer.json as { result: unknown }).result

/** The tool error an answer carries, its text parsed: the message. */
const errorOf = (answer: Awaited<ReturnType<typeof call>>) => {
	const result = answer.json?.result as { content: { text: string }[]; isError?: boolean }
	return [result.isError, (JSON.parse(result.content[0]?.text as string) as { message: string }).message]
}

/** The JSON-RPC error an answer carries. */
const rpcErrorOf = (answer: Awaited<ReturnType<typeof call>>) => [
	...codeOf(answer),
	((answer.json as { error: { message: string } }).error as { message: string }).message,
]

/** The form the SDK stub was sent `at`: each part's name, file name, type and SHA-256, or its text. */
async function formOf(at = 0) {
	const input = sent[at] as (typeof sent)[number]
	const form = await new Request("https://app.example/", {
		body: input.body as Uint8Array<ArrayBuffer>,
		headers: input.headers,
		method: "POST",
	}).formData()
	return Promise.all(
		[...form].map(async ([name, value]) =>
			typeof value === "string"
				? [name, value]
				: [
						name,
						value.name,
						value.type,
						createHash("sha256")
							.update(await value.bytes())
							.digest("base64url"),
					],
		),
	)
}

/** The retry's params: `state`, and `files` as the upload outcomes. */
const retry = (state: string, files: unknown, resultType: unknown = "complete") => ({
	inputResponses: { uploads: { files, resultType } },
	requestState: state,
})
const completed = (...ids: string[]) => ids.map((fileId) => ({ fileId, status: "completed" }))

beforeEach(() => {
	for (const list of [sent, issued, taken, fetched]) list.length = 0
	stored.clear()
})

describe("the upload input request (bit 21 g, draft :200-240)", () => {
	it("answers one omit target a data-less file, its tokens the requestState, 200, nothing sent", async () => {
		const args = { file: pending("abc", "a"), files: [inline("xy", "b"), pending("hello", "c")], note: "n" }
		const answer = await call(args)
		expect([answer.status, answer.json?.result, sent.length, issued]).toEqual([
			200,
			{
				inputRequests: {
					uploads: {
						method: `${EXTENSION}/upload`,
						params: {
							files: [
								{ credentials: "omit", fileId: "a", url: `${BASE}/tok-a` },
								{ credentials: "omit", fileId: "c", url: `${BASE}/tok-c` },
							],
						},
					},
				},
				requestState: "tok-a tok-c",
				resultType: "input_required",
			},
			0,
			[
				[
					{ args, credential: CREDENTIAL, tool: "upload" },
					{ digest: digestOf("abc"), id: "a", size: 3 },
				],
				[
					{ args, credential: CREDENTIAL, tool: "upload" },
					{ digest: digestOf("hello"), id: "c", size: 5 },
				],
			],
		])
	})

	it("asks for none under 2025-11-25 or a request not declaring the extension, nor on a mount without uploads", async () => {
		const asked = [
			await call({ file: pending("abc", "a") }, {}, { meta: null }),
			await call({ file: pending("abc", "a") }, {}, { meta: META }),
			await call({ file: pending("abc", "a") }, {}, { with: { uploads: undefined } }),
		]
		const needs = `Invalid arguments: file has no data, and an upload needs a 2026-07-28 request declaring ${EXTENSION}`
		expect([asked.map(errorOf), issued.length, sent.length]).toEqual([
			[
				[true, needs],
				[true, needs],
				[true, "Invalid arguments: file has no data, and no upload is served here"],
			],
			0,
			0,
		])
	})
})

describe("the upload input request (bit 21 g, draft :200-240), continued (2)", () => {
	it.each([
		["a repeated file id", { file: pending("abc", "a"), files: [inline("xy", "a")] }, "a file id repeats"],
		[
			"a digest of no SHA-256 form",
			{ file: { ...pending("abc", "a"), digest: { algorithm: "sha-256", value: "short" } } },
			"file needs a whole size within the 1000-byte upload cap and a SHA-256",
		],
		[
			"a digest holding a dot",
			{ file: { ...pending("abc", "a"), digest: { algorithm: "sha-256", value: `${"a".repeat(42)}.` } } },
			"file needs a whole size within the 1000-byte upload cap and a SHA-256",
		],
		[
			"a size of no whole number",
			{ file: { ...pending("abc", "a"), size: 1.5 } },
			"file needs a whole size within the 1000-byte upload cap and a SHA-256",
		],
		[
			"a negative size",
			{ file: { ...pending("abc", "a"), size: -1 } },
			"file needs a whole size within the 1000-byte upload cap and a SHA-256",
		],
		[
			"a size past the upload cap",
			{ file: { ...pending("abc", "a"), size: 1001 } },
			"file needs a whole size within the 1000-byte upload cap and a SHA-256",
		],
	])("refuses %s as the tool's error, asking for nothing", async (_, args, message) => {
		const answer = await call(args)
		expect([errorOf(answer), issued.length, sent.length]).toEqual([[true, `Invalid arguments: ${message}`], 0, 0])
	})
})

describe("the retry (draft :290-330)", () => {
	it("takes each file's bytes once by its token and sends them intact beside the inline ones", async () => {
		stored.set("tok-a", new TextEncoder().encode("abc"))
		stored.set("tok-c", new TextEncoder().encode("hello"))
		const args = { file: pending("abc", "a"), files: [inline("xy", "b"), pending("hello", "c")], note: "n" }
		const answer = await call(args, retry("tok-a tok-c", completed("c", "a")))
		const scope = { args, credential: CREDENTIAL, tool: "upload" }
		expect([answer.status, (resultOf(answer) as { isError?: true }).isError, await formOf(), taken]).toEqual([
			200,
			undefined,
			[
				["file", "a.txt", "text/plain", digestOf("abc")],
				["files", "b.txt", "text/plain", digestOf("xy")],
				["files", "c.txt", "text/plain", digestOf("hello")],
				["note", "n"],
			],
			[
				[scope, { digest: digestOf("abc"), id: "a", size: 3 }, "tok-a"],
				[scope, { digest: digestOf("hello"), id: "c", size: 5 }, "tok-c"],
			],
		])
	})

	it.each([
		["a resultType not complete", retry("tok-a", completed("a"), "cancel")],
		["no inputResponses", { requestState: "tok-a" }],
		["a missing outcome", retry("tok-a tok-c", completed("a"))],
		["an unknown fileId", retry("tok-a", completed("z"))],
		["an unknown status", retry("tok-a", [{ fileId: "a", status: "done" }])],
		["a requestState of the wrong token count", retry("tok-a tok-x", completed("a"))],
		["a requestState that is no string", retry(7 as unknown as string, completed("a"))],
	])("refuses %s as invalid params, taking and sending nothing", async (_, params) => {
		const answer = await call({ file: pending("abc", "a") }, params)
		expect([rpcErrorOf(answer), taken.length, sent.length]).toEqual([
			[200, -32602, "Invalid params: requestState and inputResponses.uploads answer no upload this call asked for"],
			0,
			0,
		])
	})
})

describe("the retry (draft :290-330), continued (2)", () => {
	it.each([
		["a repeated outcome", [...completed("a"), ...completed("a")]],
		["an outcome of no object", ["a"]],
		["a null outcome", [null]],
	])("refuses %s as invalid params", async (_, files) => {
		const answer = await call({ file: pending("abc", "a") }, retry("tok-a", files))
		expect([rpcErrorOf(answer), taken.length, sent.length]).toEqual([
			[200, -32602, "Invalid params: requestState and inputResponses.uploads answer no upload this call asked for"],
			0,
			0,
		])
	})

	it("refuses a token the take rejects as invalid params with its message", async () => {
		const answer = await call({ file: pending("abc", "a") }, retry("forged", completed("a")))
		expect([rpcErrorOf(answer), sent.length]).toEqual([
			[200, -32602, "Invalid params: requestState holds no upload token of this app's"],
			0,
		])
	})

	it("answers a failed upload as the tool's error, never taking or sending", async () => {
		stored.set("tok-a", new TextEncoder().encode("abc"))
		const answer = await call({ file: pending("abc", "a") }, retry("tok-a", [{ fileId: "a", status: "failed" }]))
		expect([errorOf(answer), taken.length, sent.length]).toEqual([
			[true, "Invalid arguments: file failed to upload"],
			0,
			0,
		])
	})

	it("answers a rule the take resolves as the tool's error, naming the list item", async () => {
		stored.set("tok-a", new TextEncoder().encode("abc"))
		const answer = await call(
			{ files: [pending("abc", "a"), pending("hello", "c")] },
			retry("tok-a tok-c", completed("a", "c")),
		)
		expect([errorOf(answer), sent.length]).toEqual([[true, "Invalid arguments: files[1] was not uploaded"], 0])
	})
})

describe("prototype keys in the upload flow", () => {
	it("round-trips a file id __proto__, refuses an outcome __proto__ for another file, and pollutes nothing", async () => {
		stored.set("tok-__proto__", new TextEncoder().encode("abc"))
		const asked = await call({ file: pending("abc", "__proto__") })
		const done = await call({ file: pending("abc", "__proto__") }, retry("tok-__proto__", completed("__proto__")))
		const refused = await call({ file: pending("abc", "f") }, retry("tok-f", completed("__proto__")))
		const crafted = await call(
			{ file: pending("abc", "f") },
			JSON.parse(
				'{"inputResponses":{"uploads":{"__proto__":{"files":[]},"resultType":"complete"}},"requestState":"tok-f"}',
			) as Record<string, unknown>,
		)
		expect([
			(resultOf(asked) as { requestState: string }).requestState,
			(resultOf(done) as { isError?: true }).isError,
			await formOf(),
			rpcErrorOf(refused)[2],
			rpcErrorOf(crafted)[2],
			Object.keys(Object.prototype),
			({} as Record<string, unknown>).files,
		]).toEqual([
			"tok-__proto__",
			undefined,
			[["file", "__proto__.txt", "text/plain", digestOf("abc")]],
			"Invalid params: requestState and inputResponses.uploads answer no upload this call asked for",
			"Invalid params: requestState and inputResponses.uploads answer no upload this call asked for",
			[],
			undefined,
		])
	})
})

/** tools/list on a mount given `extra`. */
const list = (extra: Partial<Mount>) =>
	posting((request) => handler.fetch(request, mount(extra)), URL_MCP)(
		{ id: 2, jsonrpc: "2.0", method: "tools/list", params: { _meta: META } },
		{ "mcp-method": "tools/list", "mcp-protocol-version": MODERN },
	).then(read)
/** How many values the first tool's file argument, and its files array's items, show on a mount given `extra`. */
const shapes = async (extra: Partial<Mount>) => {
	const { tools } = resultOf(await list(extra)) as {
		tools: {
			name: string
			inputSchema: { properties: Record<string, { anyOf?: object[]; items?: { anyOf: object[] } }> }
		}[]
	}
	const { file, files } = (tools[0] as (typeof tools)[number]).inputSchema.properties
	return [file?.anyOf?.length, files?.items?.anyOf.length]
}

describe("a file argument's URL value (bit 21 g, R6)", () => {
	it("fetches it under the call's signal and sends its bytes, name and type", async () => {
		const answer = await call({ file: { url: "https://files.example/f.csv" } }, {}, { with: { fetchFile } })
		expect([
			(resultOf(answer) as { isError?: true }).isError,
			fetched.map(([url, signal]) => [url, signal instanceof AbortSignal]),
			await formOf(),
		]).toEqual([
			undefined,
			[["https://files.example/f.csv", true]],
			[["file", "f.csv", "text/csv", digestOf("fetched")]],
		])
	})

	it("answers the fetch's refusal as the tool's error, sending nothing", async () => {
		const answer = await call({ files: [{ url: "https://files.example/refused" }] }, {}, { with: { fetchFile } })
		expect([errorOf(answer), sent.length]).toEqual([[true, "Invalid arguments: files[0] answered 404"], 0])
	})

	it("shows the url value only with a fetch, and without one the guard refuses it", async () => {
		const refused = await call({ file: { url: "https://files.example/f.csv" } }, {}, { with: {} })
		expect([await shapes({ fetchFile }), await shapes({}), errorOf(refused)[0], fetched.length, sent.length]).toEqual([
			[2, 2],
			[1, 1],
			true,
			0,
			0,
		])
	})

	it("refuses a URL where the mount fetches none, and a path on any mount", async () => {
		const answers = [
			await call({ file: { url: "https://files.example/f.csv" } }, {}, { name: "loose" }),
			await call({ file: { path: "a.txt" } }, {}, { name: "loose", with: { fetchFile } }),
		]
		expect([answers.map(errorOf), sent.length]).toEqual([
			[
				[true, "Invalid arguments: file is a URL, which this server fetches none of"],
				[true, "Invalid arguments: file is a path, which only the stdio server reads"],
			],
			0,
		])
	})
})

describe("the mounted handler's advertisement (bit 21 g, R5)", () => {
	it("advertises the extension with its 1 MiB inline cap in both eras when a tool takes a file", async () => {
		const post = posting((request) => handler.fetch(request, mount()), URL_MCP)
		const discover = await post(
			{ id: 1, jsonrpc: "2.0", method: "server/discover", params: { _meta: META } },
			{ "mcp-method": "server/discover", "mcp-protocol-version": MODERN },
		).then(read)
		const initialize = await post({
			id: 1,
			jsonrpc: "2.0",
			method: "initialize",
			params: { capabilities: {}, clientInfo: { name: "c", version: "1" }, protocolVersion: "2025-11-25" },
		}).then(read)
		const advertised = { extensions: { [EXTENSION]: { maxInlineBytes: 1_048_576 } }, tools: {} }
		expect([
			(resultOf(discover) as { capabilities: unknown }).capabilities,
			(resultOf(initialize) as { capabilities: unknown }).capabilities,
		]).toEqual([advertised, advertised])
	})
})
