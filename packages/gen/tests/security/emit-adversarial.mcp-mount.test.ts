/**
 * MCP mounted in the app (bit 21 e), the runtime's mounted handler fed Requests in process over a recording dispatch.
 * Only the headers the security schemes name ride each inner request, to the app's own origin alone: a call that
 * would leave it is refused before any dispatch, the credential with it. An inner 401 is the endpoint's HTTP 401 with
 * the inner challenge (the scheme's when it names none), a 403 for insufficient_scope its 403, never a tool's result;
 * any other status stays the tool's, its status in `_meta`. A credential is scrubbed from every result.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { type MountConfig, mountedMcp } from "../../src/runtime/mcp/mount.ts"
import { codeOf, MODERN, modernHeaders, META, posting, read, resultOf } from "./mcp-http.ts"

const URL_MCP = "https://app.example/mcp"
const KEY = "ApiKey ak_0123456789abcdef"

/** Each inner request as dispatched: its URL and every header it carries. */
const dispatched: { url: string; headers: Record<string, string> }[] = []

/** The app, in process: `/api/v1/<what>` answers by `what`; `who` echoes the credential, 401 without one. */
async function dispatch(request: Request): Promise<Response> {
	dispatched.push({ headers: Object.fromEntries(request.headers), url: request.url })
	const what = new URL(request.url).pathname.replace("/api/v1/", "")
	const credential = request.headers.get("authorization")
	if (what === "scoped")
		return new Response(null, { headers: { "www-authenticate": 'Bearer error="insufficient_scope"' }, status: 403 })
	if (what === "forbidden") return Response.json({ message: "no" }, { status: 403 })
	if (what === "bare") return new Response(null, { status: 401 })
	if (credential === null)
		return new Response(null, { headers: { "www-authenticate": 'ApiKey realm="app"' }, status: 401 })
	return Response.json({ credential })
}

/** An SDK client of the shape the TS SDK's is: each member fetches through the config, `away` off the origin. */
const client = (config: MountConfig) => {
	const call = async (url: string, signal?: AbortSignal) => {
		const response = await config.fetch(url, { signal })
		const data = (await response.text()) || null
		const parsed = data === null ? null : (JSON.parse(data) as unknown)
		return response.ok
			? { data: parsed, error: undefined, response, status: response.status }
			: { data: null, error: parsed, response, status: response.status }
	}
	return {
		api: {
			away: ({ signal }: { signal?: AbortSignal }) => call("https://elsewhere.example/api/v1/who", signal),
			get: ({ params, signal }: { params: { what: string }; signal?: AbortSignal }) =>
				call(`${config.baseURL}/v1/${params.what}`, signal),
		},
	}
}

const tool = (name: string, member: string, args: [string, "params", string][] = []) => ({
	args,
	inputSchema: {
		additionalProperties: false,
		properties: Object.fromEntries(args.map(([property]) => [property, { type: "string" }])),
		type: "object",
	},
	member: ["api", member],
	name,
})

const handler = mountedMcp({
	challenge: "ApiKey",
	client,
	credentials: ["authorization", "x-api-key"],
	info: { name: "mounted", version: "1.0.0" },
	secured: true,
	server: "/api",
	specs: [tool("get", "get", [["what", "params", "what"]]), tool("away", "away")],
})

const post = posting((request) => handler.fetch(request, { dispatch }), URL_MCP)

/** A modern tools/call of `name` with `args`, `headers` beside its own. */
const call = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
	post(
		{ id: 1, jsonrpc: "2.0", method: "tools/call", params: { _meta: META, arguments: args, name } },
		{ ...modernHeaders(name), ...headers },
	).then(read)

beforeEach(() => void (dispatched.length = 0))

describe("the mounted handler's credential (bit 21 e)", () => {
	it("carries only the headers the schemes name onto each inner request, under the app's server path", async () => {
		const answer = await call(
			"get",
			{ what: "who" },
			{ authorization: KEY, cookie: "session=s1", "x-api-key": "k-1", "x-trace": "t-1" },
		)
		const [inner] = dispatched
		expect([
			codeOf(answer),
			inner?.url,
			inner?.headers.authorization,
			inner?.headers["x-api-key"],
			inner?.headers.cookie,
			inner?.headers["x-trace"],
		]).toEqual([[200, undefined], "https://app.example/api/v1/who", KEY, "k-1", undefined, undefined])
	})

	it("scrubs the credential, as sent and as its bare token, from a result that echoes it", async () => {
		const answer = await call("get", { what: "who" }, { authorization: KEY })
		expect([answer.text.includes("ak_0123456789abcdef"), resultOf(answer)]).toEqual([
			false,
			[undefined, { credential: "[redacted]" }],
		])
	})

	it("refuses a call off the app's origin before any dispatch, so no credential leaves it", async () => {
		const answer = await call("away", {}, { authorization: KEY })
		const [isError, error] = resultOf(answer)
		expect([codeOf(answer), isError, (error as { kind: string }).kind, dispatched]).toEqual([
			[200, undefined],
			true,
			"transport",
			[],
		])
	})
})

describe("the mounted handler's inner 401 and 403 (bit 21 e)", () => {
	it("answers HTTP 401 with the inner challenge when the inner route refuses the credential", async () => {
		const answer = await call("get", { what: "who" })
		expect([answer.status, answer.headers.get("www-authenticate"), answer.text]).toEqual([
			401,
			'ApiKey realm="app"',
			"",
		])
	})

	it("names the scheme's challenge when the inner 401 names none, in either era", async () => {
		const legacy = await post({
			id: 1,
			jsonrpc: "2.0",
			method: "tools/call",
			params: { arguments: { what: "bare" }, name: "get" },
		}).then(read)
		const modern = await call("get", { what: "bare" }, { authorization: KEY })
		expect([legacy, modern].map((answer) => [answer.status, answer.headers.get("www-authenticate")])).toEqual([
			[401, "ApiKey"],
			[401, "ApiKey"],
		])
	})

	it("answers HTTP 403 with its challenge for insufficient_scope, and leaves any other 403 the tool's result", async () => {
		const scoped = await call("get", { what: "scoped" }, { authorization: KEY })
		const forbidden = await call("get", { what: "forbidden" }, { authorization: KEY })
		const meta = (forbidden.json?.result as { _meta?: Record<string, unknown> } | undefined)?._meta
		expect([
			[scoped.status, scoped.headers.get("www-authenticate")],
			[forbidden.status, resultOf(forbidden)[0], meta?.["honey/status"]],
		]).toEqual([
			[403, 'Bearer error="insufficient_scope"'],
			[200, true, 403],
		])
	})

	it("answers tools/list with no dispatch, and says whether it is secured and the challenge it names", async () => {
		const answer = await post(
			{ id: 1, jsonrpc: "2.0", method: "tools/list", params: { _meta: META } },
			{ "mcp-method": "tools/list", "mcp-protocol-version": MODERN },
		).then(read)
		const tools = (answer.json?.result as { tools: { name: string }[] } | undefined)?.tools.map((each) => each.name)
		expect([answer.status, tools, dispatched, handler.secured, handler.challenge]).toEqual([
			200,
			["get", "away"],
			[],
			true,
			"ApiKey",
		])
	})
})
