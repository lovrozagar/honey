/**
 * The OAuth legs' world (bit 21 f), all on loopback ports the OS picks: a stub authorization server (RFC 8414 metadata,
 * an authorization endpoint that approves at once and redirects with `code`, `state` and `iss`, a token endpoint that
 * checks PKCE S256 and the RFC 8707 `resource` in both requests) and an orders app whose MCP endpoint is a resource
 * server: `mcp(app, "/mcp", handler, { oauth })`. Its routes check the token themselves, its audience the endpoint:
 * listing needs `orders:read`, creating `orders:write` (a 403 step-up challenge otherwise). Every request either
 * server answers is logged in order, so a leg reads the whole discovery, token and step-up sequence off it.
 */
import { createHash, randomBytes } from "node:crypto"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { written } from "../../../../gen/src/emit/mcp/__fixtures__/written.ts"
import { generateMcpHandler } from "../../../../gen/src/emit/mcp/mounted.ts"
import { type HoneyServer, serve } from "../../../src/adapters/node/serve.ts"
import { type McpHandler, mcp } from "../../../src/mcp/mount.ts"
import { oauth } from "../../../src/mcp/oauth.ts"
import { generateOpenApi } from "../../../src/openapi/generate.ts"
import { honey } from "../../../src/routing/app.ts"
import * as z from "zod"

/** The client the stub authorization server knows, pre-registered, and where it sends the user back. */
export const CLIENT_ID = "honey-client"
export const REDIRECT_URI = "http://127.0.0.1/callback"

/** The world running: the MCP endpoint, the issuer, the log of every request answered, and its stop. */
export type OAuthWorld = {
	readonly endpoint: string
	readonly issuer: string
	readonly log: readonly string[]
	stop(): Promise<void>
}

type Token = { readonly audience: string; readonly scope: readonly string[] }
type Grant = {
	readonly challenge: string
	readonly redirect: string
	readonly resource: string
	readonly scope: string
}

const SCHEMES = {
	oauth: {
		flows: {
			authorizationCode: {
				authorizationUrl: "https://issuer.invalid/authorize",
				scopes: { "orders:read": "list orders", "orders:write": "create orders" },
				tokenUrl: "https://issuer.invalid/token",
			},
		},
		type: "oauth2",
	},
}

/** A server answering `fetch` on a loopback port the OS picks: its origin. */
async function listening(servers: HoneyServer[], fetch: (request: Request) => Promise<Response>): Promise<string> {
	const server = serve({ fetch }, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((settle) => server.once("listening", settle))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** `fetch` logging each answer as `<who> <method> <path> <status>`. */
const logged =
	(log: string[], who: string, fetch: (request: Request) => Promise<Response>) => async (request: Request) => {
		const answer = await fetch(request)
		log.push(`${who} ${request.method} ${new URL(request.url).pathname} ${answer.status}`)
		return answer
	}

/** PKCE's S256 of `verifier` (RFC 7636 §4.2). */
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url")

/** The stub authorization server's RFC 8414 metadata. */
const metadataOf = (issuer: string) =>
	Response.json({
		authorization_endpoint: `${issuer}/authorize`,
		authorization_response_iss_parameter_supported: true,
		code_challenge_methods_supported: ["S256"],
		grant_types_supported: ["authorization_code"],
		issuer,
		response_types_supported: ["code"],
		token_endpoint: `${issuer}/token`,
		token_endpoint_auth_methods_supported: ["none"],
	})

/** The authorization endpoint: approves the registered client's S256 request at once, redirecting with a code. */
function authorize(query: URLSearchParams, issuer: string, grants: Map<string, Grant>, log: string[]): Response {
	const resource = query.get("resource") ?? ""
	const scope = query.get("scope") ?? ""
	log.push(`as authorize scope=${scope} resource=${resource} method=${query.get("code_challenge_method")}`)
	if (query.get("client_id") !== CLIENT_ID || query.get("code_challenge_method") !== "S256")
		return new Response(null, { status: 400 })
	const code = randomBytes(12).toString("hex")
	const redirect = query.get("redirect_uri") ?? ""
	grants.set(code, { challenge: query.get("code_challenge") ?? "", redirect, resource, scope })
	const back = new URL(redirect)
	back.search = new URLSearchParams({ code, iss: issuer, state: query.get("state") ?? "" }).toString()
	return new Response(null, { headers: { location: back.href }, status: 302 })
}

/** The token endpoint: a code once, its PKCE verifier, the same resource and redirect as its authorization. */
function issue(form: URLSearchParams, grants: Map<string, Grant>, tokens: Map<string, Token>, log: string[]): Response {
	const code = form.get("code") ?? ""
	const grant = grants.get(code)
	grants.delete(code)
	const resource = form.get("resource") ?? ""
	const pkce = grant !== undefined && s256(form.get("code_verifier") ?? "") === grant.challenge
	log.push(`as token resource=${resource} pkce=${pkce}`)
	if (!pkce || grant.resource !== resource || grant.redirect !== form.get("redirect_uri"))
		return Response.json({ error: "invalid_grant" }, { status: 400 })
	const issued = randomBytes(16).toString("hex")
	tokens.set(issued, { audience: resource, scope: grant.scope.split(" ") })
	return Response.json({ access_token: issued, expires_in: 3600, scope: grant.scope, token_type: "Bearer" })
}

/** The stub authorization server at `issuer()`: metadata, authorize, token; every token it issues kept in `tokens`. */
function authorizationServer(issuer: () => string, tokens: Map<string, Token>, log: string[]) {
	const grants = new Map<string, Grant>()
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url)
		if (url.pathname === "/.well-known/oauth-authorization-server") return metadataOf(issuer())
		if (url.pathname === "/authorize") return authorize(url.searchParams, issuer(), grants, log)
		if (url.pathname === "/token" && request.method === "POST")
			return issue(new URLSearchParams(await request.text()), grants, tokens, log)
		return new Response(null, { status: 404 })
	}
}

/** The orders app, its routes checking the token (audience `endpoint()`) and the scope each needs. */
function ordersApp(endpoint: () => string, tokens: Map<string, Token>) {
	const app = honey()
	/** The refusal of `request` for `needed`, or undefined when its token carries it. */
	const refused = (request: Request, needed: string) => {
		const token = tokens.get(/^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "")
		if (token === undefined || token.audience !== endpoint())
			return new Response(null, { headers: { "www-authenticate": 'Bearer error="invalid_token"' }, status: 401 })
		if (token.scope.includes(needed)) return undefined
		const challenge = `Bearer error="insufficient_scope", scope="orders:read ${needed}"`
		return new Response(null, { headers: { "www-authenticate": challenge }, status: 403 })
	}
	app
		.get("/orders")
		.meta({ mcp: true, security: [{ oauth: ["orders:read"] }] })
		.output({ "application/json": { ok: z.object({ orders: z.array(z.string()) }) } })
		.handler((ctx) => {
			const refusal = refused(ctx.req, "orders:read")
			return refusal ? ctx.res.raw(refusal) : ctx.res.json("ok", { orders: ["o-1"] })
		})
	app
		.post("/orders")
		.meta({ mcp: true, security: [{ oauth: ["orders:write"] }] })
		.output({ "application/json": { created: z.object({ created: z.string() }) } })
		.handler((ctx) => {
			const refusal = refused(ctx.req, "orders:write")
			return refusal ? ctx.res.raw(refusal) : ctx.res.json("created", { created: "o-2" })
		})
	return app
}

/** The orders app's mcpHandler, as the plugin writes it from the app's own document, imported. */
async function handlerOf(app: ReturnType<typeof honey>): Promise<McpHandler> {
	const document = generateOpenApi(app, { info: { title: "Orders", version: "1.0.0" }, securitySchemes: SCHEMES })
	const { entry, files } = generateMcpHandler(document as unknown as Record<string, unknown>)
	const dir = written({
		"mcp.gen.ts": entry,
		...Object.fromEntries(Object.entries(files).map(([name, text]) => [`mcp/${name}`, text])),
	})
	return ((await import(join(dir, "mcp.gen.ts"))) as { mcpHandler: McpHandler }).mcpHandler
}

/** The stub authorization server and the orders app, listening. */
export async function startOAuthWorld(): Promise<OAuthWorld> {
	const servers: HoneyServer[] = []
	const log: string[] = []
	const tokens = new Map<string, Token>()
	let issuer = ""
	let origin = ""
	const endpoint = () => `${origin}/mcp`
	issuer = await listening(
		servers,
		logged(
			log,
			"as",
			authorizationServer(() => issuer, tokens, log),
		),
	)
	const app = ordersApp(endpoint, tokens)
	mcp(app, "/mcp", await handlerOf(app), {
		/* the endpoint takes any token issued for it; each route checks the scope it needs */
		authenticate: (request) =>
			tokens.get(/^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "")?.audience === endpoint(),
		oauth: oauth({ authorizationServers: [issuer], resourceName: "Orders", scopesSupported: ["orders:read"] }),
	})
	origin = await listening(
		servers,
		logged(log, "app", (request) => Promise.resolve(app.fetch(request, {}))),
	)
	return {
		endpoint: endpoint(),
		issuer,
		log,
		stop: async () => void (await Promise.all(servers.map((server) => server.shutdown(0)))),
	}
}
