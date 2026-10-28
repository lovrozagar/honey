/**
 * `oauth(options)` (bit 21 f, H24.4), `@lovrozagar/honey/mcp/oauth`: the mounted MCP endpoint as an OAuth 2.1 resource
 * server, handed to `mcp(app, path, handler, { authenticate, oauth: oauth(options) })`. An ordinary import (H23), so an
 * app that mounts MCP without it bundles none of this. honey is the resource server's discovery half only: no
 * authorization server, and no token validation, which stays the app's (`authenticate`, and each route's own check).
 * `oauth()` refuses options the spec forbids; the hook it returns, called by `mcp()` at mount, refuses a `resource`
 * that is not the endpoint and serves:
 * - RFC 9728 Protected Resource Metadata at the path-inserted well-known URI (§3.1; MCP authorization-server
 *   discovery's first well-known form), `resource` the endpoint's canonical URL, a GET on the app's root under the
 *   handle's middleware, internal and served as the endpoint is;
 * - `resource_metadata` on every 401 (RFC 9728 §5.1; MCP's preferred discovery), `error="invalid_token"` when a
 *   credential came and was refused (RFC 6750 §3.1);
 * - an inner insufficient_scope as one 403 step-up challenge naming the scopes the route asked for (MCP 2026-07-28
 *   "Scope Challenge Handling"), never `offline_access` (its "Refresh Tokens").
 * The public origin is the configured `resource`'s, else the request's own: no forwarded header is trusted (H23).
 */
import type { HoneyContext } from "../context/context.ts"
import type { TypedResponse } from "../response/response.ts"
import { joinPatterns, parsePattern } from "../routing/pattern.ts"
import { assertRouteFree, GRAPH, type HandleView, type HoneyGraph, SERVED, VIEW } from "../routing/register.ts"
import { startRoute } from "../routing/route-builder.ts"
import type { McpProtectedResource } from "./mount.ts"

/** The options of `oauth()`: the resource server's metadata and where its tokens come from. */
export type McpOAuthOptions = {
	/** issuer URLs of the authorization servers whose tokens the endpoint takes; at least one (RFC 9728 §2, MCP) */
	readonly authorizationServers: readonly string[]
	/** scopes a client may ask for, offered when a 401 names none; never `offline_access` (RFC 9728 §2) */
	readonly scopesSupported?: readonly string[]
	/** the endpoint's canonical URL, for an app whose requests do not carry its public origin (behind a proxy) */
	readonly resource?: string
	/** the endpoint's name as a user sees it (RFC 9728 §2 `resource_name`) */
	readonly resourceName?: string
}

/** The handle the hook registers on, as far as it reads one. */
type Handle = { readonly [GRAPH]: HoneyGraph; readonly [VIEW]: HandleView }

/** A route's builder and its context, as far as the metadata route uses them. */
type Registering = { meta(meta: object): { handler(fn: (ctx: Ctx) => TypedResponse): unknown } }
type Ctx = HoneyContext & { readonly res: { raw(response: Response): TypedResponse } }

const WELL_KNOWN = "/.well-known/oauth-protected-resource"
/* an auth-param, its value a token or a whole quoted-string (RFC 9110 §11.2), so a quoted "scope=" is no param */
const PARAM = /([\w!#$%&'*+.^`|~-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]*)/g
/* RFC 6749 §3.3's scope-token */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/
/* OAuth asks for TLS everywhere but a loopback host, where a local server has none (RFC 8252 §8.3) */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"]

/** `value` as an OAuth party's URL: https (http on a loopback host) with no userinfo, query or fragment. */
function secure(value: string): URL | undefined {
	const url = URL.canParse(value) && !/[?#]/.test(value) ? new URL(value) : undefined
	const scheme = url?.protocol === "https:" || (url?.protocol === "http:" && LOOPBACK.includes(url.hostname))
	return scheme && url?.username === "" && url.password === "" ? url : undefined
}

/** `value` as an auth-param's quoted-string (RFC 9110 §5.6.4). */
const quoted = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`

/** The scopes a Bearer challenge names: its scope param read past every quoted string, valid tokens, once each. */
function scopesOf(challenge: string | null | undefined): string[] {
	if (!/^\s*Bearer\b/i.test(challenge ?? "")) return []
	let scope = ""
	const params = (challenge as string).matchAll(PARAM) as unknown as Iterable<[string, string, string]>
	for (const [, name, value] of params)
		if (name.toLowerCase() === "scope")
			scope = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value
	return [...new Set(scope.split(" ").filter((each) => SCOPE.test(each) && each !== "offline_access"))]
}

/** A refusal of `oauth()`'s options, saying why. */
const refuse = (why: string) => new Error(`oauth(): ${why}`)

/** Refuse `options` the spec forbids, naming the option. */
function check({ authorizationServers, scopesSupported }: McpOAuthOptions): void {
	if (authorizationServers.length === 0)
		throw refuse("authorizationServers lists no authorization server; RFC 9728 metadata needs at least one")
	for (const issuer of authorizationServers)
		if (secure(issuer) === undefined)
			throw refuse(
				`authorizationServers names ${issuer}, which is no https URL without userinfo, a query or a fragment`,
			)
	for (const scope of scopesSupported ?? []) {
		if (scope === "offline_access")
			throw refuse(
				"scopesSupported lists offline_access, a scope the authorization server grants and a resource never asks for",
			)
		if (!SCOPE.test(scope)) throw refuse(`scopesSupported lists ${JSON.stringify(scope)}, which is no scope token`)
	}
}

/** The resource-server hook for `mcp()`'s `oauth`: `options` refused now when the spec forbids them. */
export function oauth(options: McpOAuthOptions): McpProtectedResource {
	check(options)
	const { authorizationServers, resource, resourceName, scopesSupported } = options
	return (app, at) => {
		const handle = app as Handle
		const graph = handle[GRAPH]
		/* the URL a client sees: the prefix the app strips, the basePath, the path; no trailing slash, so the endpoint
		 * at the root is its bare origin (MCP "Canonical Server URI") */
		const endpoint = joinPatterns(graph.settings.stripPrefix ?? "/", joinPatterns(handle[VIEW].basePath, at))
		const tail = endpoint.replace(/\/$/, "")
		const fixed = resource === undefined ? undefined : secure(resource)
		if (resource !== undefined && fixed?.pathname.replace(/\/$/, "") !== tail)
			throw new Error(`mcp(${at}): oauth's resource ${resource} is not this endpoint's URL, whose path is ${endpoint}`)
		const path = WELL_KNOWN + tail
		assertRouteFree(graph, "GET", parsePattern(path))
		const origin = (url: string) => fixed?.origin ?? new URL(url).origin
		return {
			challenge: (request, status, inner) => {
				const error = status === 403 ? "insufficient_scope" : request.headers.has("authorization") && "invalid_token"
				const scope = scopesOf(inner).join(" ")
				const metadata = `resource_metadata=${quoted(origin(request.url) + path)}`
				const params = [error && `error=${quoted(error)}`, scope && `scope=${quoted(scope)}`]
				return `Bearer ${[...params.filter(Boolean), metadata].join(", ")}`
			},
			/* on the root, under the handle's middleware: the metadata sits beside the origin, not under the basePath */
			register: () =>
				void (
					startRoute(graph, { ...handle[VIEW], basePath: "/" }, handle, {
						extraMethods: [],
						method: "GET",
						path,
					}) as Registering
				)
					.meta({ internal: true, [SERVED]: true })
					.handler((ctx) =>
						ctx.res.raw(
							Response.json({
								resource: origin(ctx.req.url) + tail,
								authorization_servers: authorizationServers,
								...(scopesSupported && { scopes_supported: scopesSupported }),
								/* MCP sends the token in the Authorization header alone, never the query or body */
								bearer_methods_supported: ["header"],
								...(resourceName !== undefined && { resource_name: resourceName }),
							}),
						),
					),
		}
	}
}
