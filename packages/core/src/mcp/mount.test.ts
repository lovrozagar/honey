import { join } from "node:path"
import { describe, expect, expectTypeOf, it } from "vitest"
import { written } from "../../../gen/src/emit/mcp/__fixtures__/written.ts"
import { generateMcpHandler } from "../../../gen/src/emit/mcp/mounted.ts"
import { bodyLimit } from "../input/body-limit.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { generateOpenApi } from "../openapi/generate.ts"
import { honey } from "../routing/app.ts"
import { type McpHandler, mcp } from "./mount.ts"

const KEY = "ApiKey ak_1"
const SCHEMES = {
	apiKey: { description: "Format: ApiKey {key}", in: "header", name: "Authorization", type: "apiKey" },
}
const ACCEPT = "application/json, text/event-stream"

type Env = { readonly REGION?: string }

/** A shop: `orders.create` requires `ApiKey ak_1` (401 with its challenge otherwise); each request it saw, recorded. */
function shop(secured = true) {
	const seen: { authorization: string | null; region: string | null; trace: string | null; url: string }[] = []
	const app = honey<Env>()
	app
		.post("/v1/orders")
		.meta({ mcp: true, ...(secured ? { security: [{ apiKey: [] }] } : {}) })
		.handler((ctx) => {
			const authorization = ctx.req.headers.get("authorization")
			seen.push({
				authorization,
				region: ctx.env.REGION ?? null,
				trace: ctx.req.headers.get("x-trace"),
				url: ctx.req.url,
			})
			if (secured && authorization !== KEY)
				return ctx.res.raw(new Response(null, { headers: { "www-authenticate": 'ApiKey realm="shop"' }, status: 401 }))
			return ctx.res.json("ok", { ok: true })
		})
	return { app, seen }
}

/** `app`'s mcpHandler, as the plugin writes it from the app's own document, imported. */
async function handlerOf(app: Parameters<typeof generateOpenApi>[0]): Promise<McpHandler> {
	const document = generateOpenApi(app, { info: { title: "Shop", version: "1.0.0" }, securitySchemes: SCHEMES })
	const { entry, files } = generateMcpHandler(document as unknown as Record<string, unknown>)
	const dir = written({
		"mcp.gen.ts": entry,
		...Object.fromEntries(Object.entries(files).map(([name, text]) => [`mcp/${name}`, text])),
	})
	return ((await import(join(dir, "mcp.gen.ts"))) as { mcpHandler: McpHandler }).mcpHandler
}

/** A 2025-11-25 JSON-RPC request to `path`: `method` with `params`, `headers` beside a conforming client's. */
const rpc = (method: string, params: object = {}, headers: Record<string, string> = {}, path = "/mcp") =>
	new Request(`https://shop.example${path}`, {
		body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
		headers: { accept: ACCEPT, "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...headers },
		method: "POST",
	})
const ORDER = ["tools/call", { arguments: {}, name: "post_v1_orders" }] as const

/** A response's status, challenge and JSON-RPC result. */
async function read(response: Response) {
	const text = await response.text()
	const result = text === "" ? undefined : (JSON.parse(text) as { result?: Record<string, unknown> }).result
	return { challenge: response.headers.get("www-authenticate"), result, status: response.status }
}

describe("mcp(app, path, handler) auth (bit 21 e, R4)", () => {
	it("refuses an unauthenticated tools/list on a secured mount, 401 with the scheme's challenge, before any dispatch", async () => {
		const { app, seen } = shop()
		const handler = await handlerOf(app)
		const checked: (string | null)[] = []
		mcp(app, "/mcp", handler, {
			authenticate: (request) => {
				checked.push(request.headers.get("authorization"))
				return request.headers.get("authorization") === KEY
			},
		})
		const refused = await read(await app.fetch(rpc("tools/list"), {}))
		const listed = await read(await app.fetch(rpc("tools/list", {}, { authorization: KEY }), {}))
		expect([refused, listed.status, checked, seen]).toEqual([
			{ challenge: "ApiKey", result: undefined, status: 401 },
			200,
			[null, KEY],
			[],
		])
	})

	it("throws at mount when a tool requires a credential and no authenticate is given, naming the fix", async () => {
		const { app } = shop()
		const handler = await handlerOf(app)
		expect(() => mcp(app, "/mcp", handler)).toThrow(
			"mcp(/mcp): its tools require a credential, so it needs authenticate: (request, ctx) => boolean, run on every request before any call",
		)
	})
})

describe("mcp(app, path, handler) auth (bit 21 e, R4), continued (2)", () => {
	it("mounts an app whose tools require no credential without authenticate", async () => {
		const { app, seen } = shop(false)
		const handler = await handlerOf(app)
		expect(() => mcp(app, "/mcp", handler)).not.toThrow()
		const called = await read(await app.fetch(rpc(...ORDER), { REGION: "eu" }))
		expect([handler.secured, called.status, called.result?._meta, seen.map((each) => each.region)]).toEqual([
			false,
			200,
			{ "honey/status": 200 },
			["eu"],
		])
	})

	it("reaches the API with the credential alone, in process with the request's env, the authenticate check passed", async () => {
		const { app, seen } = shop()
		mcp(app, "/mcp", await handlerOf(app), { authenticate: (request) => request.headers.has("authorization") })
		const called = await read(
			await app.fetch(rpc(...ORDER, { authorization: KEY, cookie: "s=1", "x-trace": "t" }), { REGION: "eu" }),
		)
		expect([called.status, called.result?._meta, seen]).toEqual([
			200,
			{ "honey/status": 200 },
			[{ authorization: KEY, region: "eu", trace: null, url: "https://shop.example/v1/orders" }],
		])
	})

	it("answers HTTP 401 with the inner challenge when the inner route rejects the credential authenticate passed", async () => {
		const { app } = shop()
		mcp(app, "/mcp", await handlerOf(app), { authenticate: () => true })
		expect(await read(await app.fetch(rpc(...ORDER, { authorization: "ApiKey wrong" }), {}))).toEqual({
			challenge: 'ApiKey realm="shop"',
			result: undefined,
			status: 401,
		})
	})
})

describe("mcp(app, path, handler) auth (bit 21 e, R4), continued (3)", () => {
	it("hands authenticate the request and the route's ctx, its env too", async () => {
		const { app } = shop()
		const regions: unknown[] = []
		mcp(app, "/mcp", await handlerOf(app), {
			authenticate: (_, ctx) => {
				regions.push(ctx.env.REGION, ctx.req.url)
				return false
			},
		})
		await app.fetch(rpc("tools/list"), { REGION: "us" })
		expect(regions).toEqual(["us", "https://shop.example/mcp"])
	})

	it("types authenticate's ctx as the handle's own: its env, and what its middleware adds", async () => {
		const { app } = shop()
		const handler = await handlerOf(app)
		const seen: unknown[] = []
		mcp(app.use(createMiddleware((_ctx, next) => next({ tenant: "t-1" }))), "/mcp", handler, {
			authenticate: (_, ctx) => {
				expectTypeOf(ctx.env).toEqualTypeOf<Env>()
				expectTypeOf(ctx.tenant).toEqualTypeOf<string>()
				// @ts-expect-error a binding the app's env does not declare
				seen.push(ctx.env.DB, ctx.env.REGION, ctx.tenant)
				return false
			},
		})
		await app.fetch(rpc("tools/list"), { REGION: "eu" })
		expect(seen).toEqual([undefined, "eu", "t-1"])
	})
})

describe("mcp(app, path, handler) routes (bit 21 e)", () => {
	it("serves POST under the handle's basePath and middleware, GET and DELETE 405, and options the handler's", async () => {
		const { app } = shop(false)
		const handler = await handlerOf(app)
		const ran: string[] = []
		const v1 = app
			.basePath("/v1")
			.use(createMiddleware(async (ctx, next) => (ran.push(new URL(ctx.req.url).pathname), next())))
		mcp(v1, "/mcp", handler, { authenticate: () => true, maxBodyBytes: 64, origins: ["https://chat.example"] })
		const big = await app.fetch(rpc("tools/list", { pad: "x".repeat(100) }, {}, "/v1/mcp"), {})
		const foreign = await app.fetch(rpc("tools/list", {}, { origin: "https://evil.example" }, "/v1/mcp"), {})
		const listed = await app.fetch(rpc("tools/list", {}, { origin: "https://chat.example" }, "/v1/mcp"), {})
		const others = await Promise.all(
			["GET", "DELETE"].map((method) => app.fetch(new Request("https://shop.example/v1/mcp", { method }), {})),
		)
		expect([
			[big.status, foreign.status, listed.status],
			others.map((response) => [response.status, response.headers.get("allow")]),
			ran,
		]).toEqual([
			[413, 403, 200],
			[
				[405, "POST"],
				[405, "POST"],
			],
			["/v1/mcp", "/v1/mcp", "/v1/mcp", "/v1/mcp", "/v1/mcp"],
		])
	})
})

describe("mcp(app, path, handler) under the app's bodyLimit (bit 21 h)", () => {
	it("refuses a body past the app's bodyLimit with its 413 before the endpoint reads it, chunked or declared", async () => {
		const { app, seen } = shop(false)
		const handler = await handlerOf(app)
		mcp(app.use(bodyLimit({ maxSize: 64 })), "/mcp", handler)
		const body = JSON.stringify({
			id: 1,
			jsonrpc: "2.0",
			method: ORDER[0],
			params: { ...ORDER[1], pad: "x".repeat(100) },
		})
		const headers = { accept: ACCEPT, "content-type": "application/json", "mcp-protocol-version": "2025-11-25" }
		const chunked = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body))
				controller.close()
			},
		})
		const answers = await Promise.all(
			[body, chunked].map((sent) =>
				app.fetch(
					new Request("https://shop.example/mcp", {
						body: sent,
						duplex: "half",
						headers,
						method: "POST",
					} as RequestInit),
					{},
				),
			),
		)
		const keys = await Promise.all(
			answers.map(async (answer) => [answer.status, (await answer.text()).includes("content_too_large")]),
		)
		expect([keys, seen]).toEqual([
			[
				[413, true],
				[413, true],
			],
			[],
		])
	})
})

describe("mcp(app, path, handler) routes (bit 21 e), continued (2)", () => {
	it("keeps its routes out of the document and the tool set, even under a handle whose meta opts every route in", async () => {
		const { app } = shop(false)
		const handler = await handlerOf(app)
		mcp(app.meta({ mcp: true }), "/mcp", handler, { authenticate: () => true })
		const document = generateOpenApi(app, { info: { title: "Shop", version: "1.0.0" } })
		const { entry } = generateMcpHandler(document as unknown as Record<string, unknown>)
		const tools = entry.match(/name: "\w+_\w+"/g)
		expect([Object.keys(document.paths ?? {}), tools]).toEqual([["/v1/orders"], ['name: "post_v1_orders"']])
	})

	it("refuses a path with a parameter, and a taken path before registering any of its routes", async () => {
		const { app } = shop(false)
		const handler = await handlerOf(app)
		app.get("/taken").handler((ctx) => ctx.res.text("ok", "taken"))
		const refusals = [() => mcp(app, "/mcp/:id", handler), () => mcp(app, "/taken", handler)].map((mount) => {
			try {
				mount()
				return "mounted"
			} catch (error) {
				return (error as Error).message
			}
		})
		const posted = await app.fetch(rpc("tools/list", {}, {}, "/taken"), {})
		expect([refusals, posted.status, posted.headers.get("allow")]).toEqual([
			["cannot serve MCP at /mcp/:id: its path is fixed, with no parameter", "Duplicate route: GET /taken"],
			405,
			"GET",
		])
	})
})

describe("@lovrozagar/honey/mcp (bit 21 e, R8)", () => {
	it("ships mcp from its own subpath, never the root, so an app serving no MCP bundles none of it", async () => {
		const root = await import("../index.ts")
		const { exports } = (await import("../../package.json", { with: { type: "json" } })).default
		expect([Object.keys(root).filter((name) => /mcp/i.test(name)), exports["./mcp"]["honey-source"]]).toEqual([
			[],
			"./src/mcp/mount.ts",
		])
	})
})
