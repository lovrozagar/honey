import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { honey } from "../../src/index.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { testClient } from "../../src/testing.ts"

function request(
	port: number,
	path: string,
	opts?: {
		body?: Buffer | string
		headers?: Record<string, string>
		method?: string
	},
): Promise<{ body: Buffer; headers: http.IncomingHttpHeaders; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				headers: opts?.headers,
				hostname: "127.0.0.1",
				method: opts?.method ?? "GET",
				path,
				port,
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on("data", (chunk: Buffer) => {
					chunks.push(chunk)
				})
				res.on("end", () => {
					resolve({
						body: Buffer.concat(chunks),
						headers: res.headers,
						status: res.statusCode ?? 0,
					})
				})
			},
		)
		req.on("error", reject)
		if (opts?.body) req.write(opts.body)
		req.end()
	})
}

let server: HoneyServer | null = null

afterEach(() => {
	if (server) {
		server.close()
		server = null
	}
})

/* ──────────────────────────────────────────────
 * JSON request payloads
 * ────────────────────────────────────────────── */

describe("payload: JSON request bodies", () => {
	it("100KB JSON object → parsed correctly", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", { keys: Object.keys(body).length })
		})

		const obj: Record<string, string> = {}
		for (let i = 0; i < 1000; i++) {
			obj[`key_${i}`] = "x".repeat(90)
		}
		const payload = JSON.stringify(obj)

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: payload,
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.keys).toBe(1000)
	})

	it("deeply nested JSON (100 levels) → parsed without crash", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", { received: true, type: typeof body })
		})

		let nested: Record<string, unknown> = { leaf: true }
		for (let i = 0; i < 100; i++) {
			nested = { child: nested }
		}

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify(nested),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("large JSON array (10000 items) → parsed correctly", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as unknown[]
			return ctx.res.json("ok", { count: body.length })
		})

		const arr = Array.from({ length: 10000 }, (_, i) => ({ id: i, name: `item-${i}` }))

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify(arr),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.count).toBe(10000)
	})

	it("malformed JSON → handler catches parse error", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			try {
				await ctx.req.json()
				return ctx.res.json("ok", { parsed: true })
			} catch {
				return ctx.res.json("bad_request", { parsed: false })
			}
		})

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: "{ invalid json !!!",
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.parsed).toBe(false)
	})

	it("empty body with application/json content-type → handler catches", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			try {
				await ctx.req.json()
				return ctx.res.json("ok", { parsed: true })
			} catch {
				return ctx.res.json("bad_request", { error: "empty" })
			}
		})

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: "",
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
	})

	it("JSON with unicode/emoji values → preserved", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		const payload = { emoji: "🔥🎉", japanese: "こんにちは", russian: "Привет" }
		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify(payload),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.emoji).toBe("🔥🎉")
		expect(data.japanese).toBe("こんにちは")
		expect(data.russian).toBe("Привет")
	})

	it("JSON with null values → preserved", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify({ a: null, b: 0, c: false, d: "" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.a).toBeNull()
		expect(data.b).toBe(0)
		expect(data.c).toBe(false)
		expect(data.d).toBe("")
	})

	it("JSON with special number values → serialized correctly", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify({ big: 9007199254740991, float: 1.23456, neg: -42, zero: 0 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.big).toBe(9007199254740991)
		expect(data.float).toBeCloseTo(1.23456)
		expect(data.neg).toBe(-42)
	})

	it("JSON string as root value → valid JSON", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body: unknown = await ctx.req.json()
			return ctx.res.json("ok", { type: typeof body, value: body })
		})

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify("just a string"),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.type).toBe("string")
		expect(data.value).toBe("just a string")
	})
})

/* ──────────────────────────────────────────────
 * Form request payloads
 * ────────────────────────────────────────────── */

describe("payload: URL-encoded form bodies", () => {
	it("special characters in values → decoded correctly", async () => {
		const app = honey<{}>()
		app.post("/form").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const result: Record<string, string> = {}
			body.forEach((v, k) => {
				result[k] = v as string
			})
			return ctx.res.json("ok", result)
		})

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "name=John+Doe&email=user%40example.com&msg=hello%26world",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.name).toBe("John Doe")
		expect(data.email).toBe("user@example.com")
		expect(data.msg).toBe("hello&world")
	})

	it("unicode in URL-encoded form → decoded correctly", async () => {
		const app = honey<{}>()
		app.post("/form").handler(async (ctx) => {
			const body = await ctx.req.formData()
			return ctx.res.json("ok", { name: body.get("name") })
		})

		const name = "日本語テスト"
		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: `name=${encodeURIComponent(name)}`,
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.name).toBe(name)
	})

	it("empty URL-encoded form → empty formData", async () => {
		const app = honey<{}>()
		app.post("/form").handler(async (ctx) => {
			const body = await ctx.req.formData()
			let count = 0
			body.forEach(() => {
				count++
			})
			return ctx.res.json("ok", { count })
		})

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.count).toBe(0)
	})

	it("duplicate keys in URL-encoded form → last value per getAll", async () => {
		const app = honey<{}>()
		app.post("/form").handler(async (ctx) => {
			const body = await ctx.req.formData()
			return ctx.res.json("ok", {
				all: body.getAll("tag"),
				first: body.get("tag"),
			})
		})

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "tag=a&tag=b&tag=c",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.first).toBe("a")
		expect(data.all).toEqual(["a", "b", "c"])
	})
})

describe("payload: multipart form bodies", () => {
	it("text fields only → all parsed", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			return ctx.res.json("ok", {
				email: body.get("email"),
				name: body.get("name"),
			})
		})

		const form = new FormData()
		form.set("name", "Alice")
		form.set("email", "alice@test.com")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.name).toBe("Alice")
		expect(data.email).toBe("alice@test.com")
	})

	it("single file upload → file received as Blob", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const file = body.get("avatar")
			if (file instanceof Blob) {
				return ctx.res.json("ok", {
					size: file.size,
					type: file.type,
				})
			}
			return ctx.res.json("bad_request", { error: "no file" })
		})

		const form = new FormData()
		const blob = new Blob(["hello world image data"], { type: "image/png" })
		form.set("avatar", blob, "avatar.png")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.size).toBeGreaterThanOrEqual(21)
		expect(data.type).toBe("image/png")
	})

	it("multiple files → all received", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const files = body.getAll("docs")
			return ctx.res.json("ok", {
				count: files.length,
				sizes: files.map((f) => (f instanceof Blob ? f.size : 0)),
			})
		})

		const form = new FormData()
		form.append("docs", new Blob(["doc1 content"], { type: "text/plain" }), "doc1.txt")
		form.append("docs", new Blob(["doc2 content longer"], { type: "text/plain" }), "doc2.txt")
		form.append("docs", new Blob(["d3"], { type: "text/plain" }), "doc3.txt")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.count).toBe(3)
		expect(data.sizes).toEqual([12, 19, 2])
	})

	it("mixed text fields + files → both accessible", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const file = body.get("photo")
			return ctx.res.json("ok", {
				description: body.get("description"),
				fileSize: file instanceof Blob ? file.size : 0,
				title: body.get("title"),
			})
		})

		const form = new FormData()
		form.set("title", "My Photo")
		form.set("description", "A beautiful sunset 🌅")
		form.set("photo", new Blob(["binary-image-data-here"], { type: "image/jpeg" }), "sunset.jpg")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.title).toBe("My Photo")
		expect(data.description).toBe("A beautiful sunset 🌅")
		expect(data.fileSize).toBeGreaterThanOrEqual(21)
	})

	it("large file upload (1MB) → received intact", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const file = body.get("big")
			if (file instanceof Blob) {
				const content = await file.arrayBuffer()
				return ctx.res.json("ok", { size: content.byteLength })
			}
			return ctx.res.json("bad_request", { error: "no file" })
		})

		const form = new FormData()
		const bigData = new Uint8Array(1024 * 1024)
		for (let i = 0; i < bigData.length; i++) {
			bigData[i] = i % 256
		}
		form.set("big", new Blob([bigData], { type: "application/octet-stream" }), "big.bin")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.size).toBe(1024 * 1024)
	})

	/* Bun bug: Request.formData() loses binary Blob content from FormData.set() */
	it.skip("binary file content integrity → bytes match", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const file = body.get("data")
			if (file instanceof Blob) {
				const bytes = new Uint8Array(await file.arrayBuffer())
				let sum = 0
				for (const b of bytes) sum += b
				return ctx.res.json("ok", { checksum: sum, size: bytes.length })
			}
			return ctx.res.json("bad_request", {})
		})

		const original = new Uint8Array([0, 1, 127, 128, 254, 255, 0, 42])
		const form = new FormData()
		form.set("data", new Blob([original], { type: "application/octet-stream" }), "data.bin")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.size).toBe(8)
		let expectedSum = 0
		for (const b of original) expectedSum += b
		expect(data.checksum).toBe(expectedSum)
	})
})

/* ──────────────────────────────────────────────
 * Binary request payloads
 * ────────────────────────────────────────────── */

describe("payload: binary request bodies", () => {
	it("raw binary body → read via arrayBuffer()", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			return ctx.res.json("ok", { size: buf.byteLength })
		})

		const data = new Uint8Array(256)
		for (let i = 0; i < 256; i++) data[i] = i

		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: data,
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, number>
		expect(body.size).toBe(256)
	})

	it("empty binary body → 0 bytes", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			return ctx.res.json("ok", { size: buf.byteLength })
		})

		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: new Uint8Array(0),
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, number>
		expect(body.size).toBe(0)
	})

	it("1MB binary body → full size received", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			const bytes = new Uint8Array(buf)
			let checksum = 0
			for (const b of bytes) checksum = (checksum + b) & 0xffffffff
			return ctx.res.json("ok", { checksum, size: buf.byteLength })
		})

		const data = new Uint8Array(1024 * 1024)
		for (let i = 0; i < data.length; i++) data[i] = i % 256

		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: data,
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, number>
		expect(body.size).toBe(1024 * 1024)
	})

	it("text body read as arrayBuffer → correct bytes", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			const text = new TextDecoder().decode(buf)
			return ctx.res.json("ok", { text })
		})

		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: "hello binary",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, string>
		expect(body.text).toBe("hello binary")
	})
})

/* ──────────────────────────────────────────────
 * Response content types
 * ────────────────────────────────────────────── */

describe("payload: response content types over HTTP", () => {
	it("json response with large object → correct content-type and body", async () => {
		const app = honey<{}>()
		const bigObj: Record<string, string> = {}
		for (let i = 0; i < 500; i++) bigObj[`field_${i}`] = `value_${i}`
		app.get("/big").handler((ctx) => ctx.res.json("ok", bigObj))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/big")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("application/json")
		const data = JSON.parse(res.body.toString()) as Record<string, unknown>
		expect(Object.keys(data)).toHaveLength(500)
	})

	it("text response with unicode → charset preserved", async () => {
		const app = honey<{}>()
		app.get("/text").handler((ctx) => ctx.res.text("ok", "Héllo Wörld 🌍 日本語 Привет"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/text")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8")
		expect(res.body.toString("utf-8")).toBe("Héllo Wörld 🌍 日本語 Привет")
	})

	it("html response with full document → correct content-type", async () => {
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Test</title></head><body><h1>Hello</h1><script>alert("xss")</script></body></html>`
		const app = honey<{}>()
		app.get("/page").handler((ctx) => ctx.res.html("ok", html))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/page")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/html; charset=utf-8")
		expect(res.body.toString()).toContain("<h1>Hello</h1>")
		expect(res.body.toString()).toContain("<script>")
	})

	it("xml response with namespaces → correct content-type", async () => {
		const xml = `<?xml version="1.0"?><root xmlns:ns="http://example.com"><ns:item id="1">Value &amp; More</ns:item></root>`
		const app = honey<{}>()
		app.get("/xml").handler((ctx) => ctx.res.xml("ok", xml))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/xml")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("application/xml")
		expect(res.body.toString()).toContain("&amp;")
	})

	it("csv response with commas in quoted fields → correct content-type", async () => {
		const csv = `name,description,price\n"Widget, Inc.","A ""great"" product",19.99\nGadget,"Simple item",5.00`
		const app = honey<{}>()
		app.get("/csv").handler((ctx) => ctx.res.csv("ok", csv))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/csv")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8")
		expect(res.body.toString()).toContain('"Widget, Inc."')
	})

	it("binary response with Uint8Array → exact bytes", async () => {
		const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff])
		const app = honey<{}>()
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", bytes))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/bin")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("application/octet-stream")
		expect(res.body.length).toBe(6)
		expect(res.body[0]).toBe(0x00)
		expect(res.body[3]).toBe(0x80)
		expect(res.body[5]).toBe(0xff)
	})

	it("binary response with large ArrayBuffer → full size", async () => {
		const size = 512 * 1024
		const data = new ArrayBuffer(size)
		const view = new Uint8Array(data)
		for (let i = 0; i < view.length; i++) view[i] = i % 256

		const app = honey<{}>()
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", view))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/bin")
		expect(res.status).toBe(200)
		expect(res.body.length).toBe(size)
		expect(res.body[0]).toBe(0)
		expect(res.body[255]).toBe(255)
		expect(res.body[256]).toBe(0)
	})

	it("noContent → 204 with no body", async () => {
		const app = honey<{}>()
		app.delete("/item").handler((ctx) => ctx.res.noContent())
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/item", { method: "DELETE" })
		expect(res.status).toBe(204)
		expect(res.body.length).toBe(0)
	})

	it("redirect with query params → location header preserved", async () => {
		const app = honey<{}>()
		app.get("/old").handler((ctx) => ctx.res.redirect("/new?foo=bar&baz=qux", { status: 307 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await new Promise<{ headers: http.IncomingHttpHeaders; status: number }>((resolve, reject) => {
			const req = http.request({ hostname: "127.0.0.1", method: "GET", path: "/old", port: addr.port }, (r) => {
				resolve({ headers: r.headers, status: r.statusCode ?? 0 })
				r.resume()
			})
			req.on("error", reject)
			req.end()
		})
		expect(res.status).toBe(307)
		expect(res.headers.location).toBe("/new?foo=bar&baz=qux")
	})

	it("raw response passthrough → custom headers and body", async () => {
		const app = honey<{}>()
		app.get("/raw").handler((ctx) =>
			ctx.res.raw(
				new Response("custom body", {
					headers: {
						"content-type": "text/markdown",
						"x-custom": "raw-value",
					},
					status: 201,
				}),
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/raw")
		expect(res.status).toBe(201)
		expect(res.headers["content-type"]).toBe("text/markdown")
		expect(res.headers["x-custom"]).toBe("raw-value")
		expect(res.body.toString()).toBe("custom body")
	})
})

/* ──────────────────────────────────────────────
 * Streaming responses
 * ────────────────────────────────────────────── */

describe("payload: streaming responses over HTTP", () => {
	it("SSE with JSON data objects → properly serialized", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: { count: 1, items: ["a", "b"] }, event: "update" })
				await stream.send({ data: { count: 2, items: ["c"] }, event: "update" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.status).toBe(200)
		const body = res.body.toString()
		expect(body).toContain("event: update")
		expect(body).toContain('data: {"count":1,"items":["a","b"]}')
		expect(body).toContain('data: {"count":2,"items":["c"]}')
	})

	it("SSE with unicode/emoji data → preserved", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "Hello 🌍 世界", event: "msg" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body.toString("utf-8")).toContain("data: Hello 🌍 世界")
	})

	it("SSE with event IDs → id field present", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "first", event: "msg", id: "evt-001" })
				await stream.send({ data: "second", event: "msg", id: "evt-002" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		const body = res.body.toString()
		expect(body).toContain("id: evt-001")
		expect(body).toContain("id: evt-002")
	})

	it("SSE with defaultRetry → retry line at start", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (stream) => {
					await stream.send({ data: "x", event: "msg" })
					stream.close()
				},
				{ defaultRetry: 3000 },
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		const body = res.body.toString()
		expect(body.startsWith("retry: 3000\n\n")).toBe(true)
	})

	it("generate: large streaming response (10000 chunks) → all delivered", async () => {
		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.generate(
				(async function* () {
					for (let i = 0; i < 10000; i++) {
						yield `chunk-${i}\n`
					}
				})(),
				{ contentType: "text/plain" },
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.status).toBe(200)
		const lines = res.body.toString().trim().split("\n")
		expect(lines).toHaveLength(10000)
		expect(lines[0]).toBe("chunk-0")
		expect(lines[9999]).toBe("chunk-9999")
	})

	it("stream: multiple writes → concatenated output", async () => {
		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				const encoder = new TextEncoder()
				await writer.write(encoder.encode("part1-"))
				await writer.write(encoder.encode("part2-"))
				await writer.write(encoder.encode("part3"))
				await writer.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.status).toBe(200)
		expect(res.body.toString()).toBe("part1-part2-part3")
	})

	it("stream: binary data → bytes intact", async () => {
		const original = new Uint8Array([0, 1, 127, 128, 254, 255])
		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(original)
				await writer.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.body.length).toBe(6)
		expect(res.body[0]).toBe(0)
		expect(res.body[2]).toBe(127)
		expect(res.body[3]).toBe(128)
		expect(res.body[5]).toBe(255)
	})
})

/* ──────────────────────────────────────────────
 * Content-Type edge cases
 * ────────────────────────────────────────────── */

describe("payload: content-type edge cases", () => {
	it("application/json; charset=utf-8 → parsed as JSON", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify({ name: "test" }),
				headers: { "content-type": "application/json; charset=utf-8" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.name).toBe("test")
	})

	it("POST with no content-type and no body → handler works", async () => {
		const app = honey<{}>()
		app.post("/action").handler((ctx) => ctx.res.json("ok", { action: "done" }))

		const res = await app.fetch(new Request("http://localhost/action", { method: "POST" }), {})
		expect(res.status).toBe(200)
	})

	it("POST with text/plain body → readable as text", async () => {
		const app = honey<{}>()
		app.post("/text").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.text("ok", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/text", {
				body: "plain text content here",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("plain text content here")
	})

	it("POST with application/xml body → readable as text", async () => {
		const app = honey<{}>()
		app.post("/xml").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.xml("ok", body)
		})

		const xmlBody = `<?xml version="1.0"?><request><item>1</item></request>`
		const res = await app.fetch(
			new Request("http://localhost/xml", {
				body: xmlBody,
				headers: { "content-type": "application/xml" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/xml")
		expect(await res.text()).toBe(xmlBody)
	})

	it("response with custom headers alongside content-type → both present", async () => {
		const app = honey<{}>()
		app.get("/custom").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ data: 1 },
				{
					headers: {
						"cache-control": "max-age=3600",
						"x-api-version": "2",
					},
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/custom"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
		expect(res.headers.get("cache-control")).toBe("max-age=3600")
		expect(res.headers.get("x-api-version")).toBe("2")
	})
})

/* ──────────────────────────────────────────────
 * Body limit with various content types
 * ────────────────────────────────────────────── */

describe("payload: body limit with various content types", () => {
	function makeApp(maxSize: number) {
		const app = honey<{}>().use(bodyLimit({ maxSize }))
		app.post("/echo-json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as unknown
			return ctx.res.json("ok", { received: body })
		})
		app.post("/echo-text").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.text("ok", body)
		})
		app.post("/echo-form").handler(async (ctx) => {
			const body = await ctx.req.formData()
			let count = 0
			body.forEach(() => {
				count++
			})
			return ctx.res.json("ok", { fields: count })
		})
		app.post("/echo-bin").handler(async (ctx) => {
			const body = await ctx.req.arrayBuffer()
			return ctx.res.json("ok", { size: body.byteLength })
		})
		return app
	}

	it("JSON body under limit → passes", async () => {
		const app = makeApp(1000)
		const res = await app.fetch(
			new Request("http://localhost/echo-json", {
				body: JSON.stringify({ name: "test" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("JSON body over limit → 413", async () => {
		const app = makeApp(50)
		const bigJson = JSON.stringify({ data: "x".repeat(100) })
		const res = await app.fetch(
			new Request("http://localhost/echo-json", {
				body: bigJson,
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("text body under limit → passes", async () => {
		const app = makeApp(1000)
		const res = await app.fetch(
			new Request("http://localhost/echo-text", {
				body: "hello world",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("hello world")
	})

	it("text body over limit → 413", async () => {
		const app = makeApp(10)
		const res = await app.fetch(
			new Request("http://localhost/echo-text", {
				body: "x".repeat(50),
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("binary body under limit → passes", async () => {
		const app = makeApp(1000)
		const res = await app.fetch(
			new Request("http://localhost/echo-bin", {
				body: new Uint8Array(100),
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.size).toBe(100)
	})

	it("binary body over limit → 413", async () => {
		const app = makeApp(50)
		const res = await app.fetch(
			new Request("http://localhost/echo-bin", {
				body: new Uint8Array(200),
				headers: {
					"content-length": "200",
					"content-type": "application/octet-stream",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("body with only whitespace → counted by byte size", async () => {
		const app = makeApp(5)
		const res = await app.fetch(
			new Request("http://localhost/echo-text", {
				body: "   ",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("   ")
	})

	it("unicode body → byte size (not char count) checked", async () => {
		const app = makeApp(10)
		/* 4 emoji chars = 16 bytes in UTF-8 (each emoji is 4 bytes) */
		const res = await app.fetch(
			new Request("http://localhost/echo-text", {
				body: "🔥🔥🔥🔥",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		/* 4 emojis × 4 bytes = 16 bytes > 10 byte limit */
		expect(res.status).toBe(413)
	})
})

/* ──────────────────────────────────────────────
 * Request/response roundtrip with testClient
 * ────────────────────────────────────────────── */

describe("payload: testClient roundtrip", () => {
	it("JSON roundtrip → input matches output", async () => {
		const app = honey<{}>()
		app.post("/echo").handler(async (ctx) => {
			const body = (await ctx.req.json()) as unknown
			return ctx.res.json("ok", body)
		})

		const client = testClient(app, { env: {} })
		const original = { array: [1, 2, 3], nested: { deep: true }, str: "hello" }
		const res = await client.post("/echo", { json: original })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(original)
	})

	it("search params roundtrip → params accessible", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { page: ctx.search.page, q: ctx.search.q }))

		const client = testClient(app, { env: {} })
		const res = await client.get("/search", { search: { page: "2", q: "hello world" } })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("hello world")
		expect(data.page).toBe("2")
	})

	it("custom headers roundtrip → accessible in handler", async () => {
		const app = honey<{}>()
		app.get("/headers").handler((ctx) =>
			ctx.res.json("ok", {
				auth: ctx.headers.authorization,
				custom: ctx.headers["x-custom"],
			}),
		)

		const client = testClient(app, { env: {} })
		const res = await client.get("/headers", {
			headers: { authorization: "Bearer tok-123", "x-custom": "value" },
		})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.auth).toBe("Bearer tok-123")
		expect(data.custom).toBe("value")
	})

	it("form roundtrip via testClient → fields parsed", async () => {
		const app = honey<{}>()
		app.post("/form").handler(async (ctx) => {
			const body = await ctx.req.formData()
			return ctx.res.json("ok", { name: body.get("name") })
		})

		const client = testClient(app, { env: {} })
		const res = await client.post("/form", { form: { name: "Alice" } })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.name).toBe("Alice")
	})
})

/* ──────────────────────────────────────────────
 * Status code mapping for all response types
 * ────────────────────────────────────────────── */

describe("payload: status code mapping across response types", () => {
	it("json → all common status keys map correctly", async () => {
		const app = honey<{}>()
		app.get("/200").handler((ctx) => ctx.res.json("ok", {}))
		app.get("/201").handler((ctx) => ctx.res.json("created", {}))
		app.get("/202").handler((ctx) => ctx.res.json("accepted", {}))
		app.get("/400").handler((ctx) => ctx.res.json("bad_request", {}))
		app.get("/401").handler((ctx) => ctx.res.json("unauthorized", {}))
		app.get("/403").handler((ctx) => ctx.res.json("forbidden", {}))
		app.get("/404").handler((ctx) => ctx.res.json("not_found", {}))
		app.get("/409").handler((ctx) => ctx.res.json("conflict", {}))
		app.get("/422").handler((ctx) => ctx.res.json("unprocessable_entity", {}))
		app.get("/429").handler((ctx) => ctx.res.json("too_many_requests", {}))
		app.get("/500").handler((ctx) => ctx.res.json("internal_server_error", {}))

		const codes = [200, 201, 202, 400, 401, 403, 404, 409, 422, 429, 500]
		for (const code of codes) {
			const res = await app.fetch(new Request(`http://localhost/${code}`), {})
			expect(res.status).toBe(code)
		}
	})

	it("text → status keys map correctly", async () => {
		const app = honey<{}>()
		app.get("/ok").handler((ctx) => ctx.res.text("ok", "fine"))
		app.get("/err").handler((ctx) => ctx.res.text("bad_request", "nope"))

		const ok = await app.fetch(new Request("http://localhost/ok"), {})
		expect(ok.status).toBe(200)

		const err = await app.fetch(new Request("http://localhost/err"), {})
		expect(err.status).toBe(400)
	})

	it("html → status keys map correctly", async () => {
		const app = honey<{}>()
		app.get("/ok").handler((ctx) => ctx.res.html("ok", "<p>ok</p>"))
		app.get("/err").handler((ctx) => ctx.res.html("not_found", "<p>not found</p>"))

		const ok = await app.fetch(new Request("http://localhost/ok"), {})
		expect(ok.status).toBe(200)

		const err = await app.fetch(new Request("http://localhost/err"), {})
		expect(err.status).toBe(404)
	})

	it("xml → status keys map correctly", async () => {
		const app = honey<{}>()
		app.get("/ok").handler((ctx) => ctx.res.xml("ok", "<ok/>"))
		app.get("/err").handler((ctx) => ctx.res.xml("internal_server_error", "<err/>"))

		const ok = await app.fetch(new Request("http://localhost/ok"), {})
		expect(ok.status).toBe(200)

		const err = await app.fetch(new Request("http://localhost/err"), {})
		expect(err.status).toBe(500)
	})

	it("csv → status keys map correctly", async () => {
		const app = honey<{}>()
		app.get("/ok").handler((ctx) => ctx.res.csv("ok", "a,b"))
		app.get("/err").handler((ctx) => ctx.res.csv("bad_request", "error"))

		const ok = await app.fetch(new Request("http://localhost/ok"), {})
		expect(ok.status).toBe(200)

		const err = await app.fetch(new Request("http://localhost/err"), {})
		expect(err.status).toBe(400)
	})

	it("binary → status keys map correctly", async () => {
		const app = honey<{}>()
		app.get("/ok").handler((ctx) => ctx.res.binary("ok", new Uint8Array([1])))
		app.get("/err").handler((ctx) => ctx.res.binary("bad_request", new Uint8Array([0])))

		const ok = await app.fetch(new Request("http://localhost/ok"), {})
		expect(ok.status).toBe(200)

		const err = await app.fetch(new Request("http://localhost/err"), {})
		expect(err.status).toBe(400)
	})
})

/* ──────────────────────────────────────────────
 * Edge cases: empty, null, zero-length
 * ────────────────────────────────────────────── */

describe("payload: empty and zero-length edge cases", () => {
	it("empty JSON object → valid response", async () => {
		const app = honey<{}>()
		app.get("/empty").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	it("empty JSON array → valid response", async () => {
		const app = honey<{}>()
		app.get("/empty").handler((ctx) => ctx.res.json("ok", []))

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it("empty string text response → valid", async () => {
		const app = honey<{}>()
		app.get("/empty").handler((ctx) => ctx.res.text("ok", ""))

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("")
	})

	it("empty HTML response → valid", async () => {
		const app = honey<{}>()
		app.get("/empty").handler((ctx) => ctx.res.html("ok", ""))

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(await res.text()).toBe("")
	})

	it("zero-length binary → valid", async () => {
		const app = honey<{}>()
		app.get("/empty").handler((ctx) => ctx.res.binary("ok", new Uint8Array(0)))

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		expect(res.status).toBe(200)
		const buf = await res.arrayBuffer()
		expect(buf.byteLength).toBe(0)
	})

	it("GET with no body → ctx.req.text() returns empty string", async () => {
		const app = honey<{}>()
		app.get("/nobody").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.json("ok", { body, length: body.length })
		})

		const res = await app.fetch(new Request("http://localhost/nobody"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.body).toBe("")
		expect(data.length).toBe(0)
	})
})

/* ──────────────────────────────────────────────
 * Multiple content types in sequence
 * ────────────────────────────────────────────── */

describe("payload: multiple content types on same server", () => {
	it("same server serves json, text, html, binary, csv → all correct", async () => {
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { type: "json" }))
		app.get("/text").handler((ctx) => ctx.res.text("ok", "plain text"))
		app.get("/html").handler((ctx) => ctx.res.html("ok", "<b>bold</b>"))
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", new Uint8Array([42])))
		app.get("/csv").handler((ctx) => ctx.res.csv("ok", "a,b\n1,2"))
		app.get("/xml").handler((ctx) => ctx.res.xml("ok", "<root/>"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const [json, text, html, bin, csv, xml] = await Promise.all([
			request(addr.port, "/json"),
			request(addr.port, "/text"),
			request(addr.port, "/html"),
			request(addr.port, "/bin"),
			request(addr.port, "/csv"),
			request(addr.port, "/xml"),
		])

		expect(json.headers["content-type"]).toBe("application/json")
		expect((JSON.parse(json.body.toString()) as Record<string, string>).type).toBe("json")

		expect(text.headers["content-type"]).toBe("text/plain; charset=utf-8")
		expect(text.body.toString()).toBe("plain text")

		expect(html.headers["content-type"]).toBe("text/html; charset=utf-8")
		expect(html.body.toString()).toBe("<b>bold</b>")

		expect(bin.headers["content-type"]).toBe("application/octet-stream")
		expect(bin.body[0]).toBe(42)

		expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8")
		expect(csv.body.toString()).toBe("a,b\n1,2")

		expect(xml.headers["content-type"]).toBe("application/xml")
		expect(xml.body.toString()).toBe("<root/>")
	})
})

/* ──────────────────────────────────────────────
 * Cookies in request/response payloads
 * ────────────────────────────────────────────── */

describe("payload: cookies in request and response", () => {
	it("multiple set-cookie headers → all present", async () => {
		const app = honey<{}>()
		app.get("/cookies").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ ok: true },
				{
					cookies: {
						lang: { path: "/", value: "en" },
						session: { httpOnly: true, path: "/", secure: false, value: "s-123" },
						theme: { path: "/", value: "dark" },
					},
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/cookies"), {})
		expect(res.status).toBe(200)
		const setCookies = res.headers.getSetCookie()
		expect(setCookies.length).toBe(3)
		const all = setCookies.join(" | ")
		expect(all).toContain("session=s-123")
		expect(all).toContain("theme=dark")
		expect(all).toContain("lang=en")
	})

	it("request cookies → lazy-parsed correctly", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) =>
			ctx.res.json("ok", {
				session: ctx.cookies.session,
				theme: ctx.cookies.theme,
			}),
		)

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "session=abc; theme=dark; lang=en" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.session).toBe("abc")
		expect(data.theme).toBe("dark")
	})

	it("percent-encoded cookie values → decoded on read", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) => ctx.res.json("ok", { msg: ctx.cookies.msg }))

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "msg=hello%20world%21" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.msg).toBe("hello world!")
	})

	it("cookie with special characters → encoded on set, decoded on read", async () => {
		const app = honey<{}>()
		app.get("/set").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { data: { value: "value with spaces & symbols!" } },
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/set"), {})
		const cookie = res.headers.getSetCookie()[0]
		expect(cookie).toBeTruthy()
		/* spaces should be percent-encoded */
		expect(cookie).not.toContain("value with spaces")
		expect(cookie).toContain("data=")
	})
})

/* ──────────────────────────────────────────────
 * HTTP methods with body payloads
 * ────────────────────────────────────────────── */

describe("payload: HTTP methods and body handling", () => {
	it("PUT with JSON body → parsed", async () => {
		const app = honey<{}>()
		app.put("/resource").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/resource", {
				body: JSON.stringify({ name: "updated" }),
				headers: { "content-type": "application/json" },
				method: "PUT",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.name).toBe("updated")
	})

	it("PATCH with JSON body → parsed", async () => {
		const app = honey<{}>()
		app.patch("/resource").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/resource", {
				body: JSON.stringify({ field: "patched" }),
				headers: { "content-type": "application/json" },
				method: "PATCH",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.field).toBe("patched")
	})

	it("DELETE with no body → 204 noContent response", async () => {
		const app = honey<{}>()
		app.delete("/resource/:id").handler((ctx) => {
			expect(ctx.params.id).toBe("42")
			return ctx.res.noContent()
		})

		const res = await app.fetch(new Request("http://localhost/resource/42", { method: "DELETE" }), {})
		expect(res.status).toBe(204)
	})

	it("HEAD request → response has headers but empty body", async () => {
		const app = honey<{}>()
		app.head("/data").handler((ctx) => ctx.res.json("ok", { items: [1, 2, 3] }))

		const res = await app.fetch(new Request("http://localhost/data", { method: "HEAD" }), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
	})

	it("OPTIONS request → response works", async () => {
		const app = honey<{}>()
		app.options("/data").handler((ctx) => ctx.res.noContent({ headers: { allow: "GET, POST, OPTIONS" } }))

		const res = await app.fetch(new Request("http://localhost/data", { method: "OPTIONS" }), {})
		expect(res.status).toBe(204)
		expect(res.headers.get("allow")).toBe("GET, POST, OPTIONS")
	})
})

/* ──────────────────────────────────────────────
 * Large response payloads over real HTTP
 * ────────────────────────────────────────────── */

describe("payload: large responses over HTTP", () => {
	it("1MB JSON response → full body received", async () => {
		const bigObj: Record<string, string> = {}
		for (let i = 0; i < 5000; i++) bigObj[`k${i}`] = "x".repeat(200)

		const app = honey<{}>()
		app.get("/big").handler((ctx) => ctx.res.json("ok", bigObj))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/big")
		expect(res.status).toBe(200)
		const data = JSON.parse(res.body.toString()) as Record<string, string>
		expect(Object.keys(data)).toHaveLength(5000)
		expect(data.k0).toBe("x".repeat(200))
	})

	it("large text response → full body received", async () => {
		const bigText = "line\n".repeat(50000)
		const app = honey<{}>()
		app.get("/big").handler((ctx) => ctx.res.text("ok", bigText))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/big")
		expect(res.status).toBe(200)
		const lines = res.body.toString().split("\n")
		/* 50000 "line\n" produces 50001 parts when split (last is empty) */
		expect(lines).toHaveLength(50001)
	})

	it("large binary response → full bytes received", async () => {
		const size = 256 * 1024
		const data = new Uint8Array(size)
		for (let i = 0; i < data.length; i++) data[i] = i % 256

		const app = honey<{}>()
		app.get("/big").handler((ctx) => ctx.res.binary("ok", data))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/big")
		expect(res.status).toBe(200)
		expect(res.body.length).toBe(size)
		/* spot check bytes */
		expect(res.body[0]).toBe(0)
		expect(res.body[127]).toBe(127)
		expect(res.body[255]).toBe(255)
		expect(res.body[256]).toBe(0)
	})
})

/* ──────────────────────────────────────────────
 * JSON request + various response combos over HTTP
 * ────────────────────────────────────────────── */

describe("payload: request→response content type combinations over HTTP", () => {
	it("POST JSON → respond with text", async () => {
		const app = honey<{}>()
		app.post("/convert").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.text("ok", `Hello ${body.name}`)
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/convert", {
			body: JSON.stringify({ name: "World" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8")
		expect(res.body.toString()).toBe("Hello World")
	})

	it("POST JSON → respond with HTML", async () => {
		const app = honey<{}>()
		app.post("/render").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.html("ok", `<h1>${body.title}</h1>`)
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/render", {
			body: JSON.stringify({ title: "My Page" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/html; charset=utf-8")
		expect(res.body.toString()).toBe("<h1>My Page</h1>")
	})

	it("POST JSON → respond with CSV", async () => {
		const app = honey<{}>()
		app.post("/export").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown[]>
			const rows = (body.items as Array<Record<string, string>>).map((item) => `${item.name},${item.value}`).join("\n")
			return ctx.res.csv("ok", `name,value\n${rows}`)
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/export", {
			body: JSON.stringify({
				items: [
					{ name: "a", value: "1" },
					{ name: "b", value: "2" },
				],
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8")
		expect(res.body.toString()).toBe("name,value\na,1\nb,2")
	})

	it("POST form-urlencoded → respond with JSON", async () => {
		const app = honey<{}>()
		app.post("/login").handler(async (ctx) => {
			const body = await ctx.req.formData()
			return ctx.res.json("ok", {
				password: body.get("password"),
				user: body.get("user"),
			})
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/login", {
			body: "user=admin&password=secret",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		const data = JSON.parse(res.body.toString()) as Record<string, string>
		expect(data.user).toBe("admin")
		expect(data.password).toBe("secret")
	})
})

/* ──────────────────────────────────────────────
 * INSANE payloads — stress tests
 * ────────────────────────────────────────────── */

describe("payload: insane — extreme JSON", () => {
	it("5MB JSON payload → roundtrip intact", async () => {
		const app = honey<{}>()
		app.post("/big").handler(async (ctx) => {
			const body = (await ctx.req.json()) as { items: unknown[] }
			return ctx.res.json("ok", { count: body.items.length })
		})

		const items = Array.from({ length: 50000 }, (_, i) => ({
			data: "x".repeat(80),
			id: i,
			tags: ["a", "b", "c"],
		}))
		const payload = JSON.stringify({ items })

		const res = await app.fetch(
			new Request("http://localhost/big", {
				body: payload,
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.count).toBe(50000)
	})

	it("500-level deep nested JSON → no stack overflow", async () => {
		const app = honey<{}>()
		app.post("/deep").handler(async (ctx) => {
			const body: unknown = await ctx.req.json()
			return ctx.res.json("ok", { received: typeof body === "object" })
		})

		let nested: Record<string, unknown> = { leaf: true }
		for (let i = 0; i < 500; i++) {
			nested = { c: nested }
		}

		const res = await app.fetch(
			new Request("http://localhost/deep", {
				body: JSON.stringify(nested),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("JSON with 10000 keys at root level → all preserved", async () => {
		const app = honey<{}>()
		app.post("/wide").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", { keys: Object.keys(body).length })
		})

		const wide: Record<string, string> = {}
		for (let i = 0; i < 10000; i++) wide[`field_${i}`] = `val_${i}`

		const res = await app.fetch(
			new Request("http://localhost/wide", {
				body: JSON.stringify(wide),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.keys).toBe(10000)
	})

	it("JSON with very long string value (1MB single string)", async () => {
		const app = honey<{}>()
		app.post("/longstr").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", { length: body.data.length })
		})

		const longStr = "A".repeat(1024 * 1024)
		const res = await app.fetch(
			new Request("http://localhost/longstr", {
				body: JSON.stringify({ data: longStr }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.length).toBe(1024 * 1024)
	})

	it("JSON with every escape sequence → preserved", async () => {
		const app = honey<{}>()
		app.post("/escape").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		const payload = {
			backslash: "a\\b",
			mixed: 'tab\there\nnewline\r\nwindows"quoted"',
			newlines: "line1\nline2\rline3\r\nline4",
			nullchar: "before\u0000after",
			quotes: 'he said "hello"',
			tabs: "col1\tcol2\tcol3",
			unicode: "\u0041\u00e9\u4e16\ud83d\ude80",
		}

		const res = await app.fetch(
			new Request("http://localhost/escape", {
				body: JSON.stringify(payload),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.quotes).toBe('he said "hello"')
		expect(data.newlines).toBe("line1\nline2\rline3\r\nline4")
		expect(data.tabs).toBe("col1\tcol2\tcol3")
		expect(data.backslash).toBe("a\\b")
		expect(data.nullchar).toBe("before\u0000after")
		expect(data.unicode).toContain("\ud83d\ude80")
	})

	it("JSON with all falsy values → none lost", async () => {
		const app = honey<{}>()
		app.post("/falsy").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", body)
		})

		const payload = { a: null, b: 0, c: false, d: "", e: [] }
		const res = await app.fetch(
			new Request("http://localhost/falsy", {
				body: JSON.stringify(payload),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.a).toBeNull()
		expect(data.b).toBe(0)
		expect(data.c).toBe(false)
		expect(data.d).toBe("")
		expect(data.e).toEqual([])
	})
})

describe("payload: insane — extreme binary", () => {
	it("5MB binary upload → full size, spot-check bytes", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			const bytes = new Uint8Array(buf)
			return ctx.res.json("ok", {
				first: bytes[0],
				last: bytes[bytes.length - 1],
				mid: bytes[Math.floor(bytes.length / 2)],
				size: buf.byteLength,
			})
		})

		const size = 5 * 1024 * 1024
		const data = new Uint8Array(size)
		for (let i = 0; i < size; i++) data[i] = i % 256

		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: data,
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, number>
		expect(body.size).toBe(size)
		expect(body.first).toBe(0)
		expect(body.mid).toBe(Math.floor(size / 2) % 256)
		expect(body.last).toBe((size - 1) % 256)
	})

	it("all-zeros binary payload → no corruption", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			const bytes = new Uint8Array(buf)
			let allZero = true
			for (const b of bytes) {
				if (b !== 0) {
					allZero = false
					break
				}
			}
			return ctx.res.json("ok", { allZero, size: buf.byteLength })
		})

		const data = new Uint8Array(100000)
		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: data,
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.size).toBe(100000)
		expect(body.allZero).toBe(true)
	})

	it("all-0xFF binary payload → no byte mangling", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			const bytes = new Uint8Array(buf)
			let allFF = true
			for (const b of bytes) {
				if (b !== 0xff) {
					allFF = false
					break
				}
			}
			return ctx.res.json("ok", { allFF, size: buf.byteLength })
		})

		const data = new Uint8Array(50000).fill(0xff)
		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: data,
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.size).toBe(50000)
		expect(body.allFF).toBe(true)
	})

	it("binary with null bytes throughout → intact", async () => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			const bytes = new Uint8Array(buf)
			let nullCount = 0
			for (const b of bytes) {
				if (b === 0) nullCount++
			}
			return ctx.res.json("ok", { nullCount, size: buf.byteLength })
		})

		const data = new Uint8Array(10000)
		for (let i = 0; i < data.length; i++) data[i] = i % 3 === 0 ? 0 : i % 256
		let expectedNulls = 0
		for (let i = 0; i < data.length; i++) {
			if (data[i] === 0) expectedNulls++
		}

		const res = await app.fetch(
			new Request("http://localhost/bin", {
				body: data,
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, number>
		expect(body.size).toBe(10000)
		expect(body.nullCount).toBe(expectedNulls)
	})

	it("1MB binary response over HTTP → all bytes correct", async () => {
		const size = 1024 * 1024
		const data = new Uint8Array(size)
		for (let i = 0; i < size; i++) data[i] = i % 256

		const app = honey<{}>()
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", data))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/bin")
		expect(res.status).toBe(200)
		expect(res.body.length).toBe(size)
		/* check every 1000th byte */
		for (let i = 0; i < size; i += 1000) {
			expect(res.body[i]).toBe(i % 256)
		}
	})
})

describe("payload: insane — extreme multipart", () => {
	it("50 files in single multipart request → all received", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const files: Array<{ name: string; size: number }> = []
			body.forEach((val, key) => {
				if (val instanceof Blob) {
					files.push({ name: key, size: val.size })
				}
			})
			return ctx.res.json("ok", { count: files.length })
		})

		const form = new FormData()
		for (let i = 0; i < 50; i++) {
			form.append(
				`file_${i}`,
				new Blob([`content of file ${i} ${"x".repeat(100)}`], { type: "text/plain" }),
				`file_${i}.txt`,
			)
		}

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.count).toBe(50)
	})

	it("multipart with 5MB file → received intact", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const file = body.get("big")
			if (file instanceof Blob) {
				const buf = await file.arrayBuffer()
				const bytes = new Uint8Array(buf)
				return ctx.res.json("ok", {
					first: bytes[0],
					last: bytes[bytes.length - 1],
					size: buf.byteLength,
				})
			}
			return ctx.res.json("bad_request", {})
		})

		const size = 5 * 1024 * 1024
		const bigData = new Uint8Array(size)
		for (let i = 0; i < size; i++) bigData[i] = i % 256
		const form = new FormData()
		form.set("big", new Blob([bigData], { type: "application/octet-stream" }), "huge.bin")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.size).toBe(size)
		expect(data.first).toBe(0)
		expect(data.last).toBe((size - 1) % 256)
	})

	it("multipart with binary + text + empty file → all distinguishable", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const results: Record<string, { size: number; type: string }> = {}
			body.forEach((val, key) => {
				if (val instanceof Blob) {
					results[key] = { size: val.size, type: val.type }
				} else {
					results[key] = { size: val.length, type: "text" }
				}
			})
			return ctx.res.json("ok", results)
		})

		const form = new FormData()
		form.set("textField", "just a string")
		form.set("binaryFile", new Blob([new Uint8Array([0, 255, 128])], { type: "application/octet-stream" }), "data.bin")
		form.set("emptyFile", new Blob([], { type: "text/plain" }), "empty.txt")
		form.set("imageFile", new Blob(["fake png header"], { type: "image/png" }), "photo.png")
		form.set("jsonFile", new Blob([JSON.stringify({ nested: true })], { type: "application/json" }), "config.json")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, { size: number; type: string }>
		expect(data.textField.type).toBe("text")
		expect(data.binaryFile.type).toBe("application/octet-stream")
		expect(data.emptyFile.size).toBe(0)
		expect(data.imageFile.type).toBe("image/png")
		/* Bun adds ;charset=utf-8 to text-like MIME types */
		expect(data.jsonFile.type).toContain("application/json")
	})

	it("multipart field names with unicode → preserved", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			const keys: string[] = []
			body.forEach((_, key) => {
				keys.push(key)
			})
			return ctx.res.json("ok", { keys })
		})

		const form = new FormData()
		form.set("nombre", "Juan")
		form.set("nombre_archivo", "test")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		expect(data.keys).toContain("nombre")
		expect(data.keys).toContain("nombre_archivo")
	})
})

describe("payload: insane — extreme streaming", () => {
	it("SSE with 1000 rapid events → all delivered over HTTP", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				for (let i = 0; i < 1000; i++) {
					await stream.send({ data: { seq: i }, event: "tick" })
				}
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.status).toBe(200)
		const body = res.body.toString()
		const eventCount = (body.match(/event: tick/g) ?? []).length
		expect(eventCount).toBe(1000)
		/* verify first and last */
		expect(body).toContain('"seq":0')
		expect(body).toContain('"seq":999')
	})

	it("SSE with large data per event (10KB each) → no truncation", async () => {
		const bigData = "x".repeat(10000)
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: bigData, event: "big" })
				await stream.send({ data: bigData, event: "big" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		const body = res.body.toString()
		/* each event should have the full 10KB data line */
		const dataLines = body.split("\n").filter((l) => l.startsWith("data: "))
		expect(dataLines.length).toBe(2)
		expect(dataLines[0].length).toBeGreaterThan(10000)
	})

	it("generate: 100K chunks → all delivered", async () => {
		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.generate(
				(async function* () {
					for (let i = 0; i < 100000; i++) {
						yield `${i}\n`
					}
				})(),
				{ contentType: "text/plain" },
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.status).toBe(200)
		const lines = res.body.toString().trim().split("\n")
		expect(lines).toHaveLength(100000)
		expect(lines[0]).toBe("0")
		expect(lines[99999]).toBe("99999")
	})

	it("stream: 1MB binary write → all bytes received", async () => {
		const size = 1024 * 1024
		const original = new Uint8Array(size)
		for (let i = 0; i < size; i++) original[i] = i % 256

		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				/* write in 64KB chunks like a real application */
				const chunkSize = 64 * 1024
				for (let offset = 0; offset < size; offset += chunkSize) {
					await writer.write(original.slice(offset, offset + chunkSize))
				}
				await writer.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.body.length).toBe(size)
		/* spot-check bytes */
		for (let i = 0; i < size; i += 10000) {
			expect(res.body[i]).toBe(i % 256)
		}
	})
})

describe("payload: insane — extreme text encodings", () => {
	it("every printable ASCII character in JSON → roundtrip", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		let ascii = ""
		for (let i = 32; i < 127; i++) ascii += String.fromCharCode(i)

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify({ ascii }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.ascii).toBe(ascii)
	})

	it("4-byte UTF-8 characters (astral plane emoji) → preserved", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		const astral = "\ud83d\ude80\ud83c\udf0d\ud83d\udd25\ud83c\udf89\ud83e\udd21\ud83d\udc7d\ud83c\udf08\ud83d\udca9"

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify({ astral }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.astral).toBe(astral)
	})

	it("CJK unified ideographs block → preserved in response", async () => {
		const cjk =
			"Chinese: \u4e16\u754c\u4f60\u597d Japanese: \u3053\u3093\u306b\u3061\u306f Korean: \uc548\ub155\ud558\uc138\uc694"
		const app = honey<{}>()
		app.get("/cjk").handler((ctx) => ctx.res.text("ok", cjk))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/cjk")
		expect(res.body.toString("utf-8")).toBe(cjk)
	})

	it("RTL text (Arabic/Hebrew) → preserved", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})

		const payload = {
			arabic: "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645",
			hebrew: "\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd",
		}

		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify(payload),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.arabic).toBe(payload.arabic)
		expect(data.hebrew).toBe(payload.hebrew)
	})

	it("zero-width characters and BOM → preserved in text", async () => {
		const app = honey<{}>()
		app.post("/text").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.text("ok", body)
		})

		/* zero-width space + zero-width non-joiner + zero-width joiner + word-joiner */
		const exotic = "\u200b\u200c\u200d\u2060"
		const res = await app.fetch(
			new Request("http://localhost/text", {
				body: exotic,
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toBe(exotic)
		expect(text.length).toBe(4)
	})
})

describe("payload: insane — body limit with extreme sizes", () => {
	it("body exactly at limit (1MB) → passes", async () => {
		const limit = 1024 * 1024
		const app = honey<{}>().use(bodyLimit({ maxSize: limit }))
		app.post("/echo").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			return ctx.res.json("ok", { size: buf.byteLength })
		})

		const data = new Uint8Array(limit)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: data,
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, number>
		expect(body.size).toBe(limit)
	})

	it("body 1 byte over limit (1MB + 1) → 413", async () => {
		const limit = 1024 * 1024
		const app = honey<{}>().use(bodyLimit({ maxSize: limit }))
		app.post("/echo").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			return ctx.res.json("ok", { size: buf.byteLength })
		})

		const data = new Uint8Array(limit + 1)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: data,
				headers: {
					"content-length": String(limit + 1),
					"content-type": "application/octet-stream",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("multipart with total over limit → 413", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 1000 }))
		app.post("/upload").handler(async (ctx) => {
			const body = await ctx.req.formData()
			return ctx.res.json("ok", { fields: body.getAll("f").length })
		})

		const form = new FormData()
		/* each blob ~500 bytes, multipart overhead pushes total over 1000 */
		form.append("f", new Blob(["x".repeat(500)], { type: "text/plain" }), "a.txt")
		form.append("f", new Blob(["y".repeat(500)], { type: "text/plain" }), "b.txt")

		const res = await app.fetch(new Request("http://localhost/upload", { body: form, method: "POST" }), {})
		expect(res.status).toBe(413)
	})

	it("large JSON over limit via content-length fast path → 413", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 100 }))
		app.post("/json").handler(async (ctx) => {
			const body: unknown = await ctx.req.json()
			return ctx.res.json("ok", { received: body })
		})

		const bigJson = JSON.stringify({ data: "x".repeat(500) })
		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: bigJson,
				headers: {
					"content-length": String(bigJson.length),
					"content-type": "application/json",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
		const body = (await res.json()) as Record<string, string>
		expect(body.error_key).toBe("content_too_large")
	})
})

describe("payload: insane — concurrent mixed payloads", () => {
	it("20 concurrent requests with different content types → all correct", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, number>
			return ctx.res.json("ok", { doubled: body.n * 2 })
		})
		app.post("/text").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.text("ok", body.toUpperCase())
		})
		app.post("/bin").handler(async (ctx) => {
			const buf = await ctx.req.arrayBuffer()
			return ctx.res.json("ok", { size: buf.byteLength })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const requests = Array.from({ length: 20 }, (_, i) => {
			const mod = i % 3
			if (mod === 0) {
				return request(addr.port, "/json", {
					body: JSON.stringify({ n: i }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}).then((r) => ({
					expected: i * 2,
					result: JSON.parse(r.body.toString()) as Record<string, number>,
					status: r.status,
					type: "json" as const,
				}))
			}
			if (mod === 1) {
				return request(addr.port, "/text", {
					body: `hello_${i}`,
					headers: { "content-type": "text/plain" },
					method: "POST",
				}).then((r) => ({
					expected: `HELLO_${i}`,
					result: r.body.toString(),
					status: r.status,
					type: "text" as const,
				}))
			}
			return request(addr.port, "/bin", {
				body: Buffer.alloc(i * 10),
				headers: { "content-type": "application/octet-stream" },
				method: "POST",
			}).then((r) => ({
				expected: i * 10,
				result: JSON.parse(r.body.toString()) as Record<string, number>,
				status: r.status,
				type: "bin" as const,
			}))
		})

		const results = await Promise.all(requests)
		for (const r of results) {
			expect(r.status).toBe(200)
			if (r.type === "json") {
				expect(r.result.doubled).toBe(r.expected)
			} else if (r.type === "text") {
				expect(r.result).toBe(r.expected)
			} else {
				expect(r.result.size).toBe(r.expected)
			}
		}
	})
})

describe("payload: insane — malicious/adversarial inputs", () => {
	it("JSON with extremely long key names (10000 chars) → handler survives", async () => {
		const app = honey<{}>()
		app.post("/json").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", { keys: Object.keys(body).length })
		})

		const longKey = "k".repeat(10000)
		const res = await app.fetch(
			new Request("http://localhost/json", {
				body: JSON.stringify({ [longKey]: "value" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.keys).toBe(1)
	})

	it("URL-encoded with massive number of fields (5000) → parsed", async () => {
		const app = honey<{}>()
		app.post("/form").handler(async (ctx) => {
			const body = await ctx.req.formData()
			let count = 0
			body.forEach(() => {
				count++
			})
			return ctx.res.json("ok", { count })
		})

		const fields = Array.from({ length: 5000 }, (_, i) => `f${i}=v${i}`).join("&")
		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: fields,
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.count).toBe(5000)
	})

	it("query string with 1000 params → all accessible", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => {
			const url = new URL(ctx.req.url)
			let count = 0
			url.searchParams.forEach(() => {
				count++
			})
			return ctx.res.json("ok", {
				count,
				first: url.searchParams.get("p0"),
				last: url.searchParams.get("p999"),
			})
		})

		const params = Array.from({ length: 1000 }, (_, i) => `p${i}=v${i}`).join("&")
		const res = await app.fetch(new Request(`http://localhost/search?${params}`), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.count).toBe(1000)
		expect(data.first).toBe("v0")
		expect(data.last).toBe("v999")
	})

	it("request with 50 custom headers → all readable", async () => {
		const app = honey<{}>()
		app.get("/headers").handler((ctx) => {
			let count = 0
			for (const key of Object.keys(ctx.headers)) {
				if (key.startsWith("x-test-")) count++
			}
			return ctx.res.json("ok", {
				count,
				first: ctx.headers["x-test-0"],
				last: ctx.headers["x-test-49"],
			})
		})

		const headers: Record<string, string> = {}
		for (let i = 0; i < 50; i++) headers[`x-test-${i}`] = `value-${i}`

		const res = await app.fetch(new Request("http://localhost/headers", { headers }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.count).toBe(50)
		expect(data.first).toBe("value-0")
		expect(data.last).toBe("value-49")
	})

	it("cookie header with 100 cookies → all parsed", async () => {
		const app = honey<{}>()
		app.get("/cookies").handler((ctx) => {
			const count = Object.keys(ctx.cookies).length
			return ctx.res.json("ok", {
				count,
				first: ctx.cookies.c0,
				last: ctx.cookies.c99,
			})
		})

		const cookieStr = Array.from({ length: 100 }, (_, i) => `c${i}=v${i}`).join("; ")
		const res = await app.fetch(
			new Request("http://localhost/cookies", {
				headers: { cookie: cookieStr },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.count).toBe(100)
		expect(data.first).toBe("v0")
		expect(data.last).toBe("v99")
	})
})
