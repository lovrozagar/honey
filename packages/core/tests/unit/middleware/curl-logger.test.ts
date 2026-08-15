import { describe, expect, it } from "vitest"
import { bodyLimit } from "../../../src/body-limit.ts"
import { honey } from "../../../src/index.ts"
import { createLogger } from "../../../src/logger.ts"
import { requestId } from "../../../src/request-id.ts"
import { buildCurlLogData, curlLogger, type CurlLogData } from "../../../src/curl-logger.ts"

describe("buildCurlLogData", () => {
	it("builds curl without body by default", async () => {
		const request = new Request("https://example.com/users?page=1", {
			body: JSON.stringify({ ok: true }),
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			method: "POST",
		})

		const data = await buildCurlLogData(request, {
			redactHeader: (name, value) => (name === "authorization" ? "[redacted]" : value),
		})

		expect(data.bodyIncluded).toBe(false)
		expect(data.bodyOmittedReason).toBe("disabled")
		expect(data.curl).toBe(
			"curl -X POST -H 'authorization: [redacted]' -H 'content-type: application/json' 'https://example.com/users?page=1'",
		)
		expect(await request.text()).toBe("{\"ok\":true}")
	})

	it("includes bounded body for allowed text content types", async () => {
		const request = new Request("https://example.com/users", {
			body: JSON.stringify({ name: "O'Reilly" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})

		const data = await buildCurlLogData(request, {
			body: { maxBytes: 1024 },
		})

		expect(data.bodyIncluded).toBe(true)
		expect(data.bodyOmittedReason).toBeNull()
		expect(data.curl).toBe(
			"curl -X POST -H 'content-type: application/json' --data-raw '{\"name\":\"O'\\''Reilly\"}' 'https://example.com/users'",
		)
	})

	it("omits body when content type is not allowed", async () => {
		const request = new Request("https://example.com/upload", {
			body: "file-bytes",
			headers: { "content-type": "multipart/form-data; boundary=abc" },
			method: "POST",
		})

		const data = await buildCurlLogData(request, {
			body: { maxBytes: 1024 },
		})

		expect(data.bodyIncluded).toBe(false)
		expect(data.bodyOmittedReason).toBe("content-type")
		expect(data.curl).toBe(
			"curl -X POST -H 'content-type: multipart/form-data; boundary=abc' 'https://example.com/upload'",
		)
	})

	it("omits body when content length exceeds the configured cap", async () => {
		const request = new Request("https://example.com/users", {
			body: JSON.stringify({ hello: "world" }),
			headers: {
				"content-length": "17",
				"content-type": "application/json",
			},
			method: "POST",
		})

		const data = await buildCurlLogData(request, {
			body: { maxBytes: 8 },
		})

		expect(data.bodyIncluded).toBe(false)
		expect(data.bodyOmittedReason).toBe("too-large")
		expect(data.curl).toBe(
			"curl -X POST -H 'content-length: 17' -H 'content-type: application/json' 'https://example.com/users'",
		)
	})

	it("redacts query params in the output url", async () => {
		const request = new Request("https://example.com/users?token=secret&page=1")

		const data = await buildCurlLogData(request, {
			redactQueryParam: (name, value) => (name === "token" ? "[redacted]" : value),
		})

		expect(data.curl).toBe("curl -X GET 'https://example.com/users?token=%5Bredacted%5D&page=1'")
	})

	it("omits headers when redactHeader returns null", async () => {
		const request = new Request("https://example.com/users", {
			headers: {
				authorization: "Bearer secret",
				"x-visible": "ok",
			},
		})

		const data = await buildCurlLogData(request, {
			redactHeader: (name, value) => (name === "authorization" ? null : value),
		})

		expect(data.curl).toBe("curl -X GET -H 'x-visible: ok' 'https://example.com/users'")
	})

	it("treats explicit body false the same as the default", async () => {
		const request = new Request("https://example.com/users", {
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})

		const data = await buildCurlLogData(request, { body: false })

		expect(data.bodyIncluded).toBe(false)
		expect(data.bodyOmittedReason).toBe("disabled")
		expect(data.curl).toBe(
			"curl -X POST -H 'content-type: application/json' 'https://example.com/users'",
		)
	})

	it("reports missing body when body logging is enabled but request has no body", async () => {
		const request = new Request("https://example.com/users", {
			headers: { "content-type": "application/json" },
			method: "POST",
		})

		const data = await buildCurlLogData(request, {
			body: { maxBytes: 1024 },
		})

		expect(data.bodyIncluded).toBe(false)
		expect(data.bodyOmittedReason).toBe("missing")
		expect(data.curl).toBe(
			"curl -X POST -H 'content-type: application/json' 'https://example.com/users'",
		)
	})

	it("omits body when a streaming request exceeds maxBytes without content-length", async () => {
		const request = new Request("https://example.com/users", {
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("12345"))
					controller.enqueue(new TextEncoder().encode("67890"))
					controller.close()
				},
			}),
			duplex: "half",
			headers: { "content-type": "application/json" },
			method: "POST",
		} as RequestInit)

		const data = await buildCurlLogData(request, {
			body: { maxBytes: 8 },
		})

		expect(data.bodyIncluded).toBe(false)
		expect(data.bodyOmittedReason).toBe("too-large")
		expect(data.curl).toBe(
			"curl -X POST -H 'content-type: application/json' 'https://example.com/users'",
		)
	})
})

describe("curlLogger middleware", () => {
	it("logs structured curl data", async () => {
		const logged: CurlLogData[] = []
		const app = honey<{}>()
			.use(requestId({ generator: () => "req-123" }))
			.use(curlLogger({ log: (data) => logged.push(data) }))

		app.get("/users").handler((c) => c.res.json("ok", { users: [] }))

		await app.fetch(new Request("http://localhost/users"), {})

		expect(logged).toHaveLength(1)
		expect(logged[0].method).toBe("GET")
		expect(logged[0].path).toBe("/users")
		expect(logged[0].status).toBe(200)
		expect(logged[0].requestId).toBe("req-123")
		expect(logged[0].curl).toBe("curl -X GET 'http://localhost/users'")
	})

	it("supports instance logging", async () => {
		const lines: string[] = []
		const instance = createLogger({ write: (line) => lines.push(line) })

		const app = honey<{}>()
			.use(curlLogger({ instance }))

		app.get("/users").handler((c) => c.res.json("ok", { users: [] }))

		await app.fetch(new Request("http://localhost/users"), {})

		expect(lines).toHaveLength(1)
		const parsed = JSON.parse(lines[0])
		expect(parsed.msg).toBe("request curl")
		expect(parsed.curl).toBe("curl -X GET 'http://localhost/users'")
		expect(parsed.status).toBe(200)
	})

	it("supports skip", async () => {
		const logged: CurlLogData[] = []
		const app = honey<{}>()
			.use(curlLogger({
				log: (data) => logged.push(data),
				skip: (data) => data.path === "/health",
			}))

		app.get("/health").handler((c) => c.res.text("ok", "ok"))
		app.get("/users").handler((c) => c.res.json("ok", { users: [] }))

		await app.fetch(new Request("http://localhost/health"), {})
		await app.fetch(new Request("http://localhost/users"), {})

		expect(logged).toHaveLength(1)
		expect(logged[0].path).toBe("/users")
	})

	it("captures a bounded body when composed after bodyLimit", async () => {
		const logged: CurlLogData[] = []
		const app = honey<{}>()
			.use(
				bodyLimit({
					limits: { "application/json": 64 },
					maxSize: 64,
					trustContentLength: true,
				}),
			)
			.use(
				curlLogger({
					body: { maxBytes: 64 },
					log: (data) => logged.push(data),
				}),
			)

		app.post("/users").handler(async (c) => {
			const body = await c.req.json() as Record<string, unknown>
			return c.res.json("ok", body)
		})

		const response = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ ok: true }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)

		expect(response.status).toBe(200)
		expect(logged).toHaveLength(1)
		expect(logged[0].bodyIncluded).toBe(true)
		expect(logged[0].bodyOmittedReason).toBeNull()
		expect(logged[0].curl).toContain("--data-raw '{\"ok\":true}'")
	})

	it("does not log when bodyLimit rejects the request before curlLogger runs", async () => {
		const logged: CurlLogData[] = []
		const app = honey<{}>()
			.use(
				bodyLimit({
					limits: { "application/json": 4 },
					maxSize: 4,
					trustContentLength: true,
				}),
			)
			.use(
				curlLogger({
					body: { maxBytes: 64 },
					log: (data) => logged.push(data),
				}),
			)

		app.post("/users").handler((c) => c.res.json("ok", { ok: true }))

		const response = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ ok: true }),
				headers: {
					"content-length": "11",
					"content-type": "application/json",
				},
				method: "POST",
			}),
			{},
		)

		expect(response.status).toBe(413)
		expect(logged).toHaveLength(0)
	})
})
