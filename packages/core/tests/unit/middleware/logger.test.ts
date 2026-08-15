import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { createLogger, type LogData, logger } from "../../../src/logger.ts"
import { requestId } from "../../../src/request-id.ts"
import { testClient } from "../../../src/testing.ts"

/* ── createLogger ── */

describe("createLogger", () => {
	it("outputs JSON with level, time, msg", () => {
		const lines: string[] = []
		const log = createLogger({ write: (line) => lines.push(line) })

		log.info("hello")

		expect(lines).toHaveLength(1)
		const parsed = JSON.parse(lines[0])
		expect(parsed.level).toBe(30)
		expect(parsed.msg).toBe("hello")
		expect(typeof parsed.time).toBe("number")
	})

	it("accepts obj + msg overload", () => {
		const lines: string[] = []
		const log = createLogger({ write: (line) => lines.push(line) })

		log.error({ err: "timeout", code: 500 }, "db failed")

		const parsed = JSON.parse(lines[0])
		expect(parsed.level).toBe(50)
		expect(parsed.msg).toBe("db failed")
		expect(parsed.err).toBe("timeout")
		expect(parsed.code).toBe(500)
	})

	it("child merges bindings into every log line", () => {
		const lines: string[] = []
		const log = createLogger({ base: { service: "api" }, write: (line) => lines.push(line) })
		const child = log.child({ requestId: "abc" })

		child.info("hello")

		const parsed = JSON.parse(lines[0])
		expect(parsed.service).toBe("api")
		expect(parsed.requestId).toBe("abc")
		expect(parsed.msg).toBe("hello")
	})

	it("no-ops below threshold", () => {
		const lines: string[] = []
		const log = createLogger({ level: "warn", write: (line) => lines.push(line) })

		log.debug("ignored")
		log.info("ignored")
		log.warn("kept")

		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0]).msg).toBe("kept")
	})

	it("all levels output correct numeric values", () => {
		const lines: string[] = []
		const log = createLogger({ level: "trace", write: (line) => lines.push(line) })

		log.trace("t")
		log.debug("d")
		log.info("i")
		log.warn("w")
		log.error("e")
		log.fatal("f")

		const levels = lines.map((l) => JSON.parse(l).level)
		expect(levels).toEqual([10, 20, 30, 40, 50, 60])
	})
})

/* ── logger middleware ── */

describe("logger middleware", () => {
	it("calls log with method, path, status, duration", async () => {
		const logged: LogData[] = []
		const app = honey<{}>()
			.use(logger({ log: (data) => logged.push(data) }))

		app.get("/users").handler((c) => c.res.json("ok", { users: [] }))

		await app.fetch(new Request("http://localhost/users"), {})

		expect(logged).toHaveLength(1)
		expect(logged[0].method).toBe("GET")
		expect(logged[0].path).toBe("/users")
		expect(logged[0].status).toBe(200)
		expect(logged[0].duration).toBeGreaterThanOrEqual(0)
		expect(logged[0].requestId).toBeNull()
	})

	it("includes requestId when requestId middleware is composed", async () => {
		const logged: LogData[] = []
		const app = honey<{}>()
			.use(requestId({ generator: () => "req-123" }))
			.use(logger({ log: (data) => logged.push(data) }))

		app.get("/health").handler((c) => c.res.text("ok", "ok"))

		await app.fetch(new Request("http://localhost/health"), {})

		expect(logged[0].requestId).toBe("req-123")
	})

	it("skip function prevents logging", async () => {
		const logged: LogData[] = []
		const app = honey<{}>()
			.use(logger({
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

	it("strips query string from path", async () => {
		const logged: LogData[] = []
		const app = honey<{}>()
			.use(logger({ log: (data) => logged.push(data) }))

		app.get("/users").handler((c) => c.res.json("ok", { users: [] }))

		await app.fetch(new Request("http://localhost/users?page=1&limit=10"), {})

		expect(logged[0].path).toBe("/users")
	})

	it("with instance: auto-logs incoming and outgoing", async () => {
		const lines: string[] = []
		const instance = createLogger({ write: (line) => lines.push(line) })

		const app = honey<{}>()
			.use(logger({ instance }))

		app.get("/users").handler((c) => c.res.json("ok", { users: [] }))

		await app.fetch(new Request("http://localhost/users"), {})

		expect(lines).toHaveLength(2)

		const incoming = JSON.parse(lines[0])
		expect(incoming.msg).toBe("--> GET /users")
		expect(incoming.level).toBe(30)

		const outgoing = JSON.parse(lines[1])
		expect(outgoing.msg).toBe("<-- GET /users")
		expect(outgoing.status).toBe(200)
		expect(typeof outgoing.duration).toBe("number")
	})

	it("with instance: injects ctx.log as child logger", async () => {
		const lines: string[] = []
		const instance = createLogger({ write: (line) => lines.push(line) })

		const app = honey<{}>()
			.use(requestId({ generator: () => "req-42" }))
			.use(logger({ instance }))

		app.get("/users").handler((c) => {
			(c as Record<string, unknown>).log && ((c as Record<string, unknown>).log as LoggerInstance).info("handler work")
			return c.res.json("ok", { users: [] })
		})

		await app.fetch(new Request("http://localhost/users"), {})

		const handlerLine = lines.find((l) => JSON.parse(l).msg === "handler work")
		expect(handlerLine).toBeDefined()
		const parsed = JSON.parse(handlerLine as string)
		expect(parsed.requestId).toBe("req-42")
		expect(parsed.method).toBe("GET")
		expect(parsed.path).toBe("/users")
	})

	it("does not mutate response", async () => {
		const app = honey<{}>()
			.use(logger())

		app.get("/users").handler((c) => c.res.json("ok", { users: [] }))

		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(200)
		const body = await res.json() as Record<string, unknown>
		expect(body).toEqual({ users: [] })
	})
})
