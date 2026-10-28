/**
 * The URL file fetch's corpus (bit 21 g, R6): `urlFiles(options)` against a file host on a loopback port the OS picks,
 * reached through the `fetch` option, which maps each listed https host onto it (path, redirect mode and signal kept)
 * and records every request the host gets. Nothing leaves the machine: every redirect points at the loopback host or
 * is relative, and no `.test` name is ever resolved. Each guard has its leg: the exact host list (and its wildcard),
 * https alone, no redirect followed to any host, the size counted as the body streams, the time, a non-200; no
 * credential of the MCP request reaches the host. Then through the mount itself: the real pipeline (core's document,
 * gen's mounted handler, `mcp()`), a `{url}` file reaching the route intact in both eras, and a mount without the
 * fetch showing no `{url}` value and refusing one.
 */
import { createHash } from "node:crypto"
import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as z from "zod"
import { written } from "../../../../gen/src/emit/mcp/__fixtures__/written.ts"
import { type McpHandler, mcp } from "../../../src/mcp/mount.ts"
import { urlFiles } from "../../../src/mcp/url-files.ts"
import { generateOpenApi } from "../../../src/openapi/generate.ts"
import { honey } from "../../../src/routing/app.ts"
import { generateMcpHandler } from "../../../../gen/src/emit/mcp/mounted.ts"

const CSV = "a,b\n1,2\n"
const CAP = 64 * 1024
const CHUNK = 16 * 1024
/* far past the cap, and past what a socket buffers, so a body read whole is told from one cut early */
const CHUNKS = 1024

/** Each request the file host got: the host it was for, its path, and its headers. */
const requests: { host: string; path: string; headers: Record<string, unknown> }[] = []
/** How many chunks the chunked body wrote before its reader went away, and whether it wrote them all. */
const chunked = { written: 0, whole: false }

let server: Server
let origin = ""

/** Write `CHUNKS` chunks with no Content-Length, stopping as soon as the reader closes. */
async function stream(response: ServerResponse) {
	response.writeHead(200, { "content-type": "application/octet-stream" })
	const reader = { closed: false }
	response.once("close", () => (reader.closed = true))
	for (let at = 0; at < CHUNKS && !reader.closed; at++) {
		chunked.written++
		if (!response.write(Buffer.alloc(CHUNK, 7))) await new Promise((drained) => response.once("drain", drained))
		await new Promise((next) => setImmediate(next))
	}
	chunked.whole = !reader.closed
	response.end()
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://local")
		requests.push({ headers: request.headers, host: String(request.headers["x-for-host"]), path: url.pathname })
		const sized = Number(url.searchParams.get("n"))
		switch (url.pathname) {
			case "/ok":
			case "/files/report.csv":
				return void response.writeHead(200, { "content-type": "text/csv" }).end(CSV)
			case "/bare":
				return void response.writeHead(200).end(CSV)
			case "/exact":
				return void response.writeHead(200).end(Buffer.alloc(sized, 1))
			case "/away":
				return void response.writeHead(302, { location: `${origin}/evil` }).end()
			case "/relative":
				return void response.writeHead(302, { location: "/ok" }).end()
			case "/chunked":
				return void stream(response)
			case "/slow":
				/* headers now, the body never: the clock is the only end */
				response.writeHead(200, { "content-type": "text/plain" })
				return void response.write("a")
			case "/evil":
				return void response.writeHead(200).end("evil")
			default:
				return void response.writeHead(404).end()
		}
	})
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
	server.closeAllConnections()
	await new Promise((closed) => server.close(closed))
})

beforeEach(() => {
	requests.length = 0
	Object.assign(chunked, { whole: false, written: 0 })
})

/** The `fetch` option: any https host onto the file host, its path, redirect mode and signal kept, its host named. */
const local = (request: Request) => {
	const url = new URL(request.url)
	return fetch(`${origin}${url.pathname}${url.search}`, {
		headers: { ...Object.fromEntries(request.headers), "x-for-host": url.host },
		redirect: request.redirect,
		signal: request.signal,
	})
}

const HOSTS = ["files.test", "files.test:8443", "*.cdn.test"]
const fetchFile = urlFiles({ fetch: local, hosts: HOSTS, maxBytes: CAP, timeoutMs: 100 })

/** What the fetch makes of `url`: the file's type, name and text, or its refusal. */
async function got(url: string, fetcher = fetchFile): Promise<string> {
	try {
		const file = await fetcher(url, new AbortController().signal)
		return `${file.type} ${file.name ?? "-"} ${new TextDecoder().decode(file.bytes).slice(0, 16)}`
		/* the refusal is the leg's value */
	} catch (error) {
		return (error as Error).message
	}
}

describe("urlFiles: the host list is exact (R6)", () => {
	it("fetches a listed host, and refuses a subdomain, a look-alike and a suffix of it", async () => {
		expect(
			await Promise.all(
				[
					"https://files.test/ok",
					"https://sub.files.test/ok",
					"https://evilfiles.test/ok",
					"https://files.test.evil.test/ok",
				].map((url) => got(url)),
			),
		).toEqual([
			"text/csv ok a,b\n1,2\n",
			"is on sub.files.test, a host this server fetches no file from",
			"is on evilfiles.test, a host this server fetches no file from",
			"is on files.test.evil.test, a host this server fetches no file from",
		])
		expect(requests.map(({ host, path }) => `${host}${path}`)).toEqual(["files.test/ok"])
	})

	it("takes `*.cdn.test` for a host under cdn.test alone; a port listed is its own host", async () => {
		expect(
			await Promise.all(
				[
					"https://a.cdn.test/ok",
					"https://b.a.cdn.test/ok",
					"https://cdn.test/ok",
					"https://acdn.test/ok",
					"https://a.cdn.test:8443/ok",
					"https://files.test:8443/ok",
					"https://files.test:9443/ok",
					"https://files.test:443/ok",
				].map((url) => got(url)),
			),
		).toEqual([
			"text/csv ok a,b\n1,2\n",
			"text/csv ok a,b\n1,2\n",
			"is on cdn.test, a host this server fetches no file from",
			"is on acdn.test, a host this server fetches no file from",
			"is on a.cdn.test:8443, a host this server fetches no file from",
			"text/csv ok a,b\n1,2\n",
			"is on files.test:9443, a host this server fetches no file from",
			"text/csv ok a,b\n1,2\n",
		])
	})
})

describe("urlFiles: no IP address is a listed host (R6)", () => {
	it("refuses an IP address in any form the URL parser reads, none being listed", async () => {
		expect(
			await Promise.all(
				[
					"https://2130706433/ok",
					"https://0x7f.0.0.1/ok",
					"https://0177.0.0.1/ok",
					"https://[::1]/ok",
					"https://[::ffff:127.0.0.1]/ok",
				].map((url) => got(url)),
			),
		).toEqual([
			"is on 127.0.0.1, a host this server fetches no file from",
			"is on 127.0.0.1, a host this server fetches no file from",
			"is on 127.0.0.1, a host this server fetches no file from",
			"is on [::1], a host this server fetches no file from",
			"is on [::ffff:7f00:1], a host this server fetches no file from",
		])
		expect(requests).toEqual([])
	})
})

describe("urlFiles: https alone, and no redirect followed (R6)", () => {
	it("refuses http, userinfo and no URL at all, fetching nothing", async () => {
		expect(
			await Promise.all(
				["http://files.test/ok", "https://user:pass@files.test/ok", "https://user@files.test/ok", "not a url"].map(
					(url) => got(url),
				),
			),
		).toEqual(Array(4).fill("is no https URL, or carries userinfo"))
		expect(requests).toEqual([])
	})

	it("follows no redirect, to a host off the list or back to its own", async () => {
		expect([await got("https://files.test/away"), await got("https://files.test/relative")]).toEqual([
			"answered 302, a redirect, which is never followed",
			"answered 302, a redirect, which is never followed",
		])
		expect(requests.map(({ path }) => path)).toEqual(["/away", "/relative"])
	})
})

describe("urlFiles: the size streamed, the time, the answer's own type and name (R6)", () => {
	it("refuses a non-200 answer", async () => {
		expect(await got("https://files.test/missing")).toBe("answered 404")
	})

	it("takes exactly maxBytes, and refuses one byte past it", async () => {
		expect([
			await got(`https://files.test/exact?n=${CAP}`),
			await got(`https://files.test/exact?n=${CAP + 1}`),
		]).toEqual([
			"application/octet-stream exact \u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001\u0001",
			`is past the ${CAP}-byte cap`,
		])
	})

	it("counts a body with no Content-Length as it streams, cutting it off past maxBytes", async () => {
		expect(await got("https://files.test/chunked")).toBe(`is past the ${CAP}-byte cap`)
		await new Promise((settled) => setTimeout(settled, 100))
		expect([chunked.whole, chunked.written < CHUNKS]).toEqual([false, true])
	})

	it("refuses a body past maxBytes whose Content-Length says it fits, counting what streams", async () => {
		let pulled = 0
		const lying = urlFiles({
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						/* past the cap by four chunks, then the end: a reader trusting the length takes it all */
						pull: (controller) =>
							void (++pulled > CAP / CHUNK + 4 ? controller.close() : controller.enqueue(new Uint8Array(CHUNK))),
					}),
					{ headers: { "content-length": "8", "content-type": "text/plain" } },
				),
			hosts: HOSTS,
			maxBytes: CAP,
		})
		expect([await got("https://files.test/lying", lying), pulled <= CAP / CHUNK + 2]).toEqual([
			`is past the ${CAP}-byte cap`,
			true,
		])
	})

	it("refuses a body still coming past timeoutMs, headers and body together", async () => {
		const started = performance.now()
		const refused = await got("https://files.test/slow")
		expect([refused, performance.now() - started < 2000]).toEqual(["took longer than 100 ms", true])
	})

	it("hands back the answer's type, else octet-stream, and the URL's last segment as the name", async () => {
		expect([await got("https://files.test/files/report.csv"), await got("https://files.test/bare")]).toEqual([
			"text/csv report.csv a,b\n1,2\n",
			"application/octet-stream bare a,b\n1,2\n",
		])
	})
})

const MODERN = "2026-07-28"
const META = {
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/protocolVersion": MODERN,
}
const ACCEPT = "application/json, text/event-stream"
const TOOL = "post_v1_docs"

/** The app: POST /v1/docs takes a file and a note, answering the file's name, size, type and SHA-256. */
function docs() {
	const app = honey()
	app
		.post("/v1/docs")
		.meta({ mcp: true })
		.input({ form: z.object({ file: z.file(), note: z.string().optional() }) })
		.output({
			"application/json": {
				ok: z.object({ name: z.string(), note: z.string(), sha256: z.string(), size: z.number(), type: z.string() }),
			},
		})
		.handler(async (ctx) => {
			const { file, note } = ctx.input.form
			const sha256 = createHash("sha256")
				.update(new Uint8Array(await file.arrayBuffer()))
				.digest("hex")
			return ctx.res.json("ok", { name: file.name, note: note ?? "", sha256, size: file.size, type: file.type })
		})
	return app
}

let handler: McpHandler

beforeAll(async () => {
	const document = generateOpenApi(docs(), { info: { title: "Docs", version: "1.0.0" } })
	const { entry, files } = generateMcpHandler(document as unknown as Record<string, unknown>)
	const dir = written({
		"mcp.gen.ts": entry,
		...Object.fromEntries(Object.entries(files).map(([name, text]) => [`mcp/${name}`, text])),
	})
	handler = ((await import(join(dir, "mcp.gen.ts"))) as { mcpHandler: McpHandler }).mcpHandler
})

/** A request to the mount: modern (its `_meta` and three headers) or legacy 2025-11-25. */
function rpc(method: string, params: Record<string, unknown>, modern: boolean, headers: Record<string, string> = {}) {
	const own = modern
		? {
				"mcp-method": method,
				"mcp-protocol-version": MODERN,
				...(method === "tools/call" && { "mcp-name": String(params.name) }),
			}
		: { "mcp-protocol-version": "2025-11-25" }
	return new Request("https://shop.example/mcp", {
		body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: modern ? { _meta: META, ...params } : params }),
		headers: { accept: ACCEPT, "content-type": "application/json", ...own, ...headers },
		method: "POST",
	})
}

type Answer = { result?: { content?: { text: string }[]; isError?: boolean; tools?: Record<string, unknown>[] } }

/** A tools/call's answer text, parsed, and whether it failed. */
async function called(app: ReturnType<typeof docs>, args: Record<string, unknown>, modern = true, headers = {}) {
	const answer = (await (
		await app.fetch(rpc("tools/call", { arguments: args, name: TOOL }, modern, headers), {})
	).json()) as Answer
	return [answer.result?.isError ?? false, JSON.parse(answer.result?.content?.[0]?.text ?? "null") as unknown] as const
}

/** The file argument's schema as tools/list shows it. */
async function fileSchema(app: ReturnType<typeof docs>) {
	const answer = (await (await app.fetch(rpc("tools/list", {}, true), {})).json()) as Answer
	const tool = answer.result?.tools?.find((each) => each.name === TOOL) as {
		inputSchema: { properties: { file: unknown } }
	}
	return tool.inputSchema.properties.file as { anyOf: Record<string, unknown>[] }
}

const URL_BRANCH = {
	additionalProperties: false,
	properties: { url: { description: "An https URL the server fetches", type: "string" } },
	required: ["url"],
	type: "object",
}

const SHA = createHash("sha256").update(CSV).digest("hex")

describe("a {url} file through the mount (bit 21 g, R6)", () => {
	it("fetches a listed URL into the route intact, in both eras, with no credential of the MCP request", async () => {
		const app = mcp(docs(), "/mcp", handler, { urlFiles: fetchFile })
		const secret = { authorization: "Bearer mcp-secret", cookie: "session=s1" }
		const answers = [
			await called(app, { file: { url: "https://files.test/files/report.csv" }, note: "n" }, true, secret),
			await called(app, { file: { url: "https://a.cdn.test/ok" } }, false, secret),
		]
		expect(answers).toEqual([
			[false, { name: "report.csv", note: "n", sha256: SHA, size: CSV.length, type: "text/csv" }],
			[false, { name: "ok", note: "", sha256: SHA, size: CSV.length, type: "text/csv" }],
		])
		expect(requests.map(({ headers }) => [headers.authorization, headers.cookie])).toEqual([
			[undefined, undefined],
			[undefined, undefined],
		])
	})

	it("shows the {url} value with the fetch, and refuses a guard's breach as the tool's error", async () => {
		const app = mcp(docs(), "/mcp", handler, { urlFiles: fetchFile })
		const { anyOf } = await fileSchema(app)
		expect([anyOf.length, anyOf[1]]).toEqual([2, URL_BRANCH])
		expect([
			await called(app, { file: { url: "https://evil.test/ok" } }),
			await called(app, { file: { url: "https://files.test/away" } }),
		]).toEqual([
			[true, { message: "Invalid arguments: file is on evil.test, a host this server fetches no file from" }],
			[true, { message: "Invalid arguments: file answered 302, a redirect, which is never followed" }],
		])
	})

	it("shows no {url} value without the fetch, refuses one there, and reads no path on a mount", async () => {
		const app = mcp(docs(), "/mcp", handler)
		const { anyOf } = await fileSchema(app)
		const [urlRefused, pathRefused] = [
			await called(app, { file: { url: "https://files.test/ok" } }),
			await called(app, { file: { path: "a.txt" } }),
		]
		expect([anyOf.length, (anyOf[0] as { required: unknown }).required]).toEqual([
			1,
			["id", "mimeType", "size", "digest"],
		])
		expect([urlRefused[0], pathRefused[0], JSON.stringify(urlRefused[1]).includes("file"), requests]).toEqual([
			true,
			true,
			true,
			[],
		])
	})
})
