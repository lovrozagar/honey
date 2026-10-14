/**
 * `staticFiles({ resolve, prefix?, headers?, rewritePath?, precompressed? })`: serve GET and HEAD
 * requests from wherever `resolve` finds a file (a Workers ASSETS binding, `Bun.file`, node's
 * `fs.openAsBlob`, a KV store). A Response it answers goes out as it is, since the binding or
 * fetch did its own range and caching; a body (a Blob, a range source, bytes) is typed by its
 * extension and answered through `rangeResponse`, so a `Range` is honored. `null` falls through to
 * the app's routes. Conditional GET is bit 08's.
 *
 * The path `resolve` gets is the router's normalized `ctx.path` under `prefix` (matched on a whole
 * segment), decoded once, with no `.`, `..`, empty, NUL, `:` or separator-bearing segment: joined
 * onto a root directory it cannot leave that root, on POSIX or Windows. A `rewritePath` result is
 * checked again. With `precompressed`, a client that accepts br or gzip gets the `.br` or `.gz`
 * sibling when one exists (Vary: Accept-Encoding either way); a range then covers the encoded bytes.
 *
 * It is miss-chain middleware: a files-only app must register at least one route on the handle
 * (typically its SPA or catch-all fallback) for the chain to run at all.
 */
import { acceptsCoding } from "../middleware/compress.ts"
import { type MiddlewareFn, namedMiddleware } from "../middleware/middleware.ts"
import { normalizePath } from "../routing/request-path.ts"
import { type RangeBody, type RangeInit, rangeResponse } from "./range.ts"
import { addVary, withHeaders } from "./with-headers.ts"

/** What `resolve` may find: a Response to send as it is, or a body to type and range. */
export type StaticFile = RangeBody | Response

export type StaticConfig<TCtx> = {
	/** Extra response headers; a function gets the path `resolve` got. */
	headers?: Record<string, string> | ((filePath: string) => Record<string, string>)
	/** Serve a `.br` or `.gz` sibling to a client that accepts it. Default false: one lookup per request. */
	precompressed?: boolean
	/** Mount point, matched on whole segments: `/assets` serves `/assets/x`, never `/assets-private/x`. */
	prefix?: string
	/** The file for `filePath`, or `null` to fall through to the next handler. */
	resolve: (ctx: TCtx, filePath: string) => Promise<StaticFile | null> | StaticFile | null
	/** Rewrite the decoded path before `resolve` (`/` → `/index.html`); the result is checked again. */
	rewritePath?: (filePath: string, ctx: TCtx) => string
}

/** The web's own types by extension (A1); anything else is a Blob's own type or octet-stream. */
const TYPES: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze({
	avif: "image/avif",
	css: "text/css; charset=utf-8",
	gif: "image/gif",
	htm: "text/html; charset=utf-8",
	html: "text/html; charset=utf-8",
	ico: "image/x-icon",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	js: "text/javascript; charset=utf-8",
	json: "application/json",
	map: "application/json",
	mjs: "text/javascript; charset=utf-8",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	otf: "font/otf",
	pdf: "application/pdf",
	png: "image/png",
	svg: "image/svg+xml",
	ttf: "font/ttf",
	txt: "text/plain; charset=utf-8",
	wasm: "application/wasm",
	webm: "video/webm",
	webmanifest: "application/manifest+json",
	webp: "image/webp",
	woff: "font/woff",
	woff2: "font/woff2",
	xml: "application/xml",
})

function typeOf(filePath: string): string | undefined {
	const name = filePath.slice(filePath.lastIndexOf("/") + 1)
	const dot = name.lastIndexOf(".")
	const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
	return Object.hasOwn(TYPES, ext) ? TYPES[ext] : undefined
}

function normalizePrefix(prefix: string): string {
	const normalized = normalizePath(prefix.startsWith("/") ? prefix : `/${prefix}`)
	if (normalized === null) throw new TypeError(`staticFiles: invalid prefix ${JSON.stringify(prefix)}`)
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

function isSafeSegment(segment: string): boolean {
	if (segment === "" || segment === "." || segment === "..") return false
	/* `:` makes a Windows drive (`C:`) or an alternate data stream (`a.txt::$DATA`) */
	return !segment.includes("/") && !segment.includes("\\") && !segment.includes("\0") && !segment.includes(":")
}

/** Decode one segment, or `null` for malformed percent-encoding. */
function decodeSegment(part: string): string | null {
	try {
		return decodeURIComponent(part)
	} catch {
		/* the answer, not a failure: a malformed escape names no file, so the request falls through */
		return null
	}
}

/** The decoded path, or `null` when a segment is malformed or names something a file system treats specially. */
function safeFilePath(encoded: string): string | null {
	const parts = encoded.split("/")
	const out: string[] = []
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i] as string
		/* a trailing empty segment is a directory request */
		if (part === "" && i === parts.length - 1) continue
		const segment = decodeSegment(part)
		if (segment === null || !isSafeSegment(segment)) return null
		out.push(segment)
	}
	const joined = `/${out.join("/")}`
	return out.length > 0 && encoded.endsWith("/") ? `${joined}/` : joined
}

/** A `rewritePath` result, if it is the same safe shape `resolve` would get without one. */
function safeRewrite(path: string): string | null {
	if (!path.startsWith("/")) return null
	const parts = path.split("/")
	for (let i = 1; i < parts.length; i++) {
		if (!(parts[i] === "" && i === parts.length - 1) && !isSafeSegment(parts[i] as string)) return null
	}
	return path
}

/** The rest of `path` under `prefix`, or `null` when the path is not under it. */
function under(prefix: string, path: string): string | null {
	if (prefix === "/") return path
	if (path === prefix) return "/"
	return path.startsWith(prefix) && path.charCodeAt(prefix.length) === 47 ? path.slice(prefix.length) : null
}

type Found = { readonly encoding: "br" | "gzip" | null; readonly file: StaticFile }

/** The file to send: a precompressed sibling the client accepts, else the file itself. */
async function find<TCtx>(
	config: StaticConfig<TCtx>,
	ctx: TCtx,
	filePath: string,
	accept: string | null,
): Promise<Found | null> {
	if (config.precompressed === true) {
		if (acceptsCoding(accept, "br")) {
			const file = await config.resolve(ctx, `${filePath}.br`)
			if (file !== null) return { encoding: "br", file }
		}
		if (acceptsCoding(accept, "gzip")) {
			const file = await config.resolve(ctx, `${filePath}.gz`)
			if (file !== null) return { encoding: "gzip", file }
		}
	}
	const file = await config.resolve(ctx, filePath)
	return file === null ? null : { encoding: null, file }
}

type Answer = {
	readonly extra: Record<string, string>
	readonly precompressed: boolean
	readonly type: string | undefined
}

/** A Response found: as it is, unless there is something to add (on immutable headers too). */
function fromResponse(response: Response, encoding: Found["encoding"], answer: Answer): Response {
	const { extra, precompressed, type } = answer
	if (encoding === null && !precompressed && Object.keys(extra).length === 0) return response
	return withHeaders(response, (headers) => {
		if (encoding !== null) {
			headers.set("content-encoding", encoding)
			/* the sibling's own type describes the encoded file; the client wants the original's */
			if (type !== undefined) headers.set("content-type", type)
		}
		if (precompressed) addVary(headers, "accept-encoding")
		for (const name of Object.keys(extra)) headers.set(name, extra[name] as string)
	})
}

function respond(request: Request, found: Found, answer: Answer): Response {
	const { encoding, file } = found
	if (file instanceof Response) return fromResponse(file, encoding, answer)
	const headers: Record<string, string> = { ...answer.extra }
	if (encoding !== null) headers["content-encoding"] = encoding
	if (answer.precompressed) headers.vary = "accept-encoding"
	const init: RangeInit = answer.type === undefined ? { headers } : { contentType: answer.type, headers }
	return rangeResponse(request, file, init)
}

export function staticFiles<TCtx extends { readonly path: string; readonly req: Request }>(
	config: StaticConfig<TCtx>,
): MiddlewareFn<TCtx> {
	const prefix = normalizePrefix(config.prefix ?? "/")
	return namedMiddleware("staticFiles", async (ctx, next) => {
		const req = ctx.req
		if (req.method !== "GET" && req.method !== "HEAD") return next()
		const rest = under(prefix, ctx.path)
		const decoded = rest === null ? null : safeFilePath(rest)
		const filePath = decoded === null || !config.rewritePath ? decoded : safeRewrite(config.rewritePath(decoded, ctx))
		if (filePath === null) return next()
		const found = await find(config, ctx, filePath, req.headers.get("accept-encoding"))
		if (found === null) return next()
		const extra = typeof config.headers === "function" ? config.headers(filePath) : (config.headers ?? {})
		return respond(req, found, { extra, precompressed: config.precompressed === true, type: typeOf(filePath) })
	})
}
