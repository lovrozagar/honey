import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { serve } from "../adapters/node/serve.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { requestId } from "../middleware/request-id.ts"
import { honey } from "../routing/app.ts"
import { createLogger } from "../telemetry/logger.ts"
import { buildCurlLogData, type CurlLogData, curlLogger, type CurlLoggerOptions } from "./curl-logger.ts"

/** GET and POST /users behind curlLogger(options); the POST echoes the body it reads after the logger. */
function app(options: CurlLoggerOptions = {}) {
	const logged: CurlLogData[] = []
	const lines: Record<string, unknown>[] = []
	const a = honey<{}>()
	a.logger(
		createLogger({
			format: "json",
			level: "info",
			write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
		}),
	)
	const routes = a.use(curlLogger({ log: (data) => logged.push(data), ...options }))
	routes.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))
	routes.post("/users").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
	return Object.assign(a, { lines, logged })
}

describe("buildCurlLogData(): the command", () => {
	// v0: 3a2f927c47
	// v0: 7cf2481d60
	it("no body unless asked, the original body left unread", async () => {
		const request = new Request("https://example.com/users?page=1", {
			body: JSON.stringify({ ok: true }),
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			method: "POST",
		})
		const [byDefault, off] = [
			await buildCurlLogData(request, {
				redactHeader: (name, value) => (name === "authorization" ? "[redacted]" : value),
			}),
			await buildCurlLogData(request, { body: false }),
		]
		expect([byDefault, off.bodyOmittedReason, await request.text()]).toEqual([
			{
				bodyIncluded: false,
				bodyOmittedReason: "disabled",
				curl: "curl -X 'POST' -H 'authorization: [redacted]' -H 'content-type: application/json' 'https://example.com/users?page=1'",
			},
			"disabled",
			'{"ok":true}',
		])
	})

	// v0: 3a00125209
	it("a bounded body of an allowed text type, quoted", async () => {
		const request = new Request("https://example.com/users", {
			body: JSON.stringify({ name: "O'Reilly" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(await buildCurlLogData(request, { body: { maxBytes: 1024 } })).toEqual({
			bodyIncluded: true,
			bodyOmittedReason: null,
			curl: "curl -X 'POST' -H 'content-type: application/json' --data-raw '{\"name\":\"O'\\''Reilly\"}' 'https://example.com/users'",
		})
	})
})

describe("buildCurlLogData(): a body left out, and why", () => {
	// v0: d07256f9f3
	// v0: a1b7cefd2e
	// v0: fb84ea984a
	// v0: eec46a3793
	it.each([
		[
			"a type not allowed",
			{ body: "file-bytes", headers: { "content-type": "multipart/form-data; boundary=abc" } },
			"content-type",
		],
		[
			"a declared length over the cap",
			{ body: '{"hello":"world"}', headers: { "content-length": "17", "content-type": "application/json" } },
			"too-large",
		],
		["no body at all", { headers: { "content-type": "application/json" } }, "missing"],
		["no content type", { body: new Uint8Array([120]) }, "content-type"],
		[
			"a stream past the cap with no declared length",
			{
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("12345"))
						controller.enqueue(new TextEncoder().encode("67890"))
						controller.close()
					},
				}),
				duplex: "half",
				headers: { "content-type": "application/json" },
			},
			"too-large",
		],
	])("%s: the body is left out, and why", async (_name, init, reason) => {
		const request = new Request("https://example.com/users", { method: "POST", ...init } as RequestInit)
		const data = await buildCurlLogData(request, { body: { maxBytes: 8 } })
		expect([data.bodyIncluded, data.bodyOmittedReason, data.curl.includes("--data-raw")]).toEqual([
			false,
			reason,
			false,
		])
	})

	it("a body that fails to read is left out as a read error, never a throw", async () => {
		const request = new Request("https://example.com/users", {
			body: new ReadableStream({
				pull(controller) {
					controller.error(new Error("socket reset"))
				},
			}),
			duplex: "half",
			headers: { "content-type": "application/json" },
			method: "POST",
		} as RequestInit)
		expect((await buildCurlLogData(request, { body: true })).bodyOmittedReason).toBe("read-error")
	})
})

describe("buildCurlLogData(): reading the body never fails", () => {
	it("a capped body whose source refuses to cancel leaves no rejection floating", async () => {
		const floating = vi.fn()
		process.on("unhandledRejection", floating)
		const request = new Request("https://example.com/users", {
			body: new ReadableStream<Uint8Array>({
				cancel() {
					throw new Error("source will not cancel")
				},
				pull(controller) {
					controller.enqueue(new TextEncoder().encode("0123456789"))
				},
			}),
			duplex: "half",
			headers: { "content-type": "text/plain" },
			method: "POST",
		} as RequestInit)
		const data = await buildCurlLogData(request, { body: { maxBytes: 4 } })
		/* the tee's source is cancelled only once both copies are: the request's own goes too */
		await request.body?.cancel().catch(() => {})
		await new Promise((resolve) => setTimeout(resolve, 10))
		process.off("unhandledRejection", floating)
		expect([data.bodyOmittedReason, floating.mock.calls.length]).toEqual(["too-large", 0])
	})
})

describe("buildCurlLogData(): redact hooks", () => {
	// v0: 8113161a62
	// v0: cb7ac31bc7
	it("a redact hook rewrites or drops a header or a query parameter", async () => {
		const request = new Request("https://example.com/users?token=secret&page=1&drop=1", {
			headers: { authorization: "Bearer secret", "x-visible": "ok" },
		})
		const data = await buildCurlLogData(request, {
			redactHeader: (name, value) => (name === "authorization" ? null : value),
			redactQueryParam: (name, value) => (name === "drop" ? null : name === "token" ? "[redacted]" : value),
		})
		expect(data.curl).toBe("curl -X 'GET' -H 'x-visible: ok' 'https://example.com/users?token=%5Bredacted%5D&page=1'")
	})
})

describe("curlLogger(): redaction by default", () => {
	// v0: 7c4242c967
	// v0: 29739c8752
	it("credentials, cookies, CSRF and token-like headers and query parameters are masked; the rest kept", async () => {
		const a = app()
		await a.fetch(
			new Request("http://app.test/users?access_token=t1&client_secret=s2&page=2", {
				headers: {
					authorization: "Bearer abc",
					cookie: "sid=1",
					"x-api-key": "k",
					"x-csrf-token": "c",
					"x-session-id": "s",
					"x-trace": "keep",
				},
			}),
			{},
		)
		const command = a.logged[0]?.curl ?? ""
		expect([
			["abc", "sid=1", "'x-api-key: k'", "'x-csrf-token: c'", "x-session-id: s'", "t1", "s2"].filter((secret) =>
				command.includes(secret),
			),
			command.includes("x-trace: keep") && command.includes("page=2"),
		]).toEqual([[], true])
	})
})

describe("curlLogger(): where the line goes", () => {
	// v0: 8b70f1e9cf
	it("a log hook gets the structured record, with the request id", async () => {
		const logged: CurlLogData[] = []
		const a = honey<{}>()
		a.use(requestId({ generate: () => "req-123" }))
			.use(curlLogger({ log: (data) => logged.push(data) }))
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", { users: [] }))
		await a.fetch(new Request("http://localhost/users"), {})
		expect(logged.map(({ duration: _duration, ...rest }) => rest)).toEqual([
			{
				bodyIncluded: false,
				bodyOmittedReason: "disabled",
				curl: "curl -X 'GET' 'http://localhost/users'",
				method: "GET",
				path: "/users",
				requestId: "req-123",
				status: 200,
			},
		])
	})

	// v0: 15e08b8108
	it("by default, the app's logger: one info line, the request's bindings on it", async () => {
		const a = honey<{}>()
		const lines: Record<string, unknown>[] = []
		a.logger(
			createLogger({
				format: "json",
				level: "info",
				write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
			}),
		)
		a.use(curlLogger())
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", { users: [] }))
		await a.fetch(new Request("http://localhost/users"), {})
		expect(lines.map((line) => [line.msg, line.curl, line.status, line.routeId])).toEqual([
			["request curl", "curl -X 'GET' 'http://localhost/users'", 200, "GET /users"],
		])
	})
})

describe("curlLogger(): skip", () => {
	// v0: 1f8d04636f
	// v0: 7892131328
	it("runs before any formatting: a skipped request costs no redaction and no body read", async () => {
		const redactHeader = vi.fn((_name: string, value: string) => value)
		const a = app({ redactHeader, skip: ({ path, status }) => path === "/users" && status === 200 })
		await a.fetch(new Request("http://app.test/users", { headers: { "x-a": "1" } }), {})
		expect([a.logged.length, redactHeader.mock.calls.length]).toEqual([0, 0])
	})
})

describe("curlLogger(): never breaks the request", () => {
	// v0: 61992b4149
	it("a throwing redact hook: the answer stands, and the failure is logged", async () => {
		const a = app({
			log: undefined,
			redactHeader: () => {
				throw new Error("redact bug")
			},
		})
		const res = await a.fetch(new Request("http://app.test/users", { headers: { "x-a": "1" } }), {})
		expect([res.status, a.lines.map((line) => line.msg)]).toEqual([200, ["curlLogger failed"]])
	})

	// v0: b94d7ccde5
	// v0: 9966690ec9
	it("a throw below it is the boundary's 500; no rejection floats", async () => {
		const floating = vi.fn()
		process.on("unhandledRejection", floating)
		const a = honey<{}>()
		a.use(curlLogger({ body: true, log: () => {} }))
			.use(
				createMiddleware(() => {
					throw new Error("downstream")
				}),
			)
			.post("/x")
			.handler((ctx) => ctx.res.text("ok", "x"))
		const res = await a.fetch(
			new Request("http://app.test/x", { body: "{}", headers: { "content-type": "application/json" }, method: "POST" }),
			{},
		)
		await new Promise((resolve) => setTimeout(resolve, 10))
		process.off("unhandledRejection", floating)
		expect([res.status, floating.mock.calls.length]).toEqual([500, 0])
	})

	// v0: 54bb071eda
	// v0: ee2ab1f762
	it("a URL that does not parse (a malformed Host on Node) is logged without its query", async () => {
		const a = app()
		const request = new Request("http://app.test/users?token=t")
		Object.defineProperty(request, "url", { value: "http://bad host/users?token=t" })
		const res = await a.fetch(request, {})
		expect([res.status, a.logged[0]?.curl]).toEqual([200, "curl -X 'GET' 'http://bad host/users'"])
	})
})

describe("curlLogger(): a later reader still gets the whole body", () => {
	// v0: 3ebebd9f3b
	// v0: efc1b0fa61
	// v0: 51c3ae9846
	it("on the Node bridge: the handler reads the body the logger also logged", async () => {
		const a = app({ body: true })
		const server = serve(a, { env: {}, hostname: "127.0.0.1", port: 0 })
		await new Promise((resolve) => server.once("listening", resolve))
		const { port } = server.address() as AddressInfo
		try {
			const res = await fetch(`http://127.0.0.1:${port}/users`, {
				body: '{"name":"ada"}',
				headers: { "content-type": "application/json" },
				method: "POST",
			})
			expect([res.status, await res.text(), a.logged[0]?.bodyIncluded]).toEqual([200, '{"name":"ada"}', true])
		} finally {
			await server.shutdown(0)
		}
	})

	it("in process too", async () => {
		const a = app({ body: true })
		const res = await a.fetch(
			new Request("http://app.test/users", {
				body: "hello",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect([await res.text(), a.logged[0]?.curl.endsWith("--data-raw 'hello' 'http://app.test/users'")]).toEqual([
			"hello",
			true,
		])
	})
})
