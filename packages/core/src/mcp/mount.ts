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
 * the credential the request carries, which the inner routes check again. `"app-middleware"` names the app's own
 * middleware as that check instead: with none, a call still reaches no route unauthenticated, its inner 401 the
 * endpoint's HTTP 401.
 */
import type { ExecutionCtx, HoneyContext } from "../context/context.ts"
import type { TypedResponse } from "../response/response.ts"
import { isStaticPattern, joinPatterns, parsePattern } from "../routing/pattern.ts"
import { assertRouteFree, GRAPH, type HandleView, type HoneyGraph, SERVED, VIEW } from "../routing/register.ts"

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
	/** the check run before any dispatch; `"app-middleware"` when the app's own middleware refuses at `path` */
	readonly authenticate?: McpAuthenticate | "app-middleware"
	/** browser origins served beside the endpoint's own; any other Origin is 403 */
	readonly origins?: readonly string[]
	/** the most bytes a request body may hold (4 MiB by default); the app's bodyLimit applies before it */
	readonly maxBodyBytes?: number
}

type McpContext = HoneyContext & { readonly res: { raw(response: Response): TypedResponse } }

/** The handle `mcp` registers on: its graph, its view, its fetch and the three methods. */
type McpHandle = {
	readonly [GRAPH]: HoneyGraph
	readonly [VIEW]: HandleView
	fetch(request: Request, env: never, executionCtx?: ExecutionCtx): Response | Promise<Response>
} & Record<(typeof METHODS)[number], (path: string) => { meta(meta: object): { handler(fn: unknown): unknown } }>

const METHODS = ["post", "get", "delete"] as const

/** Serve `handler`'s tools at `path` on `app`; returns `app`. */
export function mcp<A>(app: A, path: string, handler: McpHandler, options: McpOptions = {}): A {
	const { authenticate, maxBodyBytes, origins = [] } = options
	if (handler.secured && authenticate === undefined)
		throw new Error(
			`mcp(${path}): its tools require a credential, so it needs authenticate: (request, ctx) => boolean, run before ` +
				'any call, or authenticate: "app-middleware" when the app\'s own middleware refuses an unauthenticated request there',
		)
	const handle = app as unknown as McpHandle
	const segments = parsePattern(joinPatterns(handle[VIEW].basePath, path))
	if (!isStaticPattern(segments)) throw new Error(`cannot serve MCP at ${path}: its path is fixed, with no parameter`)
	for (const method of METHODS) assertRouteFree(handle[GRAPH], method.toUpperCase(), segments)
	const serve = async (ctx: McpContext) => {
		if (typeof authenticate === "function" && !(await authenticate(ctx.req, ctx)))
			return ctx.res.raw(new Response(null, { headers: { "www-authenticate": handler.challenge }, status: 401 }))
		const dispatch = async (request: Request) => handle.fetch(request, ctx.env as never, ctx.executionCtx)
		return ctx.res.raw(await handler.fetch(ctx.req, { dispatch, max: maxBodyBytes, origins }))
	}
	for (const method of METHODS)
		handle[method](path)
			.meta({ internal: true, [SERVED]: true })
			.handler(serve)
	return app
}
