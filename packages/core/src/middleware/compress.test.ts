import { afterEach, describe, expect, it, vi } from "vitest"
import { isHoneyResponse, NODE_OUTBOUND, rawBodyOf, withRawBody } from "../response/builder.ts"
import { honey } from "../routing/app.ts"
import { compress, type CompressOptions } from "./compress.ts"

const TEXT = "honey ".repeat(400)

afterEach(() => {
	vi.unstubAllGlobals()
})

type Route = (ctx: { res: { text: Function; json: Function; stream: Function } }) => unknown

const noContent: Route = () => new Response(null, { status: 204 })

function app(handler: Route = (ctx) => ctx.res.text("ok", TEXT), options?: CompressOptions) {
	const a = honey<{}>()
	a.use(compress(options))
		.get("/t")
		.handler(handler as never)
	return a
}

function request(headers: Record<string, string> = {}, init: { node?: boolean } = {}): Request {
	const req = new Request("https://app.example.com/t", { headers })
	if (init.node) Object.defineProperty(req, NODE_OUTBOUND, { value: true })
	return req
}

async function decoded(res: Response): Promise<string> {
	const encoding = res.headers.get("content-encoding")
	if (res.body === null) return ""
	if (encoding === null) return res.text()
	const format = (encoding === "br" ? "brotli" : encoding) as CompressionFormat
	return new Response(res.body.pipeThrough(new DecompressionStream(format))).text()
}

async function send(a: ReturnType<typeof app>, headers?: Record<string, string>) {
	const res = await a.fetch(request(headers), {})
	return { encoding: res.headers.get("content-encoding"), res, vary: res.headers.get("vary") }
}

describe("compress(): negotiation", () => {
	it.each([
		["br, gzip", "br"],
		["gzip, deflate", "gzip"],
		["GZIP", "gzip"],
		["gzip;q=1, br;q=0.5", "gzip"],
		["br;q=0, gzip", "gzip"],
		["*", "br"],
		["*;q=0.1, br;q=0", "gzip"],
		["identity", null],
		["deflate", null],
		["gzip;q=0", null],
		["gzip;q=abc", null],
	])("Accept-Encoding %j: %s", async (accept, expected) => {
		expect((await send(app(), { "accept-encoding": accept })).encoding).toBe(expected)
	})

	it("the body decodes to what the handler answered", async () => {
		const [br, gzip] = await Promise.all([
			send(app(), { "accept-encoding": "br" }),
			send(app(), { "accept-encoding": "gzip" }),
		])
		expect([await decoded(br.res), await decoded(gzip.res)]).toEqual([TEXT, TEXT])
	})

	it("Vary: Accept-Encoding on every answer it could have encoded, encoded or not", async () => {
		const [encoded, plain] = [await send(app(), { "accept-encoding": "gzip" }), await send(app(), {})]
		expect([encoded.vary, plain.vary, plain.encoding]).toEqual(["accept-encoding", "accept-encoding", null])
	})

	it("a runtime without brotli: gzip", async () => {
		const Native = globalThis.CompressionStream
		vi.stubGlobal(
			"CompressionStream",
			class extends Native {
				constructor(format: CompressionFormat) {
					if ((format as string) === "brotli") throw new TypeError("unsupported")
					super(format)
				}
			},
		)
		expect((await send(app(), { "accept-encoding": "br, gzip" })).encoding).toBe("gzip")
	})
})

describe("compress(): what it leaves alone", () => {
	it.each([
		["a body under the threshold", (ctx: Parameters<Route>[0]) => ctx.res.text("ok", "short")],
		[
			"a type that does not compress",
			(ctx: Parameters<Route>[0]) => ctx.res.text("ok", TEXT, { headers: { "content-type": "image/png" } }),
		],
		[
			"an answer already encoded",
			(ctx: Parameters<Route>[0]) => ctx.res.text("ok", TEXT, { headers: { "content-encoding": "gzip" } }),
		],
		[
			"Cache-Control: no-transform",
			(ctx: Parameters<Route>[0]) => ctx.res.text("ok", TEXT, { headers: { "cache-control": "no-transform" } }),
		],
		[
			"a 206 partial answer",
			(ctx: Parameters<Route>[0]) =>
				ctx.res.text("partial_content", TEXT, { headers: { "content-range": "bytes 0-2399/9999" } }),
		],
		[
			"a native response it has no raw body for",
			() => new Response(TEXT, { headers: { "content-type": "text/plain" } }),
		],
		["a raw body with no content type", () => withRawBody(new Response(new TextEncoder().encode(TEXT)), TEXT)],
	])("%s", async (_name, handler) => {
		/* the answer to a client that accepts br and gzip is the one a client accepting nothing gets */
		const a = app(handler as Route)
		const [negotiated, identity] = [await send(a, { "accept-encoding": "br, gzip" }), await send(a)]
		expect([negotiated.encoding, await negotiated.res.text()]).toEqual([identity.encoding, await identity.res.text()])
	})

	it("a produced stream is never buffered: a stream that never ends is answered at once, unencoded", async () => {
		const handler: Route = (ctx) =>
			ctx.res.stream(async (writable: WritableStream<Uint8Array>) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode(TEXT))
				await new Promise(() => {})
			})
		const answered = Promise.resolve(app(handler).fetch(request({ "accept-encoding": "gzip" }), {}))
		const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))
		const res = await Promise.race([answered, deadline])
		expect([res?.status, res?.headers.get("content-encoding")]).toEqual([200, null])
		await res?.body?.cancel()
	})

	it("an empty answer (204) is untouched", async () => {
		const { encoding, res } = await send(app(noContent), { "accept-encoding": "gzip" })
		expect([res.status, encoding, res.headers.get("vary")]).toEqual([204, null, null])
	})

	it("a 101 upgrade passes through untouched", async () => {
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		const res = await app(() => upgraded).fetch(request({ "accept-encoding": "gzip" }), {})
		expect(res).toBe(upgraded)
	})
})

describe("compress(): BREACH, the compressed length as a secret oracle", () => {
	it.each([
		["a request carrying a cookie", { cookie: "sid=s3cret" }, (ctx: Parameters<Route>[0]) => ctx.res.text("ok", TEXT)],
		[
			"a request carrying Authorization",
			{ authorization: "Bearer t0ken" },
			(ctx: Parameters<Route>[0]) => ctx.res.text("ok", TEXT),
		],
		[
			"an answer setting a cookie",
			{},
			(ctx: Parameters<Route>[0]) => ctx.res.text("ok", TEXT, { headers: { "set-cookie": "sid=new; HttpOnly" } }),
		],
	])("%s is not compressed by default", async (_name, headers, handler) => {
		const { encoding } = await send(app(handler as Route), { "accept-encoding": "gzip", ...headers })
		expect(encoding).toBeNull()
	})

	it("credentialed: true compresses them anyway, for an app whose answers carry no secret beside reflected input", async () => {
		const { encoding } = await send(app(undefined, { credentialed: true }), {
			"accept-encoding": "gzip",
			cookie: "sid=s3cret",
		})
		expect(encoding).toBe("gzip")
	})
})

describe("compress(): the plain path", () => {
	it("on a Node-bridge answer it encodes the retained raw body, never reading the stream, and stays a HoneyResponse", async () => {
		const res = await app().fetch(request({ "accept-encoding": "gzip" }, { node: true }), {})
		const raw = rawBodyOf(res) as Uint8Array
		const roundTrip = await new Response(
			new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")),
		).text()
		expect([isHoneyResponse(res), res.headers.get("content-encoding"), roundTrip === TEXT]).toEqual([
			true,
			"gzip",
			true,
		])
	})

	it("a binary raw body (static files, a middleware's own answer) is encoded from its bytes", async () => {
		const bytes = new TextEncoder().encode(TEXT)
		const handler: Route = () =>
			withRawBody(new Response(bytes, { headers: { "content-type": "application/json" } }), bytes)
		const { encoding, res } = await send(app(handler), { "accept-encoding": "gzip" })
		expect([encoding, await decoded(res)]).toEqual(["gzip", TEXT])
	})

	it("a stale Content-Length the handler set is dropped", async () => {
		const handler: Route = (ctx) => ctx.res.text("ok", TEXT, { headers: { "content-length": String(TEXT.length) } })
		const { encoding, res } = await send(app(handler), { "accept-encoding": "gzip" })
		expect([encoding, res.headers.get("content-length")]).toEqual(["gzip", null])
	})
})

describe("compress(): construction", () => {
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a threshold of %s", (threshold) => {
		expect(() => compress({ threshold })).toThrow("compress: threshold must be a finite number of bytes, 0 or more")
	})

	it("a threshold of 0 compresses the smallest body", async () => {
		const { encoding } = await send(
			app((ctx) => ctx.res.text("ok", "x"), { threshold: 0 }),
			{ "accept-encoding": "gzip" },
		)
		expect(encoding).toBe("gzip")
	})
})
