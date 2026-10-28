/**
 * The mounted MCP endpoint as an OAuth 2.1 resource server (bit 21 f, H24.4), opt-in through `mcp(..., { oauth })`.
 * honey is the resource server's discovery half only: no authorization server, and no token validation, which stays
 * the app's (`authenticate`, and each route's own check). What it serves:
 * - RFC 9728 Protected Resource Metadata at the path-inserted well-known URI (§3.1; MCP authorization-server
 *   discovery's first well-known form), `resource` the endpoint's canonical URL;
 * - `resource_metadata` on every 401 (RFC 9728 §5.1; MCP's preferred discovery), `error="invalid_token"` when a
 *   credential came and was refused (RFC 6750 §3.1);
 * - an inner insufficient_scope as one 403 step-up challenge naming the scopes the route asked for (MCP 2026-07-28
 *   "Scope Challenge Handling"), never `offline_access` (its "Refresh Tokens").
 * The public origin is the configured `resource`'s, else the request's own: no forwarded header is trusted (H23).
 */

/** The opt-in OAuth 2.1 resource-server role of a mounted endpoint. */
export type McpOAuth = {
	/** issuer URLs of the authorization servers whose tokens the endpoint takes; at least one (RFC 9728 §2, MCP) */
	readonly authorizationServers: readonly string[]
	/** scopes a client may ask for, offered when a 401 names none; never `offline_access` (RFC 9728 §2) */
	readonly scopesSupported?: readonly string[]
	/** the endpoint's canonical URL, for an app whose requests do not carry its public origin (behind a proxy) */
	readonly resource?: string
	/** the endpoint's name as a user sees it (RFC 9728 §2 `resource_name`) */
	readonly resourceName?: string
}

/** The resource-server half a mount serves: its metadata route, its document, its challenges. */
export type ProtectedResource = {
	/** where the metadata is served: the well-known prefix, then the endpoint's public path */
	readonly path: string
	/** the metadata document as the request at `url` sees it */
	readonly metadata: (url: string) => Record<string, unknown>
	/** the challenge of a `status` (401 or 403) refusal of `request`, the route's own `inner` challenge carried over */
	readonly challenge: (request: Request, status: number, inner?: string | null) => string
}

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

/** The resource server of an endpoint at public path `endpoint` (`at`, its mount path, names it in a refusal). */
export function protectedResource(oauth: McpOAuth, endpoint: string, at: string): ProtectedResource {
	const { authorizationServers, resource, resourceName, scopesSupported } = oauth
	const refuse = (why: string) => new Error(`mcp(${at}): oauth${why}`)
	if (authorizationServers.length === 0)
		throw refuse(".authorizationServers lists no authorization server; RFC 9728 metadata needs at least one")
	for (const issuer of authorizationServers)
		if (secure(issuer) === undefined)
			throw refuse(
				`.authorizationServers names ${issuer}, which is no https URL without userinfo, a query or a fragment`,
			)
	for (const scope of scopesSupported ?? []) {
		if (scope === "offline_access")
			throw refuse(
				".scopesSupported lists offline_access, a scope the authorization server grants and a resource never asks for",
			)
		if (!SCOPE.test(scope)) throw refuse(`.scopesSupported lists ${JSON.stringify(scope)}, which is no scope token`)
	}
	/* the canonical URL drops a trailing slash, so the endpoint at the root is its bare origin (MCP "Canonical Server URI") */
	const tail = endpoint.replace(/\/$/, "")
	const fixed = resource === undefined ? undefined : secure(resource)
	if (resource !== undefined && fixed?.pathname.replace(/\/$/, "") !== tail)
		throw refuse(`.resource ${resource} is not this endpoint's URL, whose path is ${endpoint}`)
	const origin = (url: string) => fixed?.origin ?? new URL(url).origin
	const metadataUrl = (url: string) => origin(url) + WELL_KNOWN + tail
	return {
		challenge: (request, status, inner) => {
			const error = status === 403 ? "insufficient_scope" : request.headers.has("authorization") && "invalid_token"
			const scope = scopesOf(inner).join(" ")
			const params = [error && `error=${quoted(error)}`, scope && `scope=${quoted(scope)}`]
			return `Bearer ${[...params.filter(Boolean), `resource_metadata=${quoted(metadataUrl(request.url))}`].join(", ")}`
		},
		metadata: (url) => ({
			resource: origin(url) + tail,
			authorization_servers: authorizationServers,
			...(scopesSupported && { scopes_supported: scopesSupported }),
			/* MCP sends the token in the Authorization header alone, never the query or body */
			bearer_methods_supported: ["header"],
			...(resourceName !== undefined && { resource_name: resourceName }),
		}),
		path: WELL_KNOWN + tail,
	}
}
