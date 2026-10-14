import { afterEach, describe, expect, it, vi } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { createLogger, defaultsFor, LEVELS, type LogLevel, nodeEnv, SILENT } from "./logger.ts"

/** A json logger at `level` whose lines are parsed into `lines`. */
function recording(level: LogLevel = "trace", base?: Record<string, unknown>) {
	const lines: Record<string, unknown>[] = []
	const log = createLogger({
		base,
		format: "json",
		level,
		write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
	})
	return { lines, log }
}

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

describe("createLogger: the pino line shape", () => {
	// v0: 2afc29228a
	// v0: c43ec4b732
	it("writes one JSON line per call: numeric level, time, msg, and the fields given", () => {
		vi.useFakeTimers({ now: 1_700_000_000_000 })
		const { lines, log } = recording()
		log.info("started")
		log.warn({ port: 3000 }, "listening")
		log.error({ n: 1 })
		expect(lines).toEqual([
			{ level: 30, msg: "started", time: 1_700_000_000_000 },
			{ level: 40, msg: "listening", port: 3000, time: 1_700_000_000_000 },
			{ level: 50, msg: "", n: 1, time: 1_700_000_000_000 },
		])
	})

	// v0: cbd4ea2f5b
	it.each(Object.entries(LEVELS).filter(([level]) => level !== "silent"))("%s writes level %i", (level, value) => {
		const { lines, log } = recording()
		log[level as Exclude<LogLevel, "silent">]("x")
		expect(lines.map((line) => line.level)).toEqual([value])
	})

	it("an error in a field is its name, message, stack and cause, never {}", () => {
		const { lines, log } = recording()
		const cause = new Error("root")
		log.error({ err: new HoneyError({ cause, errorKey: "db", status: "conflict" }) }, "failed")
		expect(lines[0]?.err).toMatchObject({
			cause: { message: "root", name: "Error" },
			errorKey: "db",
			message: "db",
			name: "Error",
			stack: expect.any(String),
		})
	})
})

describe("createLogger: levels and children", () => {
	// v0: b18d9cfd46
	it("below the threshold nothing is built or written: no fields read, no clock read", () => {
		const { lines, log } = recording("warn")
		const fields = {
			get expensive() {
				throw new Error("read below the threshold")
			},
		}
		const now = vi.spyOn(Date, "now")
		log.info(fields, "skipped")
		log.debug("skipped")
		log.trace("skipped")
		expect([lines, now.mock.calls.length, log.level]).toEqual([[], 0, "warn"])
	})

	// v0: d775c6bea2
	it("a child merges its bindings into every line, a grandchild over its parent's, the call's fields over both", () => {
		const { lines, log } = recording("info", { app: "api" })
		const child = log.child({ requestId: "r1", route: "/a" })
		child.child({ route: "/b" }).info({ status: 200 }, "done")
		child.info({ requestId: "override" }, "x")
		expect(lines.map(({ time: _time, ...line }) => line)).toEqual([
			{ app: "api", level: 30, msg: "done", requestId: "r1", route: "/b", status: 200 },
			{ app: "api", level: 30, msg: "x", requestId: "override", route: "/a" },
		])
		expect(child.level).toBe("info")
	})

	it("silent, and the SILENT logger, write nothing and never throw; their children are silent too", () => {
		const write = vi.fn()
		const silent = createLogger({ level: "silent", write })
		for (const log of [silent, silent.child({ a: 1 }), SILENT, SILENT.child({ a: 1 })]) {
			log.fatal("x")
			log.error({ err: new Error("x") }, "x")
			log.info("x")
		}
		expect([write.mock.calls, SILENT.level]).toEqual([[], "silent"])
	})

	// v0: 5d19aab6ff
	it("a sink that throws never escapes the call", () => {
		const log = createLogger({
			level: "info",
			write: () => {
				throw new Error("EPIPE")
			},
		})
		expect(() => log.error("x")).not.toThrow()
	})
})

describe("the default level and format: NODE_ENV, read once, fail-closed", () => {
	it.each([
		["production", { format: "json", level: "info" }],
		["development", { format: "pretty", level: "debug" }],
		["test", { format: "json", level: "silent" }],
		[undefined, { format: "json", level: "info" }],
		["staging", { format: "json", level: "info" }],
	])("NODE_ENV %s → %o", (env, defaults) => {
		expect(defaultsFor(env)).toEqual(defaults)
	})

	it("reads NODE_ENV from process.env when there is one, and undefined where there is none", () => {
		vi.stubEnv("NODE_ENV", "development")
		const here = nodeEnv()
		vi.stubGlobal("process", undefined)
		const workers = nodeEnv()
		vi.unstubAllGlobals()
		expect([here, workers]).toEqual(["development", undefined])
	})

	it("createLogger() takes the defaults of the NODE_ENV it starts under", () => {
		vi.stubEnv("NODE_ENV", "production")
		const production = createLogger({ write: () => {} })
		vi.stubEnv("NODE_ENV", "test")
		const test = createLogger({ write: () => {} })
		expect([production.level, test.level]).toEqual(["info", "silent"])
	})

	it("without a sink, a line goes to stdout where there is one", () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		createLogger({ format: "json", level: "info" }).info("to stdout")
		const [[line]] = write.mock.calls as [[string]]
		write.mockRestore()
		expect(JSON.parse(line)).toMatchObject({ level: 30, msg: "to stdout" })
		expect(line.endsWith("\n")).toBe(true)
	})

	it("where there is no stdout (Workers), a line goes to the console", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		vi.stubGlobal("process", undefined)
		const logger = createLogger({ format: "json", level: "info" })
		vi.unstubAllGlobals()
		logger.info("to the console")
		const [[line]] = log.mock.calls as [[string]]
		log.mockRestore()
		expect(JSON.parse(line)).toMatchObject({ level: 30, msg: "to the console" })
	})
})
