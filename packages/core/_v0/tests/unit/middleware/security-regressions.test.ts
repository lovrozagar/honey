/**
 * Security regressions for the shipped middleware. Each block names the bug
 * class it guards: either a past honey finding or a class of advisory filed
 * against hono or elysia middleware that does the same job.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { bodyLimit } from "../../../src/body-limit.ts"
import { cors } from "../../../src/cors.ts"
import { csrf } from "../../../src/csrf.ts"
import { buildCurlLogData, curlLogger, type CurlLogData } from "../../../src/curl-logger.ts"
import { honey } from "../../../src/index.ts"
import { logger } from "../../../src/logger.ts"
import { type HoneyServer, serve } from "../../../src/node.ts"
import { requestId } from "../../../src/request-id.ts"
import { requestToCurl, shellQuote } from "../../../src/request-to-curl.ts"
import { secureHeaders } from "../../../src/secure-headers.ts"
import { serverTiming } from "../../../src/server-timing.ts"

function post(url: string, headers: Record<string, string>, body: BodyInit | null = "{}") {
	return new Request(url, { body, headers, method: "POST" })
}

describe("csrf", () => {
	const app = honey<{}>().use(csrf({ origin: ["https://partner.example"] }))
	app.post("/transfer").handler((ctx) => ctx.res.json("ok", { done: true }))
	app.delete("/account").handler((ctx) => ctx.res.json("ok", { done: true }))
	const hit = (headers: Record<string, string>) =>
		app.fetch(new Request("http://bank.example/transfer", { body: "{}", headers, method: "POST" }), {})

	/* H23: a cross-site `fetch(url, {mode: "no-cors", body: new Blob([json])})`
	 * has no Content-Type and used to skip the check entirely. */
	it("cross-site request without Content-Type → 403", async () => {
		const res = await app.fetch(
			new Request("http://bank.example/transfer", {
				body: new Blob(['{"to":"attacker"}']),
				headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	/* advisory class: CSRF checks keyed on a form Content-Type, bypassed with
	 * case or parameter tricks (`Application/x-www-form-urlencoded`, `text/plain;x`) */
	for (const type of [
		"Application/X-WWW-Form-Urlencoded",
		"text/plain;charset=utf-8",
		"multipart/form-data; boundary=x",
		"application/json",
		"application/octet-stream",
		"",
	]) {
		it(`cross-site with Content-Type ${JSON.stringify(type)} → 403`, async () => {
			const res = await hit({ "content-type": type, origin: "https://evil.example", "sec-fetch-site": "cross-site" })
			expect(res.status).toBe(403)
		})
	}

	it("every unsafe method is checked, not only POST", async () => {
		const res = await app.fetch(
			new Request("http://bank.example/account", {
				headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
				method: "DELETE",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("same-site (sibling subdomain) is not trusted unless allow-listed", async () => {
		expect((await hit({ origin: "https://blog.bank.example", "sec-fetch-site": "same-site" })).status).toBe(403)
	})

	it("allow-listed cross-origin caller passes", async () => {
		expect((await hit({ origin: "https://partner.example", "sec-fetch-site": "cross-site" })).status).toBe(200)
	})

	it("same-origin and user-initiated (`none`) pass", async () => {
		expect((await hit({ "sec-fetch-site": "same-origin" })).status).toBe(200)
		expect((await hit({ "sec-fetch-site": "none" })).status).toBe(200)
	})

	it("without Sec-Fetch-Site: Origin must match Host or the allow-list", async () => {
		expect((await hit({ host: "bank.example", origin: "http://bank.example" })).status).toBe(200)
		expect((await hit({ host: "bank.example", origin: "https://evil.example" })).status).toBe(403)
		expect((await hit({ host: "bank.example", origin: "https://partner.example" })).status).toBe(200)
	})

	it("opaque `Origin: null` is rejected", async () => {
		expect((await hit({ origin: "null" })).status).toBe(403)
	})

	it("allow-list is an exact match, not a prefix or suffix", async () => {
		expect((await hit({ origin: "https://partner.example.evil.example", "sec-fetch-site": "cross-site" })).status).toBe(
			403,
		)
		expect((await hit({ origin: "https://evilpartner.example", "sec-fetch-site": "cross-site" })).status).toBe(403)
	})

	it("no Origin and no Sec-Fetch-Site (curl, server-to-server) passes", async () => {
		expect((await hit({})).status).toBe(200)
	})
})

describe("cors", () => {
	/* H24 / advisory class: credentialed CORS reflecting arbitrary origins */
	it("credentials with a wildcard or missing origin is a construction error", () => {
		expect(() => cors({ credentials: true })).toThrow()
		expect(() => cors({ credentials: true, origin: "*" })).toThrow()
	})

	/* advisory class: string origin matched as a prefix/substring */
	it("a string origin matches exactly", async () => {
		const app = honey<{}>().use(cors({ credentials: true, origin: "https://app.example" }))
		app.get("/me").handler((ctx) => ctx.res.json("ok", {}))
		for (const origin of ["https://app.example.evil.test", "https://evilapp.example", "https://app.example:8443"]) {
			const res = await app.fetch(new Request("http://api.test/me", { headers: { origin } }), {})
			expect(res.headers.get("access-control-allow-origin")).toBeNull()
		}
	})

	it("`null` is never reflected, even by an accept-all predicate", async () => {
		const app = honey<{}>().use(cors({ credentials: true, origin: () => true }))
		app.get("/me").handler((ctx) => ctx.res.json("ok", {}))
		const preflight = await app.fetch(
			new Request("http://api.test/me", {
				headers: { "access-control-request-method": "GET", origin: "null" },
				method: "OPTIONS",
			}),
			{},
		)
		expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
	})

	/* shared-cache poisoning: without `Vary: Origin` on the responses that carry
	 * no ACAO, a cache can serve them to an allowed origin (or the reverse) */
	it("`Vary: Origin` on allowed, disallowed and Origin-less responses", async () => {
		const app = honey<{}>().use(cors({ origin: ["https://app.example"] }))
		app.get("/data").handler((ctx) => ctx.res.json("ok", {}))
		for (const headers of [{ origin: "https://app.example" }, { origin: "https://evil.example" }, {}]) {
			const res = await app.fetch(new Request("http://api.test/data", { headers }), {})
			expect(res.headers.get("vary")).toContain("Origin")
		}
	})

	it("merges with a handler's Vary instead of duplicating", async () => {
		const app = honey<{}>().use(cors({ origin: ["https://app.example"] }))
		app.get("/data").handler(() => new Response("x", { headers: { vary: "Accept-Encoding, origin" } }))
		const res = await app.fetch(new Request("http://api.test/data", { headers: { origin: "https://app.example" } }), {})
		expect(res.headers.get("vary")).toBe("Accept-Encoding, origin")
	})

	it("plain wildcard needs no Vary", async () => {
		const app = honey<{}>().use(cors())
		app.get("/data").handler((ctx) => ctx.res.json("ok", {}))
		const res = await app.fetch(new Request("http://api.test/data", { headers: { origin: "https://x.example" } }), {})
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("vary")).toBeNull()
	})

	it("a preflight that reflects requested headers varies on them", async () => {
		const app = honey<{}>().use(cors())
		app.post("/data").handler((ctx) => ctx.res.json("ok", {}))
		const res = await app.fetch(
			new Request("http://api.test/data", {
				headers: {
					"access-control-request-headers": "x-custom",
					"access-control-request-method": "POST",
					origin: "https://x.example",
				},
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.headers.get("access-control-allow-headers")).toBe("x-custom")
		expect(res.headers.get("vary")).toContain("Access-Control-Request-Headers")
	})
})

describe("curlLogger and requestToCurl", () => {
	const capture = () => {
		const lines: CurlLogData[] = []
		return { lines, log: (d: CurlLogData) => lines.push(d) }
	}

	it("redacts credentials and token-like query params by default", async () => {
		const data = await buildCurlLogData(
			new Request("https://api.test/cb?code=abc&access_token=t&page=2&apiKey=k", {
				headers: {
					authorization: "Bearer s3cret",
					cookie: "sid=1",
					"x-api-key": "k",
					"x-session-token": "t",
					"x-visible": "ok",
				},
			}),
		)
		expect(data.curl).not.toContain("s3cret")
		expect(data.curl).not.toContain("sid=1")
		expect(data.curl).not.toMatch(/code=abc|access_token=t|apiKey=k/)
		expect(data.curl).toContain("page=2")
		expect(data.curl).toContain("'x-visible: ok'")
		expect(data.curl).toContain("'authorization: [REDACTED]'")
		expect(data.curl).toContain("'x-session-token: [REDACTED]'")
	})

	/* command injection: the method was interpolated unquoted */
	it("quotes the method", async () => {
		const fake = { body: null, headers: new Headers(), method: "`id`", url: "http://a.test/" } as unknown as Request
		expect(
			await requestToCurl({ ...fake, clone: () => ({ ...fake, text: async () => "" }) } as unknown as Request),
		).toBe("curl -X '`id`' 'http://a.test/'")
		expect((await buildCurlLogData(fake)).curl).toBe("curl -X '`id`' 'http://a.test/'")
	})

	/* log-line forgery: a raw newline in a body or header split the logged command */
	it("control characters are escaped with ANSI-C quoting", () => {
		expect(shellQuote("a\nb'c")).toBe("$'a\\x0ab\\'c'")
		expect(shellQuote("\u001b[31mred")).toBe("$'\\x1b[31mred'")
		expect(shellQuote("plain 'quoted'")).toBe("'plain '\\''quoted'\\'''")
	})

	/* H4: building the command started before next() and was awaited after;
	 * a throw in between was an unhandled rejection that exits Node */
	it("a throwing redactHeader never fails the request or leaks a rejection", async () => {
		const onRejection = vi.fn()
		process.on("unhandledRejection", onRejection)
		try {
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			const app = honey<{}>().use(
				curlLogger({
					log: () => {},
					redactHeader: () => {
						throw new Error("boom")
					},
				}),
			)
			app.get("/x").handler((ctx) => ctx.res.text("ok", "ok"))
			const res = await app.fetch(new Request("http://a.test/x", { headers: { a: "1" } }), {})
			expect(res.status).toBe(200)
			await new Promise((r) => setTimeout(r, 10))
			expect(onRejection).not.toHaveBeenCalled()
			expect(consoleError).toHaveBeenCalled()
			consoleError.mockRestore()
		} finally {
			process.off("unhandledRejection", onRejection)
		}
	})

	it("a downstream middleware throw does not leak a rejection", async () => {
		const onRejection = vi.fn()
		process.on("unhandledRejection", onRejection)
		try {
			const sink = capture()
			const app = honey<{}>()
				.use(curlLogger({ body: true, log: sink.log }))
				.use(csrf())
			app.post("/x").handler((ctx) => ctx.res.text("ok", "ok"))
			const res = await app.fetch(
				post("http://a.test/x", { "content-type": "application/json", "sec-fetch-site": "cross-site" }),
				{},
			)
			expect(res.status).toBe(403)
			await new Promise((r) => setTimeout(r, 10))
			expect(onRejection).not.toHaveBeenCalled()
			expect(sink.lines[0]?.status).toBe(403)
		} finally {
			process.off("unhandledRejection", onRejection)
		}
	})

	/* NEW: a malformed Host on Node made `new URL(req.url)` reject → every request 500 */
	it("an unparsable request URL is logged without its query instead of failing", async () => {
		const fake = {
			body: null,
			headers: new Headers({ host: "a b" }),
			method: "GET",
			url: "http://a b/x?token=1",
		} as unknown as Request
		const data = await buildCurlLogData(fake)
		expect(data.curl).toBe("curl -X 'GET' -H 'host: a b' 'http://a b/x'")
	})

	it("skip runs before any formatting", async () => {
		const redact = vi.fn((_n: string, v: string) => v)
		const sink = capture()
		const app = honey<{}>().use(curlLogger({ log: sink.log, redactHeader: redact, skip: () => true }))
		app.get("/x").handler((ctx) => ctx.res.text("ok", "ok"))
		await app.fetch(new Request("http://a.test/x", { headers: { a: "1" } }), {})
		expect(redact).not.toHaveBeenCalled()
		expect(sink.lines).toHaveLength(0)
	})

	let server: HoneyServer | undefined
	afterEach(async () => {
		await server?.shutdown(1000)
		server = undefined
	})

	/* WS5 (M): on Node, curlLogger({body:true}) cloned the request, which locked
	 * the body stream bodyLimit read next → 500 on every loggable POST */
	it("curlLogger({body:true}) before bodyLimit on Node → 200 and the body logged", async () => {
		const sink = capture()
		const app = honey<{}>()
			.use(curlLogger({ body: true, log: sink.log }))
			.use(bodyLimit({ maxSize: 1024 }))
		app.post("/echo").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
		server = serve(app, { env: {}, port: 0 })
		const { port } = server.address() as { port: number }
		const res = await fetch(`http://127.0.0.1:${port}/echo`, {
			body: '{"a":1}',
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('{"a":1}')
		expect(sink.lines[0]?.curl).toContain(`--data-raw '{"a":1}'`)
	})
})

describe("logger", () => {
	it("a throwing sink does not fail the request", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const app = honey<{}>().use(
			logger({
				log: () => {
					throw new Error("disk full")
				},
			}),
		)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "ok"))
		const res = await app.fetch(new Request("http://a.test/x"), {})
		expect(res.status).toBe(200)
		consoleError.mockRestore()
	})
})

describe("requestId", () => {
	const app = honey<{}>().use(requestId())
	app.get("/x").handler((ctx) => ctx.res.text("ok", ctx.requestId))

	/* header reflection / log forgery: inbound ids were echoed unvalidated */
	for (const bad of ["a".repeat(6000), "id with spaces", "x\tinjected", "<script>", "a,b", "\u00e9t\u00e9"]) {
		it(`replaces an unsafe inbound id (${JSON.stringify(bad.slice(0, 12))})`, async () => {
			const res = await app.fetch(new Request("http://a.test/x", { headers: { "x-request-id": bad } }), {})
			const id = res.headers.get("x-request-id") ?? ""
			expect(id).not.toBe(bad)
			expect(id).toMatch(/^[0-9a-f-]{36}$/)
			expect(await res.text()).toBe(id)
		})
	}

	for (const good of ["0b9f6c1e-4d1c-4c2a-9a7f-2d1c4f1b2a3c", "01HZY3K8Q4", "trace:abc.def/1+2=", "a_b-c"]) {
		it(`keeps a safe inbound id (${good})`, async () => {
			const res = await app.fetch(new Request("http://a.test/x", { headers: { "x-request-id": good } }), {})
			expect(res.headers.get("x-request-id")).toBe(good)
		})
	}

	it("a custom validate replaces the default", async () => {
		const custom = honey<{}>().use(requestId({ validate: (id) => id.startsWith("req_") }))
		custom.get("/x").handler((ctx) => ctx.res.text("ok", ctx.requestId))
		const res = await custom.fetch(new Request("http://a.test/x", { headers: { "x-request-id": "req_ 1" } }), {})
		expect(res.headers.get("x-request-id")).toBe("req_ 1")
	})
})

describe("serverTiming", () => {
	/* CR/LF in a name or non-latin1 in a description threw from Headers → 500 */
	it("hostile metric names and descriptions produce a valid header", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/x").handler((ctx) => {
			ctx.timing.start("db\r\nset-cookie: a=1", 'naïve 日本 "quoted" \\ \n')
			ctx.timing.end("db\r\nset-cookie: a=1")
			ctx.timing.start("cache hit", "ok")
			ctx.timing.start("")
			return ctx.res.text("ok", "ok")
		})
		const res = await app.fetch(new Request("http://a.test/x"), {})
		expect(res.status).toBe(200)
		const header = res.headers.get("server-timing") ?? ""
		expect(header).not.toMatch(/[\r\n]/)
		expect(header).toContain('db__set-cookie__a_1;desc="naïve ?? \\"quoted\\" \\\\ ?"')
		expect(header).toContain('cache_hit;desc="ok"')
		expect(header).toMatch(/(^|, )_;dur=/)
		expect(res.headers.get("set-cookie")).toBeNull()
	})

	it("keeps an upstream Server-Timing", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/x").handler(() => new Response("x", { headers: { "server-timing": "edge;dur=1" } }))
		const res = await app.fetch(new Request("http://a.test/x"), {})
		expect(res.headers.get("server-timing")).toMatch(/^edge;dur=1, total;dur=/)
	})
})

describe("secureHeaders", () => {
	it("never overwrites a stricter handler-set CSP or X-Frame-Options", async () => {
		const app = honey<{}>().use(secureHeaders({ contentSecurityPolicy: "default-src 'self'" }))
		app.get("/strict").handler(
			() =>
				new Response("x", {
					headers: { "content-security-policy": "default-src 'none'", "x-frame-options": "DENY" },
				}),
		)
		app.get("/plain").handler((ctx) => ctx.res.text("ok", "x"))
		const strict = await app.fetch(new Request("http://a.test/strict"), {})
		expect(strict.headers.get("content-security-policy")).toBe("default-src 'none'")
		expect(strict.headers.get("x-frame-options")).toBe("DENY")
		const plain = await app.fetch(new Request("http://a.test/plain"), {})
		expect(plain.headers.get("content-security-policy")).toBe("default-src 'self'")
		expect(plain.headers.get("x-frame-options")).toBe("SAMEORIGIN")
	})
})

describe("bodyLimit", () => {
	const make = (opts: Parameters<typeof bodyLimit>[0]) => {
		const app = honey<{}>().use(bodyLimit(opts))
		const echo = async (ctx: { req: Request; res: { text: (k: "ok", b: string) => Response } }) =>
			ctx.res.text("ok", String((await ctx.req.text()).length))
		app.post("/x").handler(echo as never)
		app.delete("/x").handler(echo as never)
		app.on(["PROPFIND"], "/x").handler(echo as never)
		return app
	}

	it("DELETE with an oversized body → 413", async () => {
		const app = make({ maxSize: 10 })
		const res = await app.fetch(new Request("http://a.test/x", { body: "x".repeat(100), method: "DELETE" }), {})
		expect(res.status).toBe(413)
	})

	it("an extension method with a body is limited too", async () => {
		const app = make({ maxSize: 10 })
		const res = await app.fetch(new Request("http://a.test/x", { body: "x".repeat(100), method: "PROPFIND" }), {})
		expect(res.status).toBe(413)
	})

	it("media-type limits are case-insensitive and ignore parameters", async () => {
		const app = make({ limits: { "application/json": 10 }, maxSize: 1000 })
		for (const type of ["Application/JSON", "application/json; charset=utf-8", " APPLICATION/json"]) {
			const res = await app.fetch(post("http://a.test/x", { "content-type": type }, "x".repeat(50)), {})
			expect(res.status).toBe(413)
		}
	})

	it("the longest matching key wins", async () => {
		const app = make({ limits: { "application/": 1000, "application/json": 10 }, maxSize: 1000 })
		const res = await app.fetch(post("http://a.test/x", { "content-type": "application/json" }, "x".repeat(50)), {})
		expect(res.status).toBe(413)
	})

	/* advisory class: a declared Content-Length smaller than the real body
	 * bypassed the limit when the declared value was trusted */
	it("a lying Content-Length is still counted by default", async () => {
		const app = make({ maxSize: 10 })
		const res = await app.fetch(post("http://a.test/x", { "content-length": "5" }, "x".repeat(100)), {})
		expect(res.status).toBe(413)
	})

	it("after an overflow the drain is bounded: an endless body is cancelled", async () => {
		const app = make({ maxSize: 10 })
		let cancelled = false
		let pulled = 0
		const endless = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true
			},
			pull(controller) {
				pulled += 1
				controller.enqueue(new Uint8Array(64 * 1024))
			},
		})
		const res = await app.fetch(
			new Request("http://a.test/x", { body: endless, duplex: "half", method: "POST" } as RequestInit),
			{},
		)
		expect(res.status).toBe(413)
		await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 2000 })
		expect(pulled * 64 * 1024).toBeLessThan(4 * 1024 * 1024)
	})
})
