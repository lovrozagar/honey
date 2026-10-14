/**
 * The in-process adversarial suite (F1, 00-rules "Security gate"): hostile inputs driven through
 * `app.fetch`, each a failing input first and the guard that answers it second. Every middleware
 * bit adds its cases; the mutation harness reruns this file with each guard disabled and requires
 * it to go red.
 */
import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolve(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* the app under test is v0 until the cutover swap (H21); each bit retargets its cases as v1 lands */
const { honey } = (await import(resolve(REPO, "_v0/src/index.ts"))) as typeof import("../../../../../_v0/src/index.ts")

/* v1, from bit 02 on: imported after the mock, so a mutant reaches every module that uses it */
const v1 = (await import(
	resolve(REPO, "packages/core/src/routing/app.ts")
)) as typeof import("../../../src/routing/app.ts")
const { createMiddleware } = (await import(
	resolve(REPO, "packages/core/src/middleware/middleware.ts")
)) as typeof import("../../../src/middleware/middleware.ts")
const { serve: serveNode } = (await import(
	resolve(REPO, "packages/core/src/adapters/node/serve.ts")
)) as typeof import("../../../src/adapters/node/serve.ts")
const { rangeResponse } = (await import(
	resolve(REPO, "packages/core/src/response/range.ts")
)) as typeof import("../../../src/response/range.ts")
const { withHeaders } = (await import(
	resolve(REPO, "packages/core/src/response/with-headers.ts")
)) as typeof import("../../../src/response/with-headers.ts")
const { createCookieSigner } = (await import(
	resolve(REPO, "packages/core/src/context/cookie-sign.ts")
)) as typeof import("../../../src/context/cookie-sign.ts")

function filesApp() {
	return honey()
		.get("/files/:name")
		.handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))
}

async function fetchPath(path: string): Promise<Response> {
	return filesApp().fetch(new Request(`http://app.test${path}`), {})
}

describe("adversarial: scope bypass via path normalization", () => {
	it("serves an ordinary param", async () => {
		const res = await fetchPath("/files/report")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ name: "report" })
	})

	it("rejects an encoded / before it can reach a param", async () => {
		expect((await fetchPath("/files/x%2F..%2Fsecret")).status).toBe(400)
		expect((await fetchPath("/files/x%2f..%2fsecret")).status).toBe(400)
	})

	it("rejects an encoded \\ the same way", async () => {
		expect((await fetchPath("/files/a%5Cb")).status).toBe(400)
	})

	it("resolves dot segments before matching, so they never escape the route", async () => {
		expect((await fetchPath("/files/../admin")).status).toBe(404)
	})
})

/** A sub with a scope on /admin, a wildcard and a catch-all param, mounted under /api. */
function guardedMount() {
	const sub = v1.honey<{}>()
	sub.use(
		"/admin",
		createMiddleware(() => new Response("denied", { status: 401 })),
	)
	sub.get("/admin/secret").handler((ctx) => ctx.res.text("ok", "SECRET"))
	sub.get("/files/*rest").handler((ctx) => ctx.res.text("ok", `file:${ctx.params.rest}`))
	sub.get("/:slug").handler((ctx) => ctx.res.text("ok", `slug:${ctx.params.slug}`))
	return v1.honey<{}>().route("/api", sub)
}

async function answer(
	app: { fetch: (r: Request, env: never) => Response | Promise<Response> },
	target: string,
	init?: RequestInit,
) {
	const res = await app.fetch(new Request(`http://app.test${target}`, init), {} as never)
	return { body: await res.text(), status: res.status }
}

/** A request whose url is the raw target, unresolved, as an adapter that skips URL parsing hands it on. */
function rawRequest(target: string): Request {
	const request = new Request("http://app.test/")
	Object.defineProperty(request, "url", { value: `http://app.test${target}` })
	return request
}

async function answerRaw(target: string) {
	const res = await guardedMount().fetch(rawRequest(target), {})
	return { body: await res.text(), status: res.status }
}

describe("v1 adversarial: a scope inside a mount, reached by another spelling", () => {
	it.each([
		"/api/admin/secret",
		"/api//admin/secret",
		"//api/admin/secret",
		"/api/./admin/secret",
		"/api/x/../admin/secret",
		"/api/../api/admin/secret",
		"/api/files/../admin/secret",
		"/api/files/%2e%2e/admin/secret",
		"/api/files/.%2e/admin/secret",
		"/api/%61dmin/secret",
		"/api/admin/secret/",
	])("%s, sent raw, is denied by the scope", async (target) => {
		expect(await answerRaw(target)).toEqual({ body: "denied", status: 401 })
	})

	it.each([
		"/api/admin%2fsecret",
		"/api/admin%2Fsecret",
		"/api/files/..%2fadmin%2fsecret",
		"/api/files/a%5c..%5cadmin",
		"/api/%2fadmin/secret",
	])("%s, an encoded separator sent raw, is a 400 before any route", async (target) => {
		const { body, status } = await answerRaw(target)
		expect([status, (JSON.parse(body) as { error_key: string }).error_key]).toEqual([400, "bad_request"])
	})

	it("a double-encoded dot segment stays literal inside the wildcard, never decoded twice", async () => {
		expect(await answerRaw("/api/files/%252e%252e/admin/secret")).toEqual({
			body: "file:%2e%2e/admin/secret",
			status: 200,
		})
	})
})

/** A small seeded generator, so a failing fuzz case reproduces. */
function rng(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const HOSTILE = [
	"\r",
	"\n",
	";",
	",",
	"=",
	'"',
	"\\",
	" ",
	"\t",
	"\u0000",
	"%",
	"%0d%0a",
	"é",
	"🍯",
	"Set-Cookie: evil=1",
	"a",
	"Z",
	"9",
	"-",
	".",
]

/** An app that sets the cookie value it is given, and reads the cookie it is sent. */
function cookieEcho() {
	const app = v1.honey<{}>()
	app.get("/set").handler((ctx) => ctx.res.json("ok", {}, { cookies: { f: { value: ctx.search.v ?? "" } } }))
	app
		.get("/read")
		.handler((ctx) => ctx.res.json("ok", { f: ctx.cookies.f ?? null, proto: Object.getPrototypeOf(ctx.cookies) }))
	return app
}

describe("v1 adversarial: cookie codec fuzz", () => {
	it("any value, hostile characters included, is one Set-Cookie line that comes back unchanged", async () => {
		const next = rng(0x5eed)
		const app = cookieEcho()
		for (let i = 0; i < 300; i++) {
			const value = Array.from(
				{ length: 1 + Math.floor(next() * 8) },
				() => HOSTILE[Math.floor(next() * HOSTILE.length)],
			).join("")
			const set = await app.fetch(new Request(`http://app.test/set?v=${encodeURIComponent(value)}`), {})
			const lines = set.headers.getSetCookie()
			expect([set.status, lines.length, /[\r\n]/.test(lines[0] ?? "")], JSON.stringify(value)).toEqual([200, 1, false])
			const pair = (lines[0] as string).split(";")[0] as string
			expect(await answer(app, "/read", { headers: { cookie: pair } })).toEqual({
				body: JSON.stringify({ f: value, proto: null }),
				status: 200,
			})
		}
	})

	it("a header named like Object.prototype members reads as plain cookies and pollutes nothing", async () => {
		const header = "__proto__=x; constructor=y; toString=z; polluted=1"
		const app = v1.honey<{}>()
		app
			.get("/t")
			.handler((ctx) => ctx.res.json("ok", { names: Object.keys(ctx.cookies), toString: ctx.cookies.toString ?? null }))
		expect(await answer(app, "/t", { headers: { cookie: header } })).toEqual({
			body: JSON.stringify({ names: ["__proto__", "constructor", "toString", "polluted"], toString: "z" }),
			status: 200,
		})
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})
})

describe("v1 adversarial: signed-cookie tamper", () => {
	it("only the untouched value under a known secret and its name verifies", async () => {
		const signer = createCookieSigner(["current", "previous"])
		const signed = await signer.sign("u-42", { name: "sid" })
		const rotated = await createCookieSigner(["previous"]).sign("u-42", { name: "sid" })
		const tampered = [
			signed.replace("u-42", "u-43"),
			`${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`,
			signed.slice(0, -3),
			"u-42",
			"u-42.",
			`${signed}.x`,
			await createCookieSigner(["stranger"]).sign("u-42", { name: "sid" }),
			await signer.sign("u-42", { name: "other" }),
		]
		expect(await signer.verify(signed, { legacy: false, name: "sid" })).toBe("u-42")
		expect(await signer.verify(rotated, { legacy: false, name: "sid" })).toBe("u-42")
		for (const value of tampered) expect(await signer.verify(value, { legacy: false, name: "sid" }), value).toBeNull()
	})
})

/**
 * The Node bridge on a real socket: /public and /admin record that they ran; /echo reads the body;
 * /inject sets a header value carrying CR/LF. `use` gets raw bytes in, every byte out.
 */
async function withBridge(use: (send: (bytes: string) => Promise<string>, ran: string[]) => Promise<void>) {
	const ran: string[] = []
	const app = v1.honey<{}>()
	for (const path of ["/public", "/admin"]) {
		app.all(path).handler((ctx) => {
			ran.push(path)
			return ctx.res.text("ok", path)
		})
	}
	app.post("/echo").handler(async (ctx) => {
		ran.push(`echo:${(await ctx.req.text()).length}`)
		return ctx.res.text("ok", "read")
	})
	app.get("/inject").handler((ctx) => ctx.res.text("ok", "x", { headers: { "x-a": "1\r\nset-cookie: pwned=1" } }))
	/* what a proxied upstream can hand back: its own framing, its connection's headers, a length it decoded */
	app
		.get("/framed")
		.handler((ctx) =>
			ctx.res.raw(new Response("abc", { headers: { "content-length": "3", "transfer-encoding": "chunked" } })),
		)
	app
		.get("/leaky")
		.handler((ctx) =>
			ctx.res.raw(new Response("abc", { headers: { connection: "x-internal", "x-internal": "secret" } })),
		)
	app
		.get("/lying")
		.handler((ctx) =>
			ctx.res.raw(new Response(new Blob(["abc"]).stream(), { headers: { "content-length": "999999" } })),
		)
	const server = serveNode(app, { env: {}, hostname: "127.0.0.1", maxRequestBodySize: 64, onError: () => {}, port: 0 })
	await new Promise((done) => server.once("listening", done))
	const { port } = server.address() as AddressInfo
	const send = (bytes: string) =>
		new Promise<string>((done) => {
			const socket = connect(port, "127.0.0.1")
			let out = ""
			socket.on("data", (chunk) => (out += chunk.toString("latin1")))
			socket.on("close", () => done(out))
			socket.on("error", () => {})
			socket.end(bytes)
		})
	try {
		await use(send, ran)
	} finally {
		await server.shutdown(0)
	}
}

const head = (raw: string) => raw.split("\r\n")[0]

describe("v1 adversarial: request smuggling at the node:http bridge", () => {
	it.each([
		[
			"Content-Length beside Transfer-Encoding",
			"POST /public HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /admin HTTP/1.1\r\nHost: h\r\n\r\n",
		],
		[
			"two different Content-Lengths",
			"POST /public HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\nContent-Length: 5\r\n\r\nabcde",
		],
		["a folded header line", "GET /public HTTP/1.1\r\nHost: h\r\nX-A: a\r\n b\r\n\r\n"],
		[
			"a Transfer-Encoding not ending in chunked",
			"POST /public HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked, identity\r\n\r\n0\r\n\r\n",
		],
		["bare LF line endings", "GET /public HTTP/1.1\nHost: h\n\n"],
		["whitespace before a header colon", "GET /public HTTP/1.1\r\nHost : h\r\n\r\n"],
		["a second Host header", "GET /public HTTP/1.1\r\nHost: h\r\nHost: evil.example\r\n\r\n"],
		["a Host that moves the path", "GET /public HTTP/1.1\r\nHost: h/admin?\r\n\r\n"],
	])("%s: 400, and no route runs", async (_case, bytes) => {
		await withBridge(async (send, ran) => {
			expect([head(await send(bytes)), ran]).toEqual(["HTTP/1.1 400 Bad Request", []])
		})
	})

	it("an oversized header set: 431, and the server keeps serving", async () => {
		await withBridge(async (send, ran) => {
			const huge = await send(`GET /public HTTP/1.1\r\nHost: h\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`)
			const next = await send("GET /public HTTP/1.1\r\nHost: h\r\n\r\n")
			expect([head(huge), head(next), ran]).toEqual([
				"HTTP/1.1 431 Request Header Fields Too Large",
				"HTTP/1.1 200 OK",
				["/public"],
			])
		})
	})

	it("a body over the cap: 413, and the handler never holds the bytes", async () => {
		await withBridge(async (send, ran) => {
			const raw = await send(`POST /echo HTTP/1.1\r\nHost: h\r\nContent-Length: 1000\r\n\r\n${"x".repeat(1000)}`)
			expect([head(raw), ran]).toEqual(["HTTP/1.1 413 Payload Too Large", []])
		})
	})
})

describe("v1 adversarial: response splitting at the node:http bridge", () => {
	it("a header value carrying CR/LF: 500, one response, no injected header", async () => {
		await withBridge(async (send) => {
			const raw = await send("GET /inject HTTP/1.1\r\nHost: h\r\n\r\n")
			expect([head(raw), raw.split("HTTP/1.1 ").length - 1, raw.includes("pwned")]).toEqual([
				"HTTP/1.1 500 Internal Server Error",
				1,
				false,
			])
		})
	})
})

describe("v1 adversarial: response splitting through a middleware's header edit", () => {
	it("a CR/LF reaching the plain header path of a HoneyResponse is refused: 500, and no header carries it", async () => {
		const app = v1.honey<{}>()
		const echo = createMiddleware(async (ctx: { req: Request }, next) => {
			const value = new URL(ctx.req.url).searchParams.get("v") ?? ""
			return withHeaders(await next(), (headers) => headers.set("x-echo", value))
		})
		app
			.use(echo)
			.get("/echo")
			.handler((ctx) => ctx.res.text("ok", "x"))
		const req = new Request("http://app.test/echo?v=a%0d%0ax-injected:%201")
		/* marked as the node bridge marks its requests, so ctx.res builds the plain-map HoneyResponse */
		Object.defineProperty(req, Symbol.for("honey.nodeOut"), { value: true })
		const res = await app.fetch(req, {})
		const carried = [...res.headers].some(([, value]) => /[\r\n]/.test(value))
		expect([res.status, res.headers.get("x-injected"), carried]).toEqual([500, null, false])
	})
})

describe("v1 adversarial: response framing at the node:http bridge", () => {
	it("an upstream's Transfer-Encoding beside its Content-Length: one framing on the wire, Node's", async () => {
		await withBridge(async (send) => {
			const raw = (await send("GET /framed HTTP/1.1\r\nHost: h\r\n\r\n")).toLowerCase()
			expect([
				raw.includes("transfer-encoding"),
				raw.includes("content-length: 3"),
				raw.endsWith("\r\n\r\nabc"),
			]).toEqual([false, true, true])
		})
	})

	it("a header the upstream's Connection named stays on the upstream's connection", async () => {
		await withBridge(async (send) => {
			expect((await send("GET /leaky HTTP/1.1\r\nHost: h\r\n\r\n")).toLowerCase()).not.toContain("x-internal")
		})
	})

	it("a decoded stream's stale length never desynchronizes keep-alive: two answers, each whole", async () => {
		await withBridge(async (send) => {
			const raw = await send("GET /lying HTTP/1.1\r\nHost: h\r\n\r\nGET /public HTTP/1.1\r\nHost: h\r\n\r\n")
			expect([raw.includes("999999"), raw.split("HTTP/1.1 200 OK").length - 1, raw.includes("/public")]).toEqual([
				false,
				2,
				true,
			])
		})
	})
})

/** Streaming routes for the memory and injection cases; `seen` records what each producer did. */
function streamingRoutes() {
	const seen = { produced: 0, released: false }
	const app = v1.honey<{}>()
	app.get("/flood").handler((ctx) =>
		ctx.res.stream(async (writable, signal) => {
			signal.addEventListener("abort", () => (seen.released = true))
			const writer = writable.getWriter()
			/* bounded so a mutant without backpressure ends instead of spinning */
			for (let i = 0; i < 5_000 && !signal.aborted; i++) {
				await writer.write(new Uint8Array(1024))
				seen.produced++
			}
		}),
	)
	app.get("/events").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			await stream.send({ data: "ok", event: "m", id: ctx.search.id ?? "1" })
		}),
	)
	return { app, seen }
}

describe("v1 adversarial: a slow or departed client never grows the server's memory", () => {
	it("a producer facing a reader that stopped reading waits: one chunk past demand, no more", async () => {
		const { app, seen } = streamingRoutes()
		const reader = (
			(await app.fetch(new Request("http://app.test/flood"), {})).body as ReadableStream<Uint8Array>
		).getReader()
		await reader.read()
		await new Promise((done) => setTimeout(done, 30))
		const held = seen.produced
		await reader.cancel()
		expect([held <= 1, seen.released]).toEqual([true, true])
	})
})

describe("v1 adversarial: SSE field injection", () => {
	it.each([
		["CRLF and a data field", "1\r\ndata: injected"],
		["LF and a retry field", "1\nretry: 1"],
		["CR and an event field", "1\revent: admin"],
	])("an id from the request carrying %s breaks the stream instead of writing the field", async (_case, id) => {
		const { app } = streamingRoutes()
		/* a query value can carry CR and LF; a header value cannot */
		const send = async (value: string) =>
			(await app.fetch(new Request(`http://app.test/events?id=${encodeURIComponent(value)}`), {}))
				.text()
				.catch(() => "broken")
		expect([await send("safe"), await send(id)]).toEqual(["event: m\ndata: ok\nid: safe\n\n", "broken"])
	})
})

describe("v1 adversarial: absurd ranges", () => {
	const TEN = new TextEncoder().encode("0123456789")

	it.each([
		["a 10 000-digit position", `bytes=${"9".repeat(10_000)}-`],
		["100 000 ranges", `bytes=${"0-0,".repeat(100_000)}0-0`],
		["a 10 000-digit suffix", `bytes=-${"1".repeat(10_000)}`],
	])("%s: the whole body, 200, answered at once", async (_case, range) => {
		const started = performance.now()
		const res = rangeResponse(new Request("http://app.test/f", { headers: { range } }), TEN)
		expect([res.status, await res.text(), performance.now() - started < 50]).toEqual([200, "0123456789", true])
	})
})
