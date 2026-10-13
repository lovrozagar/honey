/**
 * Regression guards for workstream 3 of the 3ab88ce deep review (request normalization and
 * trust boundary). Each test reproduces a finding's scenario and failed on 3ab88ce; see
 * docs/regression-matrix/ws1-3.md. Only APIs that existed at 3ab88ce are used.
 */
import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createMiddleware, honey } from "../../src/index.ts"
import { type HoneyServer, serve } from "../../src/node.ts"

type Fetchable = { fetch(r: Request, e?: object): Response | Promise<Response> }

async function send(app: Fetchable, url: string, init: RequestInit = {}): Promise<Response | "threw"> {
	try {
		return await app.fetch(new Request(url, init), {})
	} catch {
		return "threw"
	}
}

let server: HoneyServer | null = null
afterEach(async () => {
	await server?.shutdown(200)
	server = null
})

function listen(app: Fetchable): Promise<number> {
	const s = serve(app as never, { env: {}, hostname: "127.0.0.1", port: 0 } as never)
	server = s
	return new Promise((resolve) => {
		s.once("listening", () => resolve((s.address() as { port: number }).port))
	})
}

function raw(port: number, text: string, ms = 2_000): Promise<string> {
	return new Promise((resolve) => {
		const s = net.connect(port, "127.0.0.1")
		let got = ""
		const done = () => {
			clearTimeout(t)
			s.destroy()
			resolve(got)
		}
		const t = setTimeout(done, ms)
		s.on("data", (d) => {
			got += d.toString("latin1")
		})
		s.on("error", done)
		s.on("close", done)
		s.write(text)
	})
}

/** An app whose `/admin/*` handler reveals itself; everything else is a plain 404. */
function adminApp() {
	const app = honey()
	app.get("/admin/secret").handler((c) => c.res.json("ok", { secret: true, path: c.path }))
	app.get("/users").handler((c) => c.res.json("ok", { users: true }))
	return app
}

describe("WS3 regressions", () => {
	// regression: M ctx.path raw
	it("M-ctx-path: ctx.path is the normalized path the router matched", async () => {
		const app = honey()
		const seen: string[] = []
		const guard = createMiddleware(async (c: { path: string }, next) => {
			seen.push(c.path)
			return c.path.startsWith("/admin") ? new Response("no", { status: 401 }) : next()
		})
		app
			.use(guard)
			.get("/admin/secret")
			.handler((c) => c.res.json("ok", { secret: true }))
		const res = await send(app, "http://x//admin/secret")
		expect(res).not.toBe("threw")
		expect((res as Response).status).toBe(401)
		expect(seen).toEqual(["/admin/secret"])
	})

	// regression: H Node URL from Host (was M)
	it("H-node-host: Node routes on the request target, never on the Host header", async () => {
		const port = await listen(adminApp())
		const viaHost = await raw(
			port,
			"GET /nothing HTTP/1.1\r\nHost: evil.example/admin/secret?\r\nConnection: close\r\n\r\n",
		)
		expect(viaHost).not.toContain('"secret":true')
		const prefixed = await raw(port, "GET /users HTTP/1.1\r\nHost: h/admin\r\nConnection: close\r\n\r\n")
		expect(prefixed).not.toMatch(/HTTP\/1\.1 404/)
		expect(prefixed).not.toContain('"secret"')
	})

	it("H-node-host: an absolute-form target routes by its path, not by a re-glued URL", async () => {
		const port = await listen(adminApp())
		const res = await raw(port, "GET http://h/users HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
		expect(res).toContain('"users":true')
	})

	it("H-node-host: a malformed Host is a 400, not a 500", async () => {
		const port = await listen(adminApp())
		const res = await raw(port, "GET /users?x=1 HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n")
		expect(res).toMatch(/^HTTP\/1\.1 400/)
	})

	it("H-node-host: dot segments in the target are resolved before routing", async () => {
		const app = honey()
		app.get("/files/*rest").handler((c) => c.res.json("ok", { rest: c.params.rest }))
		app.get("/admin/secret").handler((c) => c.res.json("ok", { secret: true }))
		const port = await listen(app)
		const res = await raw(port, "GET /files/../admin/secret HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
		expect(res).not.toContain("../admin")
	})

	// regression: M trailing-slash Location
	it("M-redirect: trailing-slash redirects send a relative Location", async () => {
		const app = honey().trailingSlash("strip")
		app.get("/users").handler((c) => c.res.json("ok", {}))
		const res = await send(app, "http://internal.host:8080/users/?page=2")
		expect(res).not.toBe("threw")
		const location = (res as Response).headers.get("location")
		expect(location).not.toBeNull()
		expect(location?.startsWith("/")).toBe(true)
		expect(location).not.toContain("internal.host")
	})

	// regression: M prototype query keys
	it("M-proto-query: prototype-named query keys never turn into 500s", async () => {
		const app = honey()
		app
			.get("/q")
			.handler((c) => c.res.json("ok", { v: c.search["__proto__"] ?? null, all: c.searchAll["toString"] ?? null }))
		for (const q of ["__proto__=1", "constructor=1", "toString=1", "valueOf=1"]) {
			const res = await send(app, `http://x/q?${q}`)
			expect(res, q).not.toBe("threw")
			expect((res as Response).status, q).toBe(200)
		}
	})

	// regression: L prototype keys in validated search
	it("L-proto-validated: ?__proto__ never replaces the validated search object's prototype", async () => {
		const { z } = await import("zod")
		const app = honey()
		app
			.get("/v")
			.input({ search: z.record(z.string(), z.unknown()) })
			.handler((c) => {
				const s = c.input.search as Record<string, unknown>
				return c.res.json("ok", {
					proto: Object.getPrototypeOf(s) === null || Object.getPrototypeOf(s) === Object.prototype,
				})
			})
		const res = await send(app, "http://x/v?__proto__=x")
		expect(res).not.toBe("threw")
		expect(await (res as Response).json()).toEqual({ proto: true })
	})

	// regression: L validation issue path ending in a prototype key
	it("L-proto-issue: a validation issue on a prototype-named field stays a 400", async () => {
		const { z } = await import("zod")
		const app = honey()
		app
			.post("/b")
			.input({ json: z.record(z.string(), z.number()) })
			.handler((c) => c.res.json("ok", {}))
		const res = await send(app, "http://x/b", {
			body: JSON.stringify({ toString: "x" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res).not.toBe("threw")
		expect((res as Response).status).toBe(400)
	})

	// regression: L headers.get on a prototype name
	it("L-proto-headers: a response header view never returns a prototype member", async () => {
		let seen = "unset"
		const peek = createMiddleware(async (_c, next) => {
			const res = await next()
			seen = typeof res.headers.get("constructor")
			return res
		})
		const app = honey()
		app
			.use(peek)
			.get("/h")
			.handler((c) => c.res.json("ok", {}, { headers: { "x-a": "1" } }))
		/* the plain-map header view is the Node fast path, so go through the adapter */
		const port = await listen(app)
		const res = await raw(port, "GET /h HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
		expect(res).toMatch(/^HTTP\/1\.1 200/)
		/* null — a header lookup must never find Object.prototype members */
		expect(seen).toBe("object")
	})
})
