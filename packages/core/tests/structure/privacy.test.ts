/**
 * Nothing private is logged (H17): no cookie, credential, query string, request body or handler
 * input reaches a log line. Checked twice: every logger call site in core names none of them, and a
 * request carrying all of them leaves no trace of any in what the app writes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { curlLogger } from "../../src/observability/curl-logger.ts"
import { honey } from "../../src/routing/app.ts"
import { createLogger } from "../../src/telemetry/logger.ts"

const SRC = join(import.meta.dirname, "../../src")

/* what a field object must never name: the raw request and its private parts */
const PRIVATE = /cookie|authorization|search|query|\bbody\b|\binput\b|\.url\b|\bheaders\b|\breq\b/i
const CALL = /\b(?:log|logger|\.log|options\.log|s\.logger)\??\.(?:trace|debug|info|warn|error|fatal)\??\.?\(/g

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return sources(path)
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : []
	})
}

/** The arguments of the call whose `(` is at `open`. */
function argsAt(text: string, open: number): string {
	let depth = 0
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++
		else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i)
	}
	return text.slice(open + 1)
}

/** Every logger call in `text` whose arguments name something private. */
export function privateFields(path: string, text: string): string[] {
	const out: string[] = []
	for (const match of text.matchAll(CALL)) {
		const args = argsAt(text, match.index + match[0].length - 1)
		if (PRIVATE.test(args)) out.push(`${relative(SRC, path)}: ${args.replace(/\s+/g, " ").slice(0, 80)}`)
	}
	return out
}

/**
 * Every log call that spreads a record (`{ ...x }`) hides what it carries from the field scan, so
 * each is named here with what it spreads. One is request detail: curlLogger, H17's sanctioned opt-in
 * exception, whose masking is asserted below rather than assumed.
 */
const SPREADS: Readonly<Record<string, string>> = {
	"errors/on-error.ts": "the request bindings (method, path, routeId, requestId; fields.ts)",
	"observability/curl-logger.ts": "the request as a masked command: the sanctioned request-detail logger",
	"realtime/invoke-user.ts": "a socket's own fields (connId, namespace, route)",
}

/** A logger call that hands over a spread record: what it carries is invisible to the field scan. */
const SPREAD = /^\s*\{\s*\.\.\./

describe("no private field at any log call site", () => {
	it("core's logger calls name no cookie, credential, query, body, input, raw URL or headers", () => {
		const texts = sources(SRC).map((path) => [path, readFileSync(path, "utf8")] as const)
		/* the scan must see the call sites it guards: a pattern that matched none would pass vacuously */
		const seen = texts.reduce((count, [, text]) => count + [...text.matchAll(CALL)].length, 0)
		expect([texts.flatMap(([path, text]) => privateFields(path, text)), seen >= 10]).toEqual([[], true])
	})

	it.each([
		["the raw request URL", "log.info({ url: req.url })", 1],
		["a header bag", "s.logger.error({ headers })", 1],
		["a cookie", "logger.warn({ cookie: c })", 1],
		["the path and route only", 'log.error({ err, path, routeId }, "failed")', 0],
	])("the checker: %s → %i", (_name, text, count) => {
		expect(privateFields(join(SRC, "x.ts"), text)).toHaveLength(count)
	})
})

describe("a request full of secrets leaves none in the log", () => {
	it("cookie, authorization, query and body never appear, whatever is on: request log, an error, ctx.log", async () => {
		const written: string[] = []
		const app = honey<{}>()
			.logger(createLogger({ format: "json", level: "trace", write: (line) => void written.push(line) }))
			.requestLog(true)
		app.post("/orders/:id").handler(async (ctx) => {
			ctx.log.info({ items: 2 }, "creating")
			await ctx.req.text()
			throw new Error("db down")
		})
		const res = await app.fetch(
			new Request("https://app.example.com/orders/7?token=QUERY-SECRET", {
				body: '{"card":"BODY-SECRET"}',
				headers: {
					authorization: "Bearer AUTH-SECRET",
					cookie: "sid=COOKIE-SECRET",
					"x-csrf-token": "CSRF-SECRET",
					"x-session-id": "SESSION-SECRET",
				},
				method: "POST",
			}),
			{},
		)
		await res.text()
		const log = written.join("\n")
		expect([written.length, /SECRET/.test(log), log.includes("/orders/7")]).toEqual([3, false, true])
	})
})

/** A request carrying every kind of secret. */
const secrets = () =>
	new Request("https://app.example.com/login?access_token=QUERY-SECRET&next=home", {
		body: '{"password":"BODY-SECRET"}',
		headers: {
			authorization: "Bearer AUTH-SECRET",
			"content-type": "application/json",
			cookie: "sid=COOKIE-SECRET",
			"x-csrf-token": "CSRF-SECRET",
			"x-session-id": "SESSION-SECRET",
		},
		method: "POST",
	})

describe("the sanctioned request-detail logger masks what it carries", () => {
	it("every call site handing a logger a spread record is named, curlLogger the only request-detail one", () => {
		const spreading = sources(SRC)
			.filter((path) =>
				[...readFileSync(path, "utf8").matchAll(CALL)].some((match) => {
					const text = readFileSync(path, "utf8")
					return SPREAD.test(argsAt(text, match.index + match[0].length - 1))
				}),
			)
			.map((path) => relative(SRC, path))
		expect(spreading).toEqual(Object.keys(SPREADS))
	})

	it("by default no credential, cookie, session, token query or body reaches its line; with body on, only a bounded text body", async () => {
		const written: string[] = []
		const app = honey<{}>().logger(
			createLogger({ format: "json", level: "info", write: (line) => void written.push(line) }),
		)
		const routes = app.use(curlLogger())
		routes.post("/login").handler((ctx) => ctx.res.text("ok", "in"))
		const withBody = honey<{}>().logger(
			createLogger({ format: "json", level: "info", write: (line) => void written.push(line) }),
		)
		withBody
			.use(curlLogger({ body: { maxBytes: 8 } }))
			.post("/login")
			.handler((ctx) => ctx.res.text("ok", "in"))
		await app.fetch(secrets(), {})
		await withBody.fetch(secrets(), {})
		const log = written.join("\n")
		expect([written.length, log.match(/[A-Z]+-SECRET/g), log.includes("next=home")]).toEqual([2, null, true])
	})
})
