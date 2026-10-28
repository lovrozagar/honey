/**
 * The mounted MCP endpoint as an OAuth 2.1 resource server (bit 21 f, H24.4): `mcp(app, path, handler, { oauth })`
 * serves RFC 9728 Protected Resource Metadata at the path-inserted well-known URI, points every 401 at it, maps an inner
 * insufficient_scope to one 403 step-up challenge, and refuses at mount what the spec forbids (no authorization server,
 * offline_access, a resource that is not the endpoint). Without `oauth` nothing of it is served. The token is the MCP
 * resource's own and goes to the app's own routes in process, never off its origin. Each case is red first.
 */
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { written } from "../../../../gen/src/emit/mcp/__fixtures__/written.ts"
import { generateMcpHandler } from "../../../../gen/src/emit/mcp/mounted.ts"
import { type McpHandler, type McpOptions, mcp } from "../../../src/mcp/mount.ts"
import { generateOpenApi } from "../../../src/openapi/generate.ts"
import { honey } from "../../../src/routing/app.ts"

const ISSUER = "https://auth.example"
const READ = "Bearer read-token"
const WRITE = "Bearer write-token"
const SCHEMES = {
	oauth: {
		flows: {
			authorizationCode: {
				authorizationUrl: `${ISSUER}/authorize`,
				scopes: { "orders:read": "read", "orders:write": "write" },
				tokenUrl: `${ISSUER}/token`,
			},
		},
		type: "oauth2",
	},
}
const ACCEPT = "application/json, text/event-stream"
const NEEDED = 'Bearer error="insufficient_scope", scope="orders:read orders:write offline_access"'

/** The tokens the app's validator knows, with their scopes. */
const TOKENS: Readonly<Record<string, readonly string[]>> = {
	[READ]: ["orders:read"],
	[WRITE]: ["orders:read", "orders:write"],
}

/** A shop: `orders.create` needs `orders:write` (403 step-up without, 401 for an unknown token); requests it saw. */
function shop(challenge = NEEDED) {
	const seen: { authorization: string | null; url: string }[] = []
	const app = honey()
	app
		.post("/orders")
		.meta({ mcp: true, security: [{ oauth: ["orders:write"] }] })
		.handler((ctx) => {
			const authorization = ctx.req.headers.get("authorization")
			seen.push({ authorization, url: ctx.req.url })
			const scopes = TOKENS[authorization ?? ""]
			if (scopes === undefined)
				return ctx.res.raw(
					new Response(null, {
						headers: { "www-authenticate": 'Bearer error="invalid_token", scope="orders:read orders:write"' },
						status: 401,
					}),
				)
			if (!scopes.includes("orders:write"))
				return ctx.res.raw(new Response(null, { headers: { "www-authenticate": challenge }, status: 403 }))
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

/** The OAuth options every case starts from. */
const OAUTH = { authorizationServers: [ISSUER], resourceName: "Shop", scopesSupported: ["orders:read"] }

/** Accepts the tokens the validator knows, refusing any other before dispatch. */
const authenticate = (request: Request) => (request.headers.get("authorization") ?? "") in TOKENS

/** A JSON-RPC request to `url`: `method` with `params`, `headers` beside a conforming client's. */
const rpc = (url: string, method: string, params: object = {}, headers: Record<string, string> = {}) =>
	new Request(url, {
		body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
		headers: { accept: ACCEPT, "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...headers },
		method: "POST",
	})
const CREATE = ["tools/call", { arguments: {}, name: "post_orders" }] as const

/** A response's status, its challenge and its JSON body. */
async function read(response: Response) {
	const text = await response.text()
	return {
		body: text === "" ? undefined : (JSON.parse(text) as unknown),
		challenge: response.headers.get("www-authenticate"),
		status: response.status,
	}
}

/** The metadata `app` serves at the well-known URI with `path` inserted, read. */
const prm = (app: { fetch: (request: Request, env: object) => Response | Promise<Response> }, path: string) =>
	Promise.resolve(app.fetch(new Request(`https://shop.example/.well-known/oauth-protected-resource${path}`), {})).then(
		read,
	)

/** The message `mount` threw, or "mounted". */
function refusal(mount: () => unknown): string {
	try {
		mount()
		return "mounted"
	} catch (error) {
		return (error as Error).message
	}
}

afterEach(() => void vi.restoreAllMocks())

describe("mcp(..., { oauth }) protected resource metadata (bit 21 f, RFC 9728)", () => {
	it("serves it at the path-inserted URI, a basePath and a trailing slash folded in, the resource the endpoint", async () => {
		const { app } = shop()
		const v1 = app.basePath("/v1/")
		mcp(v1, "/mcp/", await handlerOf(app), { authenticate, oauth: OAUTH })
		const served = await read(
			await app.fetch(new Request("https://shop.example/.well-known/oauth-protected-resource/v1/mcp"), {}),
		)
		const root = await app.fetch(new Request("https://shop.example/.well-known/oauth-protected-resource"), {})
		expect([served, root.status]).toEqual([
			{
				body: {
					authorization_servers: [ISSUER],
					bearer_methods_supported: ["header"],
					resource: "https://shop.example/v1/mcp",
					resource_name: "Shop",
					scopes_supported: ["orders:read"],
				},
				challenge: null,
				status: 200,
			},
			404,
		])
	})

	it("inserts the prefix the app strips, and serves the root form only for an endpoint at the root", async () => {
		const stripped = shop()
		const strippedApp = stripped.app.stripPrefix("/api")
		mcp(strippedApp, "/mcp", await handlerOf(stripped.app), {
			authenticate,
			oauth: { authorizationServers: [ISSUER] },
		})
		const atRoot = shop()
		mcp(atRoot.app, "/", await handlerOf(atRoot.app), { authenticate, oauth: { authorizationServers: [ISSUER] } })
		expect([(await prm(strippedApp, "/api/mcp")).body, (await prm(atRoot.app, "")).body]).toEqual([
			{
				authorization_servers: [ISSUER],
				bearer_methods_supported: ["header"],
				resource: "https://shop.example/api/mcp",
			},
			{ authorization_servers: [ISSUER], bearer_methods_supported: ["header"], resource: "https://shop.example" },
		])
	})
})

describe("mcp(..., { oauth }) protected resource metadata (bit 21 f, RFC 9728), continued (2)", () => {
	it("takes the public origin from a configured resource, behind a proxy the request's own origin is not", async () => {
		const { app } = shop()
		mcp(app, "/mcp", await handlerOf(app), {
			authenticate,
			oauth: { ...OAUTH, resource: "https://Shop.Example:443/mcp/" },
		})
		const served = await read(
			await app.fetch(new Request("http://10.0.0.7:8080/.well-known/oauth-protected-resource/mcp"), {}),
		)
		const refused = await read(await app.fetch(rpc("http://10.0.0.7:8080/mcp", "tools/list"), {}))
		expect([(served.body as { resource: string }).resource, refused.challenge]).toEqual([
			"https://shop.example/mcp",
			'Bearer resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
		])
	})

	it("keeps the metadata route out of the document and the tool set, with no PRM route at all without oauth", async () => {
		const { app } = shop()
		const handler = await handlerOf(app)
		mcp(app.meta({ mcp: true }), "/mcp", handler, { authenticate, oauth: OAUTH })
		const document = generateOpenApi(app, { info: { title: "Shop", version: "1.0.0" }, securitySchemes: SCHEMES })
		const tools = generateMcpHandler(document as unknown as Record<string, unknown>).entry.match(/name: "\w+_\w+"/g)
		const plain = shop()
		mcp(plain.app, "/mcp", await handlerOf(plain.app), { authenticate })
		const absent = await plain.app.fetch(
			new Request("https://shop.example/.well-known/oauth-protected-resource/mcp"),
			{},
		)
		expect([Object.keys(document.paths ?? {}), tools, absent.status]).toEqual([
			["/orders"],
			['name: "post_orders"'],
			404,
		])
	})
})

describe("mcp(..., { oauth }) refusals at mount (bit 21 f)", () => {
	it("refuses no authorization server, offline_access, a resource that is not the endpoint, and no authenticate", async () => {
		const { app } = shop()
		const handler = await handlerOf(app)
		const mount =
			(oauth: object, options: McpOptions = { authenticate }) =>
			() =>
				mcp(honey(), "/mcp", handler, { ...options, oauth: { ...OAUTH, ...oauth } })
		expect(
			[
				mount({ authorizationServers: [] }),
				mount({ authorizationServers: ["http://auth.example"] }),
				mount({ authorizationServers: ["https://auth.example/?tenant=1"] }),
				mount({ authorizationServers: ["https://user:pw@auth.example"] }),
				mount({ scopesSupported: ["orders:read", "offline_access"] }),
				mount({ scopesSupported: ['orders "read"'] }),
				mount({ resource: "https://shop.example/other" }),
				mount({ resource: "https://shop.example/mcp#frag" }),
				mount({ resource: "http://shop.example/mcp" }),
				mount({ resource: "shop.example/mcp" }),
				mount({}, {}),
				mount({ resource: "http://127.0.0.1:8080/mcp" }),
			].map(refusal),
		).toEqual([
			"mcp(/mcp): oauth.authorizationServers lists no authorization server; RFC 9728 metadata needs at least one",
			"mcp(/mcp): oauth.authorizationServers names http://auth.example, which is no https URL without userinfo, a query or a fragment",
			"mcp(/mcp): oauth.authorizationServers names https://auth.example/?tenant=1, which is no https URL without userinfo, a query or a fragment",
			"mcp(/mcp): oauth.authorizationServers names https://user:pw@auth.example, which is no https URL without userinfo, a query or a fragment",
			"mcp(/mcp): oauth.scopesSupported lists offline_access, a scope the authorization server grants and a resource never asks for",
			'mcp(/mcp): oauth.scopesSupported lists "orders \\"read\\"", which is no scope token',
			"mcp(/mcp): oauth.resource https://shop.example/other is not this endpoint's URL, whose path is /mcp",
			"mcp(/mcp): oauth.resource https://shop.example/mcp#frag is not this endpoint's URL, whose path is /mcp",
			"mcp(/mcp): oauth.resource http://shop.example/mcp is not this endpoint's URL, whose path is /mcp",
			"mcp(/mcp): oauth.resource shop.example/mcp is not this endpoint's URL, whose path is /mcp",
			"mcp(/mcp): oauth makes it a protected resource, so it needs authenticate: (request, ctx) => boolean",
			"mounted",
		])
	})
})

describe("mcp(..., { oauth }) challenges (bit 21 f, A26)", () => {
	it("points a 401 at the metadata, invalid_token when a credential was refused, before any dispatch", async () => {
		const { app, seen } = shop()
		mcp(app, "/mcp", await handlerOf(app), { authenticate, oauth: OAUTH })
		const bare = await read(await app.fetch(rpc("https://shop.example/mcp", "tools/list"), {}))
		const wrong = await read(
			await app.fetch(rpc("https://shop.example/mcp", ...CREATE, { authorization: "Bearer forged" }), {}),
		)
		expect([bare, wrong, seen]).toEqual([
			{
				body: undefined,
				challenge: 'Bearer resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
				status: 401,
			},
			{
				body: undefined,
				challenge:
					'Bearer error="invalid_token", resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
				status: 401,
			},
			[],
		])
	})

	it("carries an inner 401's scopes as one quoted list beside the metadata", async () => {
		const { app } = shop()
		mcp(app, "/mcp", await handlerOf(app), { authenticate: () => true, oauth: OAUTH })
		const expired = await read(
			await app.fetch(rpc("https://shop.example/mcp", ...CREATE, { authorization: "Bearer expired" }), {}),
		)
		expect(expired).toEqual({
			body: undefined,
			challenge:
				'Bearer error="invalid_token", scope="orders:read orders:write", resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
			status: 401,
		})
	})
})

describe("mcp(..., { oauth }) challenges (bit 21 f, A26), continued (2)", () => {
	it("answers an inner insufficient_scope with one 403 step-up challenge, never offline_access, never a tool result", async () => {
		const tricky =
			'Bearer error_description="say \\"scope=admin\\"", error="insufficient_scope", ' +
			'scope="orders:read  orders:write orders:read offline_access bad\\\\scope"'
		const results = []
		for (const challenge of [NEEDED, tricky, "bearer error=insufficient_scope, scope=orders:write"]) {
			const { app, seen } = shop(challenge)
			mcp(app, "/mcp", await handlerOf(app), { authenticate, oauth: OAUTH })
			const answer = await read(
				await app.fetch(rpc("https://shop.example/mcp", ...CREATE, { authorization: READ }), {}),
			)
			results.push([answer.status, answer.challenge, answer.body, seen.length])
		}
		const metadata = 'resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"'
		expect(results).toEqual([
			[403, `Bearer error="insufficient_scope", scope="orders:read orders:write", ${metadata}`, undefined, 1],
			[403, `Bearer error="insufficient_scope", scope="orders:read orders:write", ${metadata}`, undefined, 1],
			[403, `Bearer error="insufficient_scope", scope="orders:write", ${metadata}`, undefined, 1],
		])
	})

	it("leaves the challenges as they were without oauth, and an Origin refusal a plain 403", async () => {
		const { app } = shop()
		const handler = await handlerOf(app)
		mcp(app, "/mcp", handler, { authenticate })
		const bare = await read(await app.fetch(rpc("https://shop.example/mcp", "tools/list"), {}))
		const scoped = await read(await app.fetch(rpc("https://shop.example/mcp", ...CREATE, { authorization: READ }), {}))
		const guarded = shop()
		mcp(guarded.app, "/mcp", handler, { authenticate, oauth: OAUTH })
		const foreign = await read(
			await guarded.app.fetch(
				rpc("https://shop.example/mcp", "tools/list", {}, { authorization: READ, origin: "https://evil.example" }),
				{},
			),
		)
		expect([bare.challenge, scoped.challenge, foreign]).toEqual([
			handler.challenge,
			NEEDED,
			{ body: undefined, challenge: null, status: 403 },
		])
	})
})

describe("mcp(..., { oauth }) no token passthrough (bit 21 f, SC26)", () => {
	it("sends the resource's own token to the app's own route in process, and nothing over the network", async () => {
		const { app, seen } = shop()
		mcp(app, "/mcp", await handlerOf(app), { authenticate, oauth: OAUTH })
		/* refused, not called through: a passthrough would be recorded, never sent */
		const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("no network in this leg"))
		const called = await read(await app.fetch(rpc("https://shop.example/mcp", ...CREATE, { authorization: WRITE }), {}))
		const result = (called.body as { result: { _meta: unknown; content: { text: string }[] } }).result
		expect([called.status, result._meta, seen, network.mock.calls]).toEqual([
			200,
			{ "honey/status": 200 },
			[{ authorization: WRITE, url: "https://shop.example/orders" }],
			[],
		])
	})
})
