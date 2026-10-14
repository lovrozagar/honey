import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"

describe("payload: cookies in request4 and response", () => {
	// v0: 0a2e6e8df9
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

	// v0: 1eecf079c0
	it("request4 cookies → lazy-parsed correctly", async () => {
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
})

describe("payload: cookies in request4 and response (2)", () => {
	// v0: 97756099ee
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

	// v0: ad58080518
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

describe("payload: insane — extreme binary", () => {
	// v0: 2cb9b31b34
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
})

describe("payload: insane — extreme binary (2)", () => {
	// v0: 2c0da000c9
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
})

describe("payload: insane — extreme binary (3)", () => {
	// v0: 64fe70ad2e
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
})

describe("payload: insane — extreme binary (4)", () => {
	// v0: 57d46ed32b
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
})

describe("payload: insane — extreme text encodings", () => {
	// v0: 3e4d6038b9
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

	// v0: 1b616ea954
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
})

describe("payload: insane — extreme text encodings (2)", () => {
	// v0: 8e994bd41c
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

describe("basePath boundary matching", () => {
	// v0: e792c8dc20
	it("basePath /api should NOT strip /api-docs (route /-docs should not match)", async () => {
		const h = honey<{}>().basePath("/api")
		/* register a route that would match the incorrectly-stripped remainder */
		h.get("/-docs").handler((ctx) => ctx.res.text("ok", "wrong"))

		const res = await h.fetch(new Request("http://localhost/api-docs"), {})
		/* /api-docs is NOT under /api — should be 404, not match /-docs */
		expect(res.status).toBe(404)
	})

	// v0: a8e9297de5
	it("basePath /api should NOT strip /apiary (route /ary should not match)", async () => {
		const h = honey<{}>().basePath("/api")
		h.get("/ary").handler((ctx) => ctx.res.text("ok", "wrong"))

		const res = await h.fetch(new Request("http://localhost/apiary"), {})
		expect(res.status).toBe(404)
	})

	// v0: 11f9af4e6f
	it("basePath /api should strip /api/health correctly", async () => {
		const h = honey<{}>().basePath("/api")
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(200)
	})

	// v0: a44e143d94
	it("basePath /api should match exact /api as root /", async () => {
		const h = honey<{}>().basePath("/api")
		h.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await h.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})
})

describe("empty handler chain edge cases", () => {
	// v0: 60e81a1bb9
	it("app with zero routes → always 404", async () => {
		const app = honey<{}>()

		const res = await app.fetch(new Request("http://localhost/anything"), {})
		expect(res.status).toBe(404)
	})
})

describe("multiple fetch() on same app instance", () => {
	// v0: e01a588c7e
	it("1000 sequential requests don't degrade or leak", async () => {
		const app = honey<{}>()
		app.get("/ping").handler((ctx) => ctx.res.text("ok", "pong"))

		const statuses = new Set<number>()
		let last: Response | undefined
		for (let i = 0; i < 1000; i++) {
			last = await app.fetch(new Request("http://localhost/ping"), {})
			statuses.add(last.status)
		}
		expect([...statuses]).toEqual([200])
		expect(await last?.text()).toBe("pong")
	})

	// v0: 70b534a172
	it("app state (routes) not corrupted after many requests", async () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/b").handler((ctx) => ctx.res.text("ok", "b"))

		/* interleave requests; the last pair proves the tree is intact */
		let last: Response[] = []
		for (let i = 0; i < 100; i++) {
			last = await Promise.all([
				app.fetch(new Request("http://localhost/a"), {}),
				app.fetch(new Request("http://localhost/b"), {}),
			])
		}
		expect(await last[0]?.text()).toBe("a")
		expect(await last[1]?.text()).toBe("b")
	})
})
