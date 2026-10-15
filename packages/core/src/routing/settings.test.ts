import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { createLogger } from "../telemetry/logger.ts"
import { honey } from "./app.ts"
import { createSettings, defaultErrorFormatter, normalizeStripPrefix } from "./settings.ts"

/** A logger that keeps each JSON line it writes. */
function recordingLogger() {
	const lines: Record<string, unknown>[] = []
	const logger = createLogger({
		format: "json",
		level: "trace",
		write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
	})
	return { lines, logger }
}

describe("settings defaults and normalization", () => {
	it("a fresh app ignores trailing slashes, rejects encoded slashes and formats with the identity", () => {
		const s = createSettings()
		expect(s).toMatchObject({
			encodedSlashes: "reject",
			errorFactory: null,
			stripPrefix: null,
			trailingSlash: "ignore",
		})
		expect(s.errorFormatter).toBe(defaultErrorFormatter)
		const shape = { a: 1 }
		expect(defaultErrorFormatter(new HoneyError({ errorKey: "x", status: "gone" }), shape)).toBe(shape)
	})

	it("normalizeStripPrefix gives a leading slash, drops trailing ones, and null for none", () => {
		expect(normalizeStripPrefix("api//")).toBe("/api")
		expect(normalizeStripPrefix("/")).toBeNull()
		expect(normalizeStripPrefix("")).toBeNull()
	})
})

describe("ctx.log: the request's own logger", () => {
	// v0: 84f3f8dac4
	it("binds method, the path without its query, the route id and the request id when set", async () => {
		const { lines, logger } = recordingLogger()
		const app = honey<{}>().logger(logger)
		app
			.use(createMiddleware((_ctx, next) => next({ requestId: "r-1" })))
			.get("/users/:id")
			.handler((ctx) => {
				ctx.log.info({ found: true }, "loaded")
				return ctx.res.text("ok", "ok")
			})
		app.get("/plain").handler((ctx) => {
			ctx.log.warn("no id")
			return ctx.res.text("ok", "ok")
		})
		await app.fetch(new Request("http://localhost/users/7?token=secret"), {})
		await app.fetch(new Request("http://localhost/plain"), {})
		expect(lines.map(({ time: _time, ...line }) => line)).toEqual([
			{
				found: true,
				level: 30,
				method: "GET",
				msg: "loaded",
				path: "/users/7",
				requestId: "r-1",
				routeId: "GET /users/:id",
			},
			{ level: 40, method: "GET", msg: "no id", path: "/plain", routeId: "GET /plain" },
		])
	})

	it("is one logger per request, built on first use only", async () => {
		const { logger } = recordingLogger()
		const child = vi.spyOn(logger, "child")
		const app = honey<{}>().logger(logger)
		const seen: unknown[] = []
		app.get("/twice").handler((ctx) => {
			seen.push(ctx.log === ctx.log)
			return ctx.res.text("ok", "ok")
		})
		app.get("/never").handler((ctx) => ctx.res.text("ok", "ok"))
		await app.fetch(new Request("http://localhost/twice"), {})
		await app.fetch(new Request("http://localhost/never"), {})
		expect([seen, child.mock.calls.length]).toEqual([[true], 1])
	})
})

describe("ctx.log: a framework field", () => {
	it("`log` cannot be replaced by middleware or context()", async () => {
		expect(() => honey<{}>().context({ log: 1 })).toThrow('context() cannot set reserved key "log"')
		const { lines, logger } = recordingLogger()
		const app = honey<{}>().logger(logger)
		app
			.use(createMiddleware((_ctx, next) => next({ log: "shadow" })))
			.get("/t")
			.handler((ctx) => {
				ctx.log.info("kept")
				return ctx.res.text("ok", "ok")
			})
		await app.fetch(new Request("http://localhost/t"), {})
		expect(lines.map((line) => line.msg)).toEqual(["kept"])
	})
})
