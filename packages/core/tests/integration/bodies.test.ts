/**
 * Request and response bodies through the app. JSON, form, multipart, binary and text request
 * bodies read through ctx.req arrive intact (size, nesting, unicode, escapes, files); a body the
 * handler cannot parse is its own to catch; every response helper and status key answers as
 * declared, in process and on the wire.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { honey } from "../../src/routing/app.ts"

type App = { fetch(request: Request, env: {}): Response | Promise<Response> }

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

/** Serve `app` on a free loopback port; the base URL to reach it. */
async function listen(app: App): Promise<string> {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function send(app: App, path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init), {})
}

function post(path: string, body: BodyInit, type?: string, method = "POST"): [string, RequestInit] {
	return [path, { body, headers: type === undefined ? {} : { "content-type": type }, method }]
}

/** A sum of the bytes, modulo the largest prime under 2^16. */
const checksum = (bytes: Uint8Array) => bytes.reduce((sum, byte) => (sum + byte) % 65_521, 0)

/** A file entry as a handler sees it: its name, size and type. */
const fileOf = (file: File) => ({ name: file.name, size: file.size, type: file.type })

/** Routes that read the request body through ctx.req and answer with what they read. */
function readerApp() {
	const app = honey<{}>()
	app.on(["POST", "PUT", "PATCH"], "/json").handler(async (ctx) => ctx.res.json("ok", { body: await ctx.req.json() }))
	app.post("/json-or-400").handler(async (ctx) => {
		try {
			return ctx.res.json("ok", { body: await ctx.req.json() })
		} catch (error) {
			return ctx.res.json("bad_request", { error: (error as Error).name })
		}
	})
	app.post("/form").handler(async (ctx) => {
		const entries = [...(await ctx.req.formData())]
		return ctx.res.json(
			"ok",
			entries.map(([key, value]) => [key, typeof value === "string" ? value : fileOf(value)]),
		)
	})
	app.post("/bytes").handler(async (ctx) => {
		const bytes = new Uint8Array(await ctx.req.arrayBuffer())
		return ctx.res.json("ok", { size: bytes.length, sum: checksum(bytes) })
	})
	app.post("/text").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
	app.post("/empty").handler((ctx) => ctx.res.json("ok", { action: "done" }))
	return app
}

async function json(res: Response | Promise<Response>): Promise<[number, unknown]> {
	const answer = await res
	return [answer.status, await answer.json()]
}

let ascii = ""
for (let code = 32; code < 127; code++) ascii += String.fromCharCode(code)

describe("JSON request bodies read through ctx.req", () => {
	// v0: 09dfe5695b
	// v0: fb78b4d020
	// v0: 69d65337a8
	// v0: 91022d1ca5
	// v0: 9d4ff17c66
	// v0: c0cad5613d
	// v0: ac169ee62c
	it.each([
		["a string as the root", "just a string"],
		["every falsy value", { a: null, b: 0, c: false, d: "", e: [] }],
		["numbers at the edges", { big: 9_007_199_254_740_991, float: 1.234_56, neg: -42, zero: 0 }],
		["unicode and emoji", { emoji: "🔥🎉", japanese: "こんにちは", russian: "Привет" }],
		[
			"every escape",
			{ backslash: "a\\b", newlines: "1\n2\r3\r\n4", nul: "a\u0000b", quotes: 'say "hi"', tabs: "a\tb", u: "Aé世🚀" },
		],
		["every printable ASCII character", { ascii }],
	])("%s arrives as sent", async (_label, body) => {
		expect(await json(send(readerApp(), ...post("/json", JSON.stringify(body), "application/json")))).toEqual([
			200,
			{ body },
		])
	})

	// v0: 1cad912a67
	// v0: 4e0282c089
	// v0: 7504577dbc
	// v0: ae20be3e66
	it.each([
		["PUT", "application/json"],
		["PATCH", "application/json"],
		["POST", "application/json; charset=utf-8"],
	])("%s with %s is read the same", async (method, type) => {
		const request = post("/json", JSON.stringify({ name: "updated" }), type, method)
		expect(await json(send(readerApp(), ...request))).toEqual([200, { body: { name: "updated" } }])
	})

	// v0: 3e8a37c7d0
	// v0: 83c78bcf94
	it.each([
		["malformed JSON", "{ invalid json !!!"],
		["an empty body", ""],
	])("%s is the handler's to catch: ctx.req.json() rejects with a SyntaxError", async (_label, body) => {
		const request = post("/json-or-400", body, "application/json")
		expect(await json(send(readerApp(), ...request))).toEqual([400, { error: "SyntaxError" }])
	})
})

/** `{ child: … }` wrapped `depth` times around a leaf. */
function nested(depth: number): unknown {
	let value: unknown = { leaf: true }
	for (let level = 0; level < depth; level++) value = { child: value }
	return value
}

describe("large and deep JSON request bodies", () => {
	// v0: f11f6f29fd
	// v0: c0f5807fbc
	// v0: 9188ad4a31
	// v0: 7c289b18cf
	// v0: 2722328ea1
	// v0: c811b9e7ec
	// v0: 0d1ddfee03
	it.each([
		["100KB over 1000 keys", Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key_${i}`, "x".repeat(90)]))],
		[
			"10000 keys at the root",
			Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`field_${i}`, `val_${i}`])),
		],
		["an array of 10000 items", Array.from({ length: 10_000 }, (_, id) => ({ id, name: `item-${id}` }))],
		["5MB", { items: Array.from({ length: 50_000 }, (_, id) => ({ data: "x".repeat(80), id, tags: ["a", "b"] })) }],
		["a 1MB string", { data: "A".repeat(1024 * 1024) }],
		["100 levels deep", nested(100)],
		["500 levels deep", nested(500)],
	])("%s arrives whole", async (_label, body) => {
		expect(await json(send(readerApp(), ...post("/json", JSON.stringify(body), "application/json")))).toEqual([
			200,
			{ body },
		])
	})
})

describe("urlencoded bodies read through ctx.req", () => {
	// v0: 2fb40fd897
	// v0: e6ca652fe0
	// v0: 0e57873dce
	// v0: d31dc388b1
	it.each([
		[
			"repeated keys, in order",
			"tag=a&tag=b&tag=c",
			[
				["tag", "a"],
				["tag", "b"],
				["tag", "c"],
			],
		],
		["no fields", "", []],
		[
			"+ and escapes decoded",
			"name=John+Doe&email=user%40example.com&msg=hello%26world",
			[
				["name", "John Doe"],
				["email", "user@example.com"],
				["msg", "hello&world"],
			],
		],
		["unicode", `name=${encodeURIComponent("日本語テスト")}`, [["name", "日本語テスト"]]],
	])("urlencoded with %s", async (_label, body, entries) => {
		const request = post("/form", body, "application/x-www-form-urlencoded")
		expect(await json(send(readerApp(), ...request))).toEqual([200, entries])
	})
})

describe("multipart bodies read through ctx.req", () => {
	// v0: 00f68bdc78
	// v0: 8113874e70
	// v0: 018d0aa093
	// v0: e6e80a9b0d
	// v0: d0430b041d
	// v0: 08960cfff7
	it("multipart: text fields and files, several under one name, an empty one, each name and type kept", async () => {
		const form = new FormData()
		form.append("name", "Alice")
		form.append("description", "A beautiful sunset 🌅")
		form.append("nombre_archivo", "test")
		form.append("avatar", new Blob(["hello world image data"], { type: "image/png" }), "avatar.png")
		for (const content of ["doc1 content", "doc2 content longer", "d3"])
			form.append("docs", new Blob([content], { type: "text/plain" }), `${content.slice(0, 4)}.txt`)
		form.append("binary", new Blob([new Uint8Array([0, 255, 128])], { type: "application/octet-stream" }), "data.bin")
		form.append("empty", new Blob([], { type: "text/plain" }), "empty.txt")
		const [status, entries] = await json(send(readerApp(), ...post("/form", form)))
		expect([status, entries]).toEqual([
			200,
			[
				["name", "Alice"],
				["description", "A beautiful sunset 🌅"],
				["nombre_archivo", "test"],
				["avatar", { name: "avatar.png", size: 22, type: "image/png" }],
				["docs", { name: "doc1.txt", size: 12, type: "text/plain" }],
				["docs", { name: "doc2.txt", size: 19, type: "text/plain" }],
				["docs", { name: "d3.txt", size: 2, type: "text/plain" }],
				["binary", { name: "data.bin", size: 3, type: "application/octet-stream" }],
				["empty", { name: "empty.txt", size: 0, type: "text/plain" }],
			],
		])
	})
})

/** `size` bytes counting 0..255 over and over, and the size and checksum /bytes answers for them. */
function counting(size: number): [Uint8Array<ArrayBuffer>, { size: number; sum: number }] {
	const bytes = new Uint8Array(size)
	for (let i = 0; i < size; i++) bytes[i] = i % 256
	return [bytes, { size, sum: checksum(bytes) }]
}

describe("multipart files and binary bodies arrive byte for byte", () => {
	// v0: 87893bc98c
	// v0: 184fe84896
	// v0: 022e2d7f2b
	// v0: 07ca7696e7
	it("a file of 8 bytes, 1MB or 5MB, and 50 files in one request", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const files = [...(await ctx.req.formData()).values()].filter((value) => typeof value !== "string")
			const sums = await Promise.all(files.map(async (file) => checksum(new Uint8Array(await file.arrayBuffer()))))
			return ctx.res.json("ok", { count: files.length, sizes: files.map((file) => file.size), sums })
		})
		const original = new Uint8Array([0, 1, 127, 128, 254, 255, 0, 42])
		const [mega, megaSum] = counting(1024 * 1024)
		const [five, fiveSum] = counting(5 * 1024 * 1024)
		const form = new FormData()
		form.append("data", new Blob([original]), "data.bin")
		form.append("big", new Blob([mega]), "big.bin")
		form.append("huge", new Blob([five]), "huge.bin")
		expect(await json(send(app, ...post("/upload", form)))).toEqual([
			200,
			{ count: 3, sizes: [8, megaSum.size, fiveSum.size], sums: [checksum(original), megaSum.sum, fiveSum.sum] },
		])
		const many = new FormData()
		for (let i = 0; i < 50; i++) many.append(`file_${i}`, new Blob([`file ${i} ${"x".repeat(100)}`]), `file_${i}.txt`)
		expect(((await json(send(app, ...post("/upload", many))))[1] as { count: number }).count).toBe(50)
	})

	// v0: 03fd9a7b08
	// v0: 471051f241
	// v0: 5726497c0e
	it.each([1024 * 1024, 0, 256])("%i bytes of octet-stream arrive whole", async (size) => {
		const [bytes, read] = counting(size)
		expect(await json(send(readerApp(), ...post("/bytes", bytes, "application/octet-stream")))).toEqual([200, read])
	})

	// v0: 626c1c9f12
	// v0: 1c5ea97bde
	// v0: 78f8efa0ba
	// v0: d75e5c808a
	it("text is readable as bytes or text, whatever its type; a POST may carry no body and no type", async () => {
		const xml = `<?xml version="1.0"?><request><item>1</item></request>`
		const app = readerApp()
		expect(await json(send(app, ...post("/bytes", "hello binary", "text/plain")))).toEqual([
			200,
			{ size: 12, sum: [..."hello binary"].reduce((sum, c) => sum + c.charCodeAt(0), 0) },
		])
		const texts = await Promise.all(
			[post("/text", "plain text content here", "text/plain"), post("/text", xml, "application/xml")].map(
				async (request) => (await send(app, ...request)).text(),
			),
		)
		expect(texts).toEqual(["plain text content here", xml])
		expect(await json(send(app, "/empty", { method: "POST" }))).toEqual([200, { action: "done" }])
	})
})

describe("every response helper in process", () => {
	// v0: 893bf8aea3
	// v0: 1e22b5976e
	// v0: 0a1166c9bd
	// v0: 0de05eedd3
	// v0: c728e4b85c
	// v0: 720ce6de0c
	// v0: 0c5b02a152
	it("empty bodies, a 204 on DELETE and OPTIONS, and option headers beside the content type", async () => {
		const app = honey<{}>()
		app.get("/html").handler((ctx) => ctx.res.html("ok", ""))
		app.get("/text").handler((ctx) => ctx.res.text("ok", ""))
		app.get("/array").handler((ctx) => ctx.res.json("ok", []))
		app.get("/object").handler((ctx) => ctx.res.json("ok", {}))
		app.delete("/resource/:id").handler((ctx) => ctx.res.noContent({ headers: { "x-id": ctx.params.id } }))
		app.options("/data").handler((ctx) => ctx.res.noContent({ headers: { allow: "GET, POST, OPTIONS" } }))
		app
			.get("/custom")
			.handler((ctx) => ctx.res.json("ok", { data: 1 }, { headers: { "cache-control": "max-age=3600", "x-api": "2" } }))
		const seen = async (path: string, method = "GET", ...names: string[]) => {
			const res = await send(app, path, { method })
			return [res.status, ...names.map((name) => res.headers.get(name)), await res.text()]
		}
		expect([
			await seen("/html", "GET", "content-type"),
			await seen("/text", "GET", "content-type"),
			await seen("/array"),
			await seen("/object"),
			await seen("/resource/42", "DELETE", "x-id"),
			await seen("/data", "OPTIONS", "allow"),
			await seen("/custom", "GET", "content-type", "cache-control", "x-api"),
		]).toEqual([
			[200, "text/html; charset=utf-8", ""],
			[200, "text/plain; charset=utf-8", ""],
			[200, "[]"],
			[200, "{}"],
			[204, "42", ""],
			[204, "GET, POST, OPTIONS", ""],
			[200, "application/json", "max-age=3600", "2", '{"data":1}'],
		])
	})
})

describe("every status key on every response helper", () => {
	// v0: 968e9b858a
	// v0: 5f868f48cd
	// v0: 30759eec90
	// v0: 382e89fb62
	// v0: bfc3720ea2
	it("each status key answers its code on every helper", async () => {
		const keys = {
			accepted: 202,
			bad_request: 400,
			conflict: 409,
			created: 201,
			forbidden: 403,
			internal_server_error: 500,
			not_found: 404,
			ok: 200,
			too_many_requests: 429,
			unauthorized: 401,
			unprocessable_entity: 422,
		} as const
		const app = honey<{}>()
		app.get("/:helper/:key").handler((ctx) => {
			const key = ctx.params.key as keyof typeof keys
			const helper = ctx.params.helper as "csv" | "html" | "text" | "xml"
			return ctx.params.helper === "json" ? ctx.res.json(key, {}) : ctx.res[helper](key, "body")
		})
		const answers: Record<string, number[]> = {}
		for (const helper of ["json", "text", "html", "csv", "xml"]) {
			answers[helper] = []
			for (const key of Object.keys(keys)) answers[helper].push((await send(app, `/${helper}/${key}`)).status)
		}
		const codes = Object.values(keys)
		expect(answers).toEqual({ csv: codes, html: codes, json: codes, text: codes, xml: codes })
	})
})

const CJK = "Chinese: 世界你好 Japanese: こんにちは Korean: 안녕하세요"
const QUOTED_CSV = `name,description,price\n"Widget, Inc.","A ""great"" product",19.99\nGadget,"Simple item",5.00`
const HTML_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><h1>Hello</h1><script>alert("x")</script></body></html>`
const NS_XML = `<?xml version="1.0"?><root xmlns:ns="http://example.com"><ns:item id="1">Value &amp; More</ns:item></root>`
const BIG_OBJECT = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, "x".repeat(200)]))
const BIG_TEXT = "line\n".repeat(50_000)

/** An app answering each helper's specimen, a raw response, a 204 and a redirect. */
function helpersApp() {
	const app = honey<{}>()
	app.get("/text").handler((ctx) => ctx.res.text("ok", `Héllo Wörld 🌍 日本語 Привет ${CJK}`))
	app.get("/csv").handler((ctx) => ctx.res.csv("ok", QUOTED_CSV))
	app.get("/html").handler((ctx) => ctx.res.html("ok", HTML_DOC))
	app.get("/xml").handler((ctx) => ctx.res.xml("ok", NS_XML))
	app
		.get("/raw")
		.handler((ctx) =>
			ctx.res.raw(
				new Response("custom body", { headers: { "content-type": "text/markdown", "x-custom": "raw" }, status: 201 }),
			),
		)
	app
		.get("/teapot")
		.handler((ctx) => ctx.res.raw(new Response("raw body", { headers: { "x-custom": "yes" }, status: 418 })))
	app.delete("/item").handler((ctx) => ctx.res.noContent())
	app.get("/old").handler((ctx) => ctx.res.redirect("/new?foo=bar&baz=qux", { status: 307 }))
	app.get("/big-json").handler((ctx) => ctx.res.json("ok", BIG_OBJECT))
	app.get("/big-text").handler((ctx) => ctx.res.text("ok", BIG_TEXT))
	return app
}

describe("every response helper on the wire", () => {
	// v0: c6ab40fa9b
	// v0: 078f772779
	// v0: 2d8c562a10
	// v0: 0037faa1ed
	// v0: cc5744244c
	// v0: 3486d537f6
	// v0: ae04c2c9b4
	// v0: 26d7faf666
	// v0: ee80ee6ab6
	// v0: 2dde6e6159
	// v0: cece5f9337
	// v0: b338d4fd38
	it("each answers its status, content type, headers and exact body", async () => {
		const base = await listen(helpersApp())
		const wire = async (path: string, method = "GET") => {
			const res = await fetch(`${base}${path}`, { method, redirect: "manual" })
			const named = ["content-type", "x-custom", "location"].map((name) => res.headers.get(name))
			return [res.status, ...named, await res.text()]
		}
		expect(
			await Promise.all([
				wire("/text"),
				wire("/csv"),
				wire("/html"),
				wire("/xml"),
				wire("/raw"),
				wire("/teapot"),
				wire("/item", "DELETE"),
				wire("/old"),
			]),
		).toEqual([
			[200, "text/plain; charset=utf-8", null, null, `Héllo Wörld 🌍 日本語 Привет ${CJK}`],
			[200, "text/csv; charset=utf-8", null, null, QUOTED_CSV],
			[200, "text/html; charset=utf-8", null, null, HTML_DOC],
			[200, "application/xml", null, null, NS_XML],
			[201, "text/markdown", "raw", null, "custom body"],
			[418, "text/plain;charset=UTF-8", "yes", null, "raw body"],
			[204, null, null, null, ""],
			[307, null, null, "/new?foo=bar&baz=qux", ""],
		])
	})
})

describe("large and composed answers on the wire", () => {
	// v0: 72b84ca04f
	// v0: b09e3c4c13
	// v0: 1e898740b7
	// v0: 3e905d43b3
	it("a 1MB json object and a 250KB text arrive whole", async () => {
		const base = await listen(helpersApp())
		const big = await fetch(`${base}/big-json`)
		const text = await fetch(`${base}/big-text`)
		expect([big.headers.get("content-type"), await big.json(), (await text.text()) === BIG_TEXT]).toEqual([
			"application/json",
			BIG_OBJECT,
			true,
		])
	})

	// v0: aa26972827
	// v0: 08e67d81b7
	// v0: 0971039f20
	// v0: 9fded63fc5
	it("a JSON or form request answered as csv, html, text or json", async () => {
		const app = honey<{}>()
		app.post("/csv").handler(async (ctx) => {
			const { items } = (await ctx.req.json()) as { items: Array<{ name: string; value: string }> }
			return ctx.res.csv("ok", ["name,value", ...items.map((item) => `${item.name},${item.value}`)].join("\n"))
		})
		app
			.post("/html")
			.handler(async (ctx) => ctx.res.html("ok", `<h1>${((await ctx.req.json()) as { t: string }).t}</h1>`))
		app.post("/text").handler(async (ctx) => ctx.res.text("ok", `Hello ${((await ctx.req.json()) as { n: string }).n}`))
		app.post("/login").handler(async (ctx) => ctx.res.json("ok", Object.fromEntries(await ctx.req.formData())))
		const base = await listen(app)
		const wire = async (path: string, body: string, type: string) => {
			const res = await fetch(`${base}${path}`, { body, headers: { "content-type": type }, method: "POST" })
			return [res.status, res.headers.get("content-type"), await res.text()]
		}
		const items = [
			{ name: "a", value: "1" },
			{ name: "b", value: "2" },
		]
		expect(
			await Promise.all([
				wire("/csv", JSON.stringify({ items }), "application/json"),
				wire("/html", JSON.stringify({ t: "My Page" }), "application/json"),
				wire("/text", JSON.stringify({ n: "World" }), "application/json"),
				wire("/login", "user=admin&password=secret", "application/x-www-form-urlencoded"),
			]),
		).toEqual([
			[200, "text/csv; charset=utf-8", "name,value\na,1\nb,2"],
			[200, "text/html; charset=utf-8", "<h1>My Page</h1>"],
			[200, "text/plain; charset=utf-8", "Hello World"],
			[200, "application/json", '{"user":"admin","password":"secret"}'],
		])
	})
})
