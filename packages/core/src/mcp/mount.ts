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
 * OAuth (bit 21 f, opt-in, H23): `oauth` takes what `oauth(options)` from `@lovrozagar/honey/mcp/oauth` returns,
 * so an app that never imports it bundles none of the resource server. Here is only its hook: called once at mount
 * (its refusals before any route registers), its challenge on every 401 and on the handler's challenged 403, its
 * metadata route registered after the endpoint's. It needs `authenticate`, even when no tool declares security.
 *
 * Files (bit 21 g, opt-in, H23): `uploads` takes what `uploads(options)` from `@lovrozagar/honey/mcp/uploads`
 * returns (called once at mount, its PUT route registered once the endpoint's path is checked free; each request's
 * uploads handed to the handler), and `urlFiles` what `urlFiles(options)` from `@lovrozagar/honey/mcp/url-files` returns. Neither is
 * imported here, so a mount without them bundles none of either.
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
	/** this request's uploads, when the mount takes them */
	readonly uploads: McpUploading | undefined
	/** the URL file fetch, when the mount has one */
	readonly fetchFile: McpFileFetch | undefined
}

/** A call an upload is bound to: the credential headers its request carried, the tool, every argument. */
export type McpUploadScope = {
	readonly credential: string
	readonly tool: string
	readonly args: Record<string, unknown>
}

/** A file an upload is for: its id in the call, its declared size, its SHA-256 (base64url). */
export type McpUploadFile = { readonly id: string; readonly size: number; readonly digest: string }

/**
 * One request's uploads: the URL a token is PUT under (`base/<token>`), the most bytes a file may declare, a file's
 * token, and its bytes on the call's retry, taken once; `take` rejects a token the call does not hold and resolves the
 * rule a missing upload breaks.
 */
export type McpUploading = {
	readonly base: string
	readonly max: number
	readonly issue: (scope: McpUploadScope, file: McpUploadFile) => Promise<string>
	readonly take: (scope: McpUploadScope, file: McpUploadFile, token: string) => Promise<Uint8Array | string>
}

/**
 * The hook `uploads(options)` returns: called once at mount, once the endpoint's path is checked free, it registers the
 * upload route and returns each request's uploads.
 */
export type McpUploads = (app: unknown, path: string) => (request: Request) => McpUploading

/** What `urlFiles(options)` returns: a file's bytes, type and name fetched from its URL; rejects with the rule broken. */
export type McpFileFetch = (
	url: string,
	signal: AbortSignal,
) => Promise<{ readonly bytes: Uint8Array; readonly type: string; readonly name?: string }>

/** The generated handler (`mcpHandler`): whether a tool requires a credential, the challenge it names, the endpoint. */
export type McpHandler = {
	readonly secured: boolean
	readonly challenge: string
	readonly fetch: (request: Request, mount: McpMount) => Promise<Response>
}

/**
 * The resource-server hook `oauth(options)` returns: called once at mount with the app and the mount path, it refuses
 * an endpoint its options don't fit and answers the endpoint's Bearer challenges and its metadata route.
 */
export type McpProtectedResource = (
	app: unknown,
	path: string,
) => {
	/** the challenge of a `status` refusal of `request`, the handler's own `inner` challenge carried over */
	readonly challenge: (request: Request, status: number, inner?: string | null) => string
	/** registers the metadata route, once the endpoint's own are */
	readonly register: () => void
}

/**
 * Whether `request` carries a credential the app accepts; `false` is refused before any dispatch. `ctx` is the
 * mounting handle's own, as its routes see it: its env, and what its middleware adds.
 */
export type McpAuthenticate<TCtx = HoneyContext<unknown>> = (request: Request, ctx: TCtx) => boolean | Promise<boolean>

/** The ctx a handle's routes are given (its `$ctx`); any app's, for anything else. */
type CtxOf<A> = A extends { readonly $ctx: infer TCtx } ? TCtx : HoneyContext<unknown>

/** What `mcp()` takes beside the handler; `TCtx` is the ctx `authenticate` is given, any app's by default. */
export type McpOptions<TCtx = HoneyContext<unknown>> = {
	/** the check run on every request before any dispatch; required when a tool requires a credential */
	readonly authenticate?: McpAuthenticate<TCtx>
	/** browser origins served beside the endpoint's own; any other Origin is 403 */
	readonly origins?: readonly string[]
	/** the most bytes a request body may hold (4 MiB by default); the app's bodyLimit applies before it */
	readonly maxBodyBytes?: number
	/** the opt-in OAuth 2.1 resource-server role: RFC 9728 metadata and Bearer challenges pointing at it */
	readonly oauth?: McpProtectedResource
	/** out-of-band file uploads, through the file-uploads extension: what `uploads(options)` returns */
	readonly uploads?: McpUploads
	/** file arguments given as https URLs the app fetches: what `urlFiles(options)` returns */
	readonly urlFiles?: McpFileFetch
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
export function mcp<A>(app: A, path: string, handler: McpHandler, options: McpOptions<CtxOf<A>> = {}): A {
	const { authenticate, maxBodyBytes, oauth, origins = [], uploads, urlFiles } = options
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
	const segments = parsePattern(joinPatterns(handle[VIEW].basePath, path))
	if (!isStaticPattern(segments)) throw new Error(`cannot serve MCP at ${path}: its path is fixed, with no parameter`)
	const resource = oauth?.(app, path)
	for (const method of METHODS) assertRouteFree(handle[GRAPH], method.toUpperCase(), segments)
	const files = uploads?.(app, path)
	const serve = async (ctx: McpContext & CtxOf<A>) => {
		if (typeof authenticate === "function" && !(await authenticate(ctx.req, ctx)))
			return ctx.res.raw(refusal(401, resource ? resource.challenge(ctx.req, 401) : handler.challenge))
		const dispatch = async (request: Request) => handle.fetch(request, ctx.env as never, ctx.executionCtx)
		const answer = await handler.fetch(ctx.req, {
			dispatch,
			fetchFile: urlFiles,
			max: maxBodyBytes,
			origins,
			uploads: files?.(ctx.req),
		})
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
	resource?.register()
	return app
}
