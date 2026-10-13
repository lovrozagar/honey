import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { serverTiming } from "../../../src/server-timing.ts"

describe("server-timing middleware — internal", () => {
	it("response has Server-Timing header", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("server-timing")).toBeTruthy()
	})

	it("timing.start + timing.end produces named duration", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
				start(name: string): void
			}
			timing.start("db")
			timing.end("db")
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const header = res.headers.get("server-timing") ?? ""
		expect(header).toContain("db;dur=")
	})

	it("multiple timings comma-separated", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
				start(name: string): void
			}
			timing.start("auth")
			timing.end("auth")
			timing.start("db")
			timing.end("db")
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const header = res.headers.get("server-timing") ?? ""
		expect(header).toContain("auth;dur=")
		expect(header).toContain("db;dur=")
		expect(header).toContain(", ")
	})

	it("description included when provided", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
				start(name: string, desc?: string): void
			}
			timing.start("db", "Database query")
			timing.end("db")
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const header = res.headers.get("server-timing") ?? ""
		expect(header).toContain('db;desc="Database query";dur=')
	})

	it("timing.end without start → ignored", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
			}
			timing.end("never-started")
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const header = res.headers.get("server-timing") ?? ""
		expect(header).not.toContain("never-started")
	})

	it("timing.start without end → auto-closes at response", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				start(name: string): void
			}
			timing.start("open")
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const header = res.headers.get("server-timing") ?? ""
		expect(header).toContain("open;dur=")
	})

	it("duration values are non-negative", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
				start(name: string): void
			}
			timing.start("fast")
			timing.end("fast")
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const header = res.headers.get("server-timing") ?? ""
		const durMatch = header.match(/dur=([0-9.]+)/)
		expect(durMatch).toBeTruthy()
		expect(Number(durMatch?.[1])).toBeGreaterThanOrEqual(0)
	})
})

describe("server-timing middleware — consumer", () => {
	it("handler with DB + auth timing → both visible in header", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/users").handler(async (ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
				start(name: string): void
			}
			timing.start("auth")
			await new Promise((r) => setTimeout(r, 5))
			timing.end("auth")
			timing.start("db")
			await new Promise((r) => setTimeout(r, 5))
			timing.end("db")
			return ctx.res.json("ok", { users: [] })
		})

		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(200)
		const header = res.headers.get("server-timing") ?? ""
		expect(header).toContain("auth;dur=")
		expect(header).toContain("db;dur=")
	})

	it("semicolon in timer name sanitized", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
				start(name: string): void
			}
			timing.start('db;desc="hacked"')
			timing.end('db;desc="hacked"')
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const header = res.headers.get("server-timing") ?? ""
		/* semicolons and quotes stripped — no injection possible */
		expect(header).not.toContain(";desc=")
		expect(header).not.toContain('"hacked"')
	})

	it("quotes in description escaped", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/test").handler((ctx) => {
			const timing = ctx.timing as {
				end(name: string): void
				start(name: string, desc?: string): void
			}
			timing.start("db", 'query";injected=true')
			timing.end("db")
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const header = res.headers.get("server-timing") ?? ""
		/* quote in description escaped — stays inside quoted string, not a separate param */
		expect(header).toContain('desc="query\\"')
		/* the raw unescaped quote does NOT appear */
		expect(header).not.toMatch(/desc="query";/)
	})
})
