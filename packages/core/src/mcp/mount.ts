/**
 * `mcp(app, path, handler, options?)` (bit 21 e, H24.3): the app's own tools over MCP's Streamable HTTP, served at
 * `path` by the handler the plugin generates (`_gen/mcp.gen.ts`'s `mcpHandler`), typed against its shape alone, so
 * core imports nothing of honey-codegen. POST, GET and DELETE are plain routes on the handle (its basePath and every
 * middleware apply; the handler answers GET and DELETE 405), internal and served, so they stay out of the documents
 * and out of the tool set. Each call dispatches in-process through `app.fetch` with the request's env and execution
 * context, every middleware and the operation's own auth running again; only the credential headers the tools'
 * schemes name ride it. A plain function the app imports (`@lovrozagar/honey/mcp`), so an app serving no MCP
 * bundles none of it.
 *
 * Auth, fail-closed: when any tool's operation requires a credential, the mount needs `authenticate`, run on every
 * request before any dispatch; `false` is HTTP 401 with the scheme's challenge. Its answer reaches the tools only as
 * the credential the request carries, which the inner routes check again. Mounting secured tools without it throws,
 * with no exception.
 *
 * OAuth (bit 21 f, opt-in): with `oauth`, the endpoint is an OAuth 2.1 resource server (oauth.ts): its RFC 9728
 * metadata served at the path-inserted well-known URI (a GET on the app's root, under the handle's middleware, as
 * internal and served as the endpoint), every 401 pointing at it, an inner insufficient_scope one 403 step-up
 * challenge. It needs `authenticate`, which validates the token (its audience this endpoint), even when no tool
 * declares security. The token the client sends is this resource's own, and goes only to the app's own routes.
 */
import type { ExecutionCtx, HoneyContext } from "../context/context.ts"
import type { TypedResponse } from "../response/response.ts"
import { startRoute } from "../routing/route-builder.ts"
import { isStaticPattern, joinPatterns, parsePattern } from "../routing/pattern.ts"
import { assertRouteFree, GRAPH, type HandleView, type HoneyGraph, SERVED, VIEW } from "../routing/register.ts"
import { type McpOAuth, protectedResource } from "./oauth.ts"

export type { McpOAuth } from "./oauth.ts"

/** What the mount hands the handler on each request. */
export type McpMount = {
	/** the app, in process: each tool call's request through every middleware and its route */
	readonly dispatch: (request: Request) => Promise<Response>
	/** the browser origins served beside the endpoint's own */
	readonly origins: readonly string[]
	/** the most bytes a request body may hold; the handler's own cap when unset */
	readonly max: number | undefined
}

/** The generated handler (`mcpHandler`): whether a tool requires a credential, the challenge it names, the endpoint. */
export type McpHandler = {
	readonly secured: boolean
	readonly challenge: string
	readonly fetch: (request: Request, mount: McpMount) => Promise<Response>
}

/** Whether `request` carries a credential the app accepts; `false` is refused before any dispatch. */
export type McpAuthenticate = (request: Request, ctx: HoneyContext) => boolean | Promise<boolean>

export type McpOptions = {
	/** the check run on every request before any dispatch; required when a tool requires a credential */
	readonly authenticate?: McpAuthenticate
	/** browser origins served beside the endpoint's own; any other Origin is 403 */
	readonly origins?: readonly string[]
	/** the most bytes a request body may hold (4 MiB by default); the app's bodyLimit applies before it */
	readonly maxBodyBytes?: number
	/** the opt-in OAuth 2.1 resource-server role: RFC 9728 metadata and Bearer challenges pointing at it */
	readonly oauth?: McpOAuth
}

type McpContext = HoneyContext & { readonly res: { raw(response: Response): TypedResponse } }

/** A route's builder, as far as `mcp` registers one. */
type Registering = { meta(meta: object): { handler(fn: unknown): unknown } }

/** The handle `mcp` registers on: its graph, its view, its fetch and the three methods. */
type McpHandle = {
	readonly [GRAPH]: HoneyGraph
	readonly [VIEW]: HandleView
	fetch(request: Request, env: never, executionCtx?: ExecutionCtx): Response | Promise<Response>
} & Record<(typeof METHODS)[number], (path: string) => Registering>

const METHODS = ["post", "get", "delete"] as const

/** An answer of `status` with no body, its `challenge` the only header. */
const refusal = (status: number, challenge: string) =>
	new Response(null, { headers: { "www-authenticate": challenge }, status })

/** Serve `handler`'s tools at `path` on `app`; returns `app`. */
export function mcp<A>(app: A, path: string, handler: McpHandler, options: McpOptions = {}): A {
	const { authenticate, maxBodyBytes, oauth, origins = [] } = options
	if (oauth !== undefined && typeof authenticate !== "function")
		throw new Error(
			`mcp(${path}): oauth makes it a protected resource, so it needs authenticate: (request, ctx) => boolean`,
		)
	if (handler.secured && typeof authenticate !== "function")
		throw new Error(
			`mcp(${path}): its tools require a credential, so it needs authenticate: (request, ctx) => boolean, run on ` +
				"every request before any call",
		)
	const handle = app as unknown as McpHandle
	const graph = handle[GRAPH]
	const endpoint = joinPatterns(handle[VIEW].basePath, path)
	const segments = parsePattern(endpoint)
	if (!isStaticPattern(segments)) throw new Error(`cannot serve MCP at ${path}: its path is fixed, with no parameter`)
	/* the URL a client sees: the prefix the app strips, then the path it routes */
	const resource = oauth && protectedResource(oauth, joinPatterns(graph.settings.stripPrefix ?? "/", endpoint), path)
	for (const method of METHODS) assertRouteFree(graph, method.toUpperCase(), segments)
	if (resource) assertRouteFree(graph, "GET", parsePattern(resource.path))
	const serve = async (ctx: McpContext) => {
		if (typeof authenticate === "function" && !(await authenticate(ctx.req, ctx)))
			return ctx.res.raw(refusal(401, resource ? resource.challenge(ctx.req, 401) : handler.challenge))
		const dispatch = async (request: Request) => handle.fetch(request, ctx.env as never, ctx.executionCtx)
		const answer = await handler.fetch(ctx.req, { dispatch, max: maxBodyBytes, origins })
		const inner = answer.headers.get("www-authenticate")
		/* under oauth the handler's 401, or its 403 with a challenge (insufficient_scope; an Origin 403 has none), is ours */
		if (resource && (answer.status === 401 || (answer.status === 403 && inner !== null)))
			return ctx.res.raw(refusal(answer.status, resource.challenge(ctx.req, answer.status, inner)))
		return ctx.res.raw(answer)
	}
	for (const method of METHODS)
		handle[method](path)
			.meta({ internal: true, [SERVED]: true })
			.handler(serve)
	if (resource)
		/* on the root, under the handle's middleware: the metadata sits beside the origin, not under the basePath */
		(
			startRoute(graph, { ...handle[VIEW], basePath: "/" }, handle, {
				extraMethods: [],
				method: "GET",
				path: resource.path,
			}) as Registering
		)
			.meta({ internal: true, [SERVED]: true })
			.handler((ctx: McpContext) => ctx.res.raw(Response.json(resource.metadata(ctx.req.url))))
	return app
}
