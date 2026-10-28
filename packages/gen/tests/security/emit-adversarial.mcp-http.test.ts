/**
 * The MCP server's Streamable HTTP handler against hostile requests (bit 21 d), the runtime's own handler fed Requests
 * in process; every refusal reaches no tool. Origin: present and neither the request's own nor listed is 403, compared
 * exactly (`null`, letter case, an explicit default port, a trailing dot, userinfo, a punycode look-alike, another
 * scheme, a repeated header), before the method table. POST alone (405 with Allow), Accept naming both types (406), a
 * JSON body (415). The headers: an unserved MCP-Protocol-Version is 400 (-32022); a modern request's header against its
 * `_meta`, its Mcp-Method and Mcp-Name against its body (a `=?base64?…?=` name decoded; raw non-ASCII, another case of
 * the sentinel, no base64, no UTF-8 refused) is 400 (-32020); a modern unknown method 404. The body, files, sessions
 * and cancellation are emit-adversarial.mcp-http-body.test.ts's, the standalone listener emit-adversarial.mcp-listen's.
 */
import { domainToASCII } from "node:url"
import { describe, expect, it } from "vitest"
import { serveHttp } from "../../src/runtime/mcp/http.ts"
import { ACCEPT, codeOf, META, MODERN, modernHeaders, posting, protocol, read, seen, URL_MCP } from "./mcp-http.ts"

const handler = serveHttp(protocol, { origins: ["https://app.example"] })
const post = posting(handler)

/** A modern tools/call of `name`, with `headers` in place of its three. */
const modernCall = (name: string, headers: Record<string, string> = modernHeaders(name)) =>
	post({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { _meta: META, arguments: {}, name } }, headers)

/** A legacy tools/list under `version` (no header when undefined), beside `headers`. */
const legacyList = (version?: string, headers: Record<string, string> = {}) =>
	post(
		{ id: 1, jsonrpc: "2.0", method: "tools/list" },
		{ ...(version === undefined ? {} : { "mcp-protocol-version": version }), ...headers },
	)

/** A tools/list POST to the endpoint served at `url` from `origin`. */
const listFrom = (url: string, origin: string) =>
	posting(handler, url)({ id: 1, jsonrpc: "2.0", method: "tools/list" }, { origin })

describe("the Origin: refused", () => {
	it.each([
		["null"],
		["HTTP://127.0.0.1:8000"],
		["http://127.0.0.1"],
		["http://127.0.0.1:80"],
		["http://127.0.0.1.:8000"],
		["http://user@127.0.0.1:8000"],
		["http://localhost:8000"],
		[`http://${domainToASCII("lоcalhost")}:8000`],
		["https://127.0.0.1:8000"],
		["https://app.example/"],
		["https://APP.example"],
		["http://evil.example"],
	])("refuses the Origin %s with 403 before any tool runs", async (origin) => {
		const before = seen.length
		const answer = await modernCall("echo", { ...modernHeaders("echo"), origin })
		expect([answer.status, seen.length - before]).toEqual([403, 0])
	})

	it("refuses an Origin sent twice, even the request's own twice", async () => {
		const headers = new Headers({ accept: ACCEPT, "content-type": "application/json" })
		headers.append("origin", "http://127.0.0.1:8000")
		headers.append("origin", "http://127.0.0.1:8000")
		const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" })
		expect((await handler(new Request(URL_MCP, { body, headers, method: "POST" }))).status).toBe(403)
	})

	it("refuses a foreign Origin on GET and DELETE too, before the method table", async () => {
		const statuses = await Promise.all(
			["GET", "DELETE"].map(
				async (method) =>
					(await handler(new Request(URL_MCP, { headers: { origin: "http://evil.example" }, method }))).status,
			),
		)
		expect(statuses).toEqual([403, 403])
	})
})

describe("the Origin: served", () => {
	it("compares the default port exactly: served at port 80, its Origin has no port", async () => {
		const statuses = [(await listFrom("http://localhost/mcp", "http://localhost")).status]
		statuses.push((await listFrom("http://localhost/mcp", "http://localhost:80")).status)
		expect(statuses).toEqual([200, 403])
	})

	it("serves the request's own origin, a listed one, and a request with none", async () => {
		const statuses = await Promise.all(
			([{ origin: "http://127.0.0.1:8000" }, { origin: "https://app.example" }, {}] as Record<string, string>[]).map(
				async (headers) => (await legacyList("2025-11-25", headers)).status,
			),
		)
		expect(statuses).toEqual([200, 200, 200])
	})
})

describe("the method table, Accept and Content-Type", () => {
	it.each(["GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"])(
		"answers %s with 405, Allow: POST, in every era",
		async (method) => {
			const answers = await Promise.all(
				(
					[{}, { "mcp-protocol-version": "2025-11-25" }, { "mcp-protocol-version": MODERN }] as Record<string, string>[]
				).map((headers) => handler(new Request(URL_MCP, { headers: { accept: ACCEPT, ...headers }, method }))),
			)
			expect(answers.map((answer) => [answer.status, answer.headers.get("allow")])).toEqual(
				Array.from({ length: 3 }, () => [405, "POST"]),
			)
		},
	)

	it.each([[""], ["application/json"], ["text/event-stream"], ["*/*"], ["application/jsonx, text/event-stream"]])(
		"refuses Accept %j with 406",
		async (accept) => {
			expect((await legacyList(undefined, { accept })).status).toBe(406)
		},
	)

	it("takes Accept with parameters, spaces and in any letter case", async () => {
		const answer = await legacyList(undefined, { accept: "Application/JSON;q=0.9 , TEXT/event-stream;q=1" })
		expect(answer.status).toBe(200)
	})

	it.each([["text/plain"], ["application/x-www-form-urlencoded"], ["multipart/form-data"], ["application/jsonp"]])(
		"refuses Content-Type %s with 415",
		async (type) => {
			expect((await legacyList(undefined, { "content-type": type })).status).toBe(415)
		},
	)

	it("takes application/json with a charset", async () => {
		expect((await legacyList(undefined, { "content-type": "application/json; charset=utf-8" })).status).toBe(200)
	})
})

describe("the request headers (2026-07-28): matching", () => {
	it("serves a modern call whose three headers match its body", async () => {
		const answer = await read(await modernCall("echo"))
		expect([answer.status, (answer.json?.result as { resultType?: string } | undefined)?.resultType]).toEqual([
			200,
			"complete",
		])
	})

	it.each([
		["the version header absent", { "mcp-method": "tools/call", "mcp-name": "echo" }],
		["a legacy version against a modern _meta", { ...modernHeaders("echo"), "mcp-protocol-version": "2025-11-25" }],
		["Mcp-Method absent", { "mcp-name": "echo", "mcp-protocol-version": MODERN }],
		["Mcp-Method another method", { ...modernHeaders("echo"), "mcp-method": "tools/list" }],
		["Mcp-Method in another letter case", { ...modernHeaders("echo"), "mcp-method": "Tools/Call" }],
		["Mcp-Name absent", { "mcp-method": "tools/call", "mcp-protocol-version": MODERN }],
		["Mcp-Name another tool", modernHeaders("hold")],
		["Mcp-Name encoded as another name", modernHeaders("=?base64?aG9sZA==?=")],
		["Mcp-Name holding a control character", modernHeaders("ec\tho")],
	])("refuses %s with 400 and -32020 before any tool runs", async (_, headers) => {
		const before = seen.length
		const answer = await read(await modernCall("echo", headers))
		expect([...codeOf(answer), answer.json?.id, seen.length - before]).toEqual([400, -32020, 1, 0])
	})

	it("refuses a legacy body sent under the modern version header with -32020", async () => {
		const answer = await read(await legacyList(MODERN, { "mcp-method": "tools/list" }))
		expect(codeOf(answer)).toEqual([400, -32020])
	})

	it("serves a non-ASCII name sent encoded; refuses it raw, in another case of the sentinel, no UTF-8, no base64", async () => {
		const encoded = `=?base64?${Buffer.from("café").toString("base64")}?=`
		const names = [
			encoded,
			"café",
			encoded.replace("base64", "BASE64"),
			"=?base64?/w==?=",
			"=?base64?!!!?=",
			"=?base64?Y2Fmw6k?=",
		]
		const answers = await Promise.all(
			names.map(async (name) => codeOf(await read(await modernCall("café", modernHeaders(name))))),
		)
		expect(answers).toEqual([[200, undefined], ...Array.from({ length: 5 }, () => [400, -32020])])
	})
})

describe("the request headers: versions and methods", () => {
	it("refuses an unserved version header with 400 and -32022 naming every revision served", async () => {
		const answer = await read(await legacyList("2099-01-01"))
		expect([answer.status, answer.json?.error]).toEqual([
			400,
			{
				code: -32022,
				data: { requested: "2099-01-01", supported: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] },
				message: "Unsupported protocol version",
			},
		])
	})

	it("refuses a legacy revision claimed in _meta with 400 and -32022, and a _meta lacking capabilities with -32602", async () => {
		const legacyMeta = { ...META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" }
		const headers = { "mcp-method": "tools/list", "mcp-protocol-version": "2025-11-25" }
		const claimed = await read(
			await post({ id: 1, jsonrpc: "2.0", method: "tools/list", params: { _meta: legacyMeta } }, headers),
		)
		const bare = { "io.modelcontextprotocol/protocolVersion": MODERN }
		const capless = await read(
			await post(
				{ id: 2, jsonrpc: "2.0", method: "tools/list", params: { _meta: bare } },
				{ ...headers, "mcp-protocol-version": MODERN },
			),
		)
		expect([codeOf(claimed), codeOf(capless)]).toEqual([
			[400, -32022],
			[400, -32602],
		])
	})

	it("answers a modern method it does not serve with 404 and -32601, an unknown tool with 200 and -32602", async () => {
		const ping = { id: 1, jsonrpc: "2.0", method: "ping", params: { _meta: META } }
		const unknown = await read(await post(ping, { "mcp-method": "ping", "mcp-protocol-version": MODERN }))
		const tool = await read(await modernCall("nope"))
		expect([codeOf(unknown), codeOf(tool)]).toEqual([
			[404, -32601],
			[200, -32602],
		])
	})
})
