/**
 * Nothing private is logged (H17): no cookie, credential, query string, request body or handler
 * input reaches a log line. Checked twice: every logger call site in core names none of them, and a
 * request carrying all of them leaves no trace of any in what the app writes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
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
				headers: { authorization: "Bearer AUTH-SECRET", cookie: "sid=COOKIE-SECRET" },
				method: "POST",
			}),
			{},
		)
		await res.text()
		const log = written.join("\n")
		expect([written.length, /SECRET/.test(log), log.includes("/orders/7")]).toEqual([3, false, true])
	})
})
