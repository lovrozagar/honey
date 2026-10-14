import { mkdirSync, mkdtempSync, openAsBlob, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { honey } from "../routing/app.ts"
import { type StaticConfig, staticFiles } from "./static.ts"

type Resolve = StaticConfig<unknown>["resolve"]

/** staticFiles in front of the app's routes (GET /api/ping) and its 404. */
function app(
	config: Partial<StaticConfig<unknown>> & { resolve: Resolve },
	encodedSlashes: "allow" | "reject" = "reject",
) {
	const a = honey<{}>()
	a.encodedSlashes(encodedSlashes)
	const routes = a.use(staticFiles(config))
	routes.get("/api/ping").handler((ctx) => ctx.res.text("ok", "pong"))
	routes.post("/upload").handler((ctx) => ctx.res.text("ok", "posted"))
	return a
}

const req = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

/** A request whose url is the raw target, as a runtime that does not normalize it hands it over. */
function rawRequest(path: string, init: RequestInit = {}): Request {
	const request = new Request("http://app.test/", init)
	Object.defineProperty(request, "url", { value: `http://app.test${path}` })
	return request
}

function resolver(files: Record<string, string | Response> = {}) {
	return vi.fn((_ctx: unknown, filePath: string) => {
		const file = files[filePath]
		if (file === undefined) return null
		return typeof file === "string" ? new TextEncoder().encode(file) : file
	})
}

const paths = (resolve: ReturnType<typeof resolver>) => resolve.mock.calls.map((call) => call[1])

describe("staticFiles(): what it serves", () => {
	// v0: 71ba0fdb29
	// v0: 74a41dcfc2
	it("a Response the resolver answers is the answer, untouched (an ASSETS binding, a fetch)", async () => {
		const asset = new Response("from ASSETS", { headers: { "content-type": "text/css", etag: '"v1"' } })
		const res = await app({ resolve: () => asset }).fetch(req("/site.css"), {})
		expect(res).toBe(asset)
	})

	// v0: 2002ea98fb
	// v0: 47be79b2dd
	// v0: 52b18bdd20
	it("null falls through to the app's routes, and to its 404", async () => {
		const resolve = resolver()
		const a = app({ resolve })
		const [route, missing] = [await a.fetch(req("/api/ping"), {}), await a.fetch(req("/missing.js"), {})]
		expect([await route.text(), missing.status, paths(resolve)]).toEqual(["pong", 404, ["/api/ping", "/missing.js"]])
	})

	// v0: 7a4cc3d148
	it("the resolver may answer later", async () => {
		const res = await app({ resolve: async () => new Response("async file") }).fetch(req("/async.js"), {})
		expect(await res.text()).toBe("async file")
	})

	// v0: f976650d03
	// v0: 913ea0fd77
	it("only GET and HEAD are served; any other method goes to the routes", async () => {
		const resolve = resolver({ "/upload": "a file" })
		const a = app({ resolve })
		const statuses = []
		for (const method of ["POST", "PUT", "DELETE", "PATCH"])
			statuses.push((await a.fetch(req("/upload", { method }), {})).status)
		expect([statuses, resolve.mock.calls.length]).toEqual([[200, 405, 405, 405], 0])
	})

	// v0: 9c2c56c5d5
	// v0: 64608b2746
	it("HEAD gets the head of the file: its type and length, no body", async () => {
		const res = await app({ resolve: resolver({ "/file.js": "let x = 1" }) }).fetch(
			req("/file.js", { method: "HEAD" }),
			{},
		)
		expect([res.status, res.headers.get("content-type"), res.headers.get("content-length"), res.body]).toEqual([
			200,
			"text/javascript; charset=utf-8",
			"9",
			null,
		])
	})
})

describe("staticFiles(): a body the resolver answers", () => {
	// v0: 4cb65eb074
	it.each([
		["/index.html", "text/html; charset=utf-8"],
		["/app.mjs", "text/javascript; charset=utf-8"],
		["/data.json", "application/json"],
		["/logo.svg", "image/svg+xml"],
		["/font.woff2", "font/woff2"],
		["/mod.wasm", "application/wasm"],
		["/IMAGE.PNG", "image/png"],
		["/archive.unknownext", "application/octet-stream"],
		["/no-extension", "application/octet-stream"],
	])("%s is served as %s", async (path, type) => {
		const res = await app({ resolve: () => new Uint8Array([1, 2, 3]) }).fetch(req(path), {})
		expect([res.status, res.headers.get("content-type")]).toEqual([200, type])
	})

	it("a Blob of an unknown extension keeps its own type", async () => {
		const res = await app({ resolve: () => new Blob(["x"], { type: "application/x-custom" }) }).fetch(
			req("/file.custom"),
			{},
		)
		expect(res.headers.get("content-type")).toBe("application/x-custom")
	})

	it("a Range is honored: one range is 206, past the end 416, and every answer says Accept-Ranges", async () => {
		const a = app({ resolve: () => new Blob(["0123456789"]) })
		const partial = await a.fetch(req("/video.mp4", { headers: { range: "bytes=2-5" } }), {})
		const past = await a.fetch(req("/video.mp4", { headers: { range: "bytes=50-" } }), {})
		expect([
			partial.status,
			partial.headers.get("content-range"),
			await partial.text(),
			past.status,
			partial.headers.get("accept-ranges"),
		]).toEqual([206, "bytes 2-5/10", "2345", 416, "bytes"])
	})

	it("a range source hands out only the span asked for", async () => {
		/* a range source's end is inclusive */
		const slice = vi.fn((start: number, end: number) => new TextEncoder().encode("abcdefghij".slice(start, end + 1)))
		const res = await app({ resolve: () => ({ size: 10, slice }) }).fetch(
			req("/big.bin", { headers: { range: "bytes=7-" } }),
			{},
		)
		expect([res.status, await res.text(), slice.mock.calls]).toEqual([206, "hij", [[7, 9]]])
	})
})

describe("staticFiles(): the path the resolver gets", () => {
	// v0: a10b13d8a1
	it("with no prefix, every path", async () => {
		const resolve = resolver()
		await app({ resolve }).fetch(req("/any/path/file.js"), {})
		expect(paths(resolve)).toEqual(["/any/path/file.js"])
	})

	// v0: 20dab89af2
	// v0: 18cc4826bf
	// v0: 3b93dd8c6c
	// v0: 3933167f15
	// v0: baa25a3883
	// v0: 8ea4ab7a65
	it("under a prefix: the rest of the path, matched on a whole segment", async () => {
		const resolve = resolver()
		const a = app({ prefix: "/assets", resolve })
		for (const path of ["/other/file.js", "/assets-private/secret.txt", "/assets/js/app.js", "/assets"])
			await a.fetch(req(path), {})
		expect(paths(resolve)).toEqual(["/js/app.js", "/"])
	})

	// v0: 68c01be0ce
	it("a trailing slash on the prefix makes no difference", async () => {
		const resolve = resolver()
		await app({ prefix: "/assets/", resolve }).fetch(req("/assets/app.js"), {})
		expect(paths(resolve)).toEqual(["/app.js"])
	})

	it("a prefix without its leading slash is the same prefix", async () => {
		const resolve = resolver()
		await app({ prefix: "assets", resolve }).fetch(req("/assets/app.js"), {})
		expect(paths(resolve)).toEqual(["/app.js"])
	})

	it("a directory path keeps its trailing slash, so the resolver can tell it from a file", async () => {
		const resolve = resolver()
		const a = app({ resolve })
		for (const path of ["/", "/docs/"]) await a.fetch(req(path), {})
		expect(paths(resolve)).toEqual(["/", "/docs/"])
	})
})

describe("staticFiles(): how the path is spelled", () => {
	it("a prefix that is not a path is refused at construction", () => {
		expect(() => staticFiles({ prefix: "/a%2Fb", resolve: () => null })).toThrow('staticFiles: invalid prefix "/a%2Fb"')
	})

	// v0: 69896e3740
	// v0: 012f131053
	it("decoded once: %20 is a space, %252e a literal %2e in the name", async () => {
		const resolve = resolver()
		const a = app({ resolve })
		await a.fetch(req("/my%20file.txt"), {})
		await a.fetch(rawRequest("/%252e%252e/secret"), {})
		expect(paths(resolve)).toEqual(["/my file.txt", "/%2e%2e/secret"])
	})

	// v0: 1f875078db
	it("is ctx.path, the normalized path the router matched, not the request target", async () => {
		const resolve = resolver()
		const a = honey<{}>().stripPrefix("/api")
		a.use(staticFiles({ prefix: "/assets", resolve }))
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "up"))
		await a.fetch(req("/api/assets/app.js"), {})
		expect(paths(resolve)).toEqual(["/app.js"])
	})

	// v0: 950903c31c
	// v0: 8c794bbc1f
	it("rewritePath changes it first, and the result is checked again", async () => {
		const resolve = resolver()
		await app({ resolve, rewritePath: (path) => `/dist${path}` }).fetch(req("/app.js"), {})
		await app({ resolve, rewritePath: (path) => `/..${path}` }).fetch(req("/app.js"), {})
		await app({ resolve, rewritePath: (path) => `dist${path}` }).fetch(req("/app.js"), {})
		await app({ resolve, rewritePath: () => "/dist/" }).fetch(req("/app.js"), {})
		expect(paths(resolve)).toEqual(["/dist/app.js", "/dist/"])
	})

	it("rewritePath gets ctx: an SPA serves its shell for a directory path", async () => {
		const resolve = resolver({ "/index.html": "<html>" })
		const a = app({
			resolve,
			rewritePath: (path, ctx) =>
				path.endsWith("/") && (ctx as { req: Request }).req.method === "GET" ? `${path}index.html` : path,
		})
		expect(await (await a.fetch(req("/"), {})).text()).toBe("<html>")
	})
})

describe("staticFiles(): a path that would leave the root never reaches the resolver", () => {
	// v0: c59565138d
	// v0: b703130ce1
	it("dot segments resolve inside the root, never above it", async () => {
		const resolve = resolver()
		const a = app({ resolve })
		for (const path of ["/../etc/passwd", "/foo/../../bar", "/foo/%2e%2e/bar"]) await a.fetch(rawRequest(path), {})
		expect(paths(resolve)).toEqual(["/etc/passwd", "/bar", "/bar"])
	})

	// v0: 9087e22b64
	it("a raw backslash is a separator, so it resolves inside the root", async () => {
		const resolve = resolver()
		await app({ resolve }).fetch(rawRequest("/a\\..\\secret"), {})
		expect(paths(resolve)).toEqual(["/secret"])
	})

	// v0: 563678668a
	// v0: da79ca780b
	// v0: 149d402e66
	// v0: 8d9ce7d65e
	it.each([
		"/bad%E0%A4%A.txt",
		"/a%00.txt",
		"/a%5C..%5Csecret",
		"/a%2F..%2Fsecret",
		"/C:/Windows/win.ini",
		"/a.txt::$DATA",
		"/a%3A.txt",
	])("%s falls through, even with encoded slashes allowed by the router", async (path) => {
		const resolve = resolver()
		const res = await app({ resolve }, "allow").fetch(rawRequest(path), {})
		expect([res.status, resolve.mock.calls.length]).toEqual([404, 0])
	})

	// v0: b0d78b001e
	it("doubled slashes cannot slip past the prefix check", async () => {
		const resolve = resolver()
		await app({ prefix: "/assets", resolve }).fetch(rawRequest("//assets//../secret"), {})
		expect(resolve.mock.calls.length).toBe(0)
	})
})

describe("staticFiles(): headers", () => {
	// v0: c8ff5d727c
	// v0: 47029f58fb
	it("a record is set on every answer", async () => {
		const headers = { "cache-control": "public, max-age=31536000, immutable", "x-custom": "val" }
		const a = app({ headers, resolve: resolver({ "/file.css": "a{}", "/asset.css": new Response("b{}") }) })
		const [body, response] = [await a.fetch(req("/file.css"), {}), await a.fetch(req("/asset.css"), {})]
		expect([body.headers.get("cache-control"), response.headers.get("x-custom")]).toEqual([
			headers["cache-control"],
			"val",
		])
	})

	// v0: 37b163737f
	// v0: d1b3e3e780
	// v0: c363d12e9a
	it("a function gets the path the resolver got", async () => {
		const headers = vi.fn((filePath: string) => ({ "x-file": filePath }))
		const res = await app({
			headers,
			resolve: resolver({ "/dist/img/logo.png": "png" }),
			rewritePath: (path) => `/dist${path}`,
		}).fetch(req("/img/logo.png"), {})
		expect([res.headers.get("x-file"), headers.mock.calls]).toEqual(["/dist/img/logo.png", [["/dist/img/logo.png"]]])
	})

	// v0: 2bf9c1899f
	it("are set even on a response whose headers are immutable", async () => {
		const res = await app({
			headers: { "cache-control": "max-age=60" },
			resolve: () => Response.redirect("http://app.test/x", 302),
		}).fetch(req("/x"), {})
		expect([res.status, res.headers.get("cache-control"), res.headers.get("location")]).toEqual([
			302,
			"max-age=60",
			"http://app.test/x",
		])
	})
})

const FILES = {
	"/app.js": "plain",
	"/app.js.br": "brotli bytes",
	"/app.js.gz": "gzip bytes",
	"/only.css": "css",
	"/gz.css.gz": "gz",
}

describe("staticFiles(): precompressed siblings", () => {
	it("off by default: the file as it is, one lookup", async () => {
		const resolve = resolver(FILES)
		const res = await app({ resolve }).fetch(req("/app.js", { headers: { "accept-encoding": "br, gzip" } }), {})
		expect([await res.text(), res.headers.get("content-encoding"), paths(resolve)]).toEqual([
			"plain",
			null,
			["/app.js"],
		])
	})

	it.each([
		["br, gzip", "brotli bytes", "br"],
		["gzip", "gzip bytes", "gzip"],
		["br;q=0, gzip", "gzip bytes", "gzip"],
		["identity", "plain", null],
	])("Accept-Encoding %j: %j as %s", async (accept, body, encoding) => {
		const res = await app({ precompressed: true, resolve: resolver(FILES) }).fetch(
			req("/app.js", { headers: { "accept-encoding": accept } }),
			{},
		)
		expect([
			await res.text(),
			res.headers.get("content-encoding"),
			res.headers.get("content-type"),
			res.headers.get("vary"),
		]).toEqual([body, encoding, "text/javascript; charset=utf-8", "accept-encoding"])
	})
})

describe("staticFiles(): a precompressed sibling found or not", () => {
	it("no sibling on disk: the file itself, still Vary: Accept-Encoding", async () => {
		const resolve = resolver(FILES)
		const res = await app({ precompressed: true, resolve }).fetch(
			req("/only.css", { headers: { "accept-encoding": "br, gzip" } }),
			{},
		)
		expect([await res.text(), res.headers.get("vary"), paths(resolve)]).toEqual([
			"css",
			"accept-encoding",
			["/only.css.br", "/only.css.gz", "/only.css"],
		])
	})

	it("a sibling the resolver answers as a Response gets the encoding and the original's type", async () => {
		const resolve = resolver({
			"/app.js.br": new Response("binding br", { headers: { "content-type": "application/x-brotli" } }),
		})
		const res = await app({ precompressed: true, resolve }).fetch(
			req("/app.js", { headers: { "accept-encoding": "br" } }),
			{},
		)
		expect([await res.text(), res.headers.get("content-encoding"), res.headers.get("content-type")]).toEqual([
			"binding br",
			"br",
			"text/javascript; charset=utf-8",
		])
	})

	it("a sibling Response for an extension with no known type keeps its own type", async () => {
		const resolve = resolver({
			"/data.raw.gz": new Response("gz", { headers: { "content-type": "application/x-thing" } }),
		})
		const res = await app({ precompressed: true, resolve }).fetch(
			req("/data.raw", { headers: { "accept-encoding": "gzip" } }),
			{},
		)
		expect([res.headers.get("content-encoding"), res.headers.get("content-type")]).toEqual([
			"gzip",
			"application/x-thing",
		])
	})

	it("a range applies to the encoded bytes", async () => {
		const res = await app({ precompressed: true, resolve: resolver(FILES) }).fetch(
			req("/app.js", { headers: { "accept-encoding": "gzip", range: "bytes=0-3" } }),
			{},
		)
		expect([res.status, await res.text(), res.headers.get("content-encoding")]).toEqual([206, "gzip", "gzip"])
	})
})

describe("staticFiles(): from a real directory", () => {
	// v0: 24c0b79358
	it("node's fs.openAsBlob as the resolver: a real file is served, and traversal never reaches a file outside the root", async () => {
		const outside = mkdtempSync(join(tmpdir(), "honey-static-"))
		const root = join(outside, "public")
		writeFileSync(join(outside, "secret.txt"), "secret")
		mkdirSync(root)
		writeFileSync(join(root, "hello.txt"), "hello from disk")
		const a = app({
			resolve: async (_ctx, filePath) => {
				try {
					return await openAsBlob(join(root, filePath))
				} catch {
					/* no such file: fall through */
					return null
				}
			},
		})
		const served = await a.fetch(req("/hello.txt"), {})
		const escaped = await a.fetch(rawRequest("/../secret.txt"), {})
		expect([await served.text(), served.headers.get("content-type"), escaped.status]).toEqual([
			"hello from disk",
			"text/plain; charset=utf-8",
			404,
		])
	})
})
