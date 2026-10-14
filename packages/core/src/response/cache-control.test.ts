import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { cacheControl, httpDate } from "./cache-control.ts"
import { etag } from "./etag.ts"

const get = (path: string, headers?: Record<string, string>, method = "GET") =>
	new Request(`http://localhost${path}`, { headers, method })

/** The status, the named headers and the body text of an answer. */
async function seen(answer: Response | Promise<Response>, names: string[]): Promise<unknown[]> {
	const res = await answer
	return [res.status, ...names.map((name) => res.headers.get(name)), await res.text()]
}

/** Making cacheControl with `options`, to see it throw. */
const made = (options: Parameters<typeof cacheControl>[0]) => () => cacheControl(options)

const MODIFIED = new Date("2026-03-04T05:06:07.890Z")
const MODIFIED_TEXT = "Wed, 04 Mar 2026 05:06:07 GMT"

describe("httpDate: an HTTP-date, whole seconds", () => {
	it("formats a Date or epoch milliseconds as IMF-fixdate, the milliseconds dropped", () => {
		expect([httpDate(MODIFIED), httpDate(MODIFIED.getTime())]).toEqual([MODIFIED_TEXT, MODIFIED_TEXT])
	})
})

describe("cacheControl: the Cache-Control header", () => {
	it("writes the directives in one fixed order, built once", async () => {
		const header = async (options: Parameters<typeof cacheControl>[0]) => {
			const app = honey<{}>().use(cacheControl(options))
			app.get("/t").handler((ctx) => ctx.res.text("ok", "x"))
			return (await app.fetch(get("/t"), {})).headers.get("cache-control")
		}
		expect([
			await header({ immutable: true, maxAge: 31_536_000, public: true }),
			await header({ maxAge: 0, mustRevalidate: true, private: true }),
			await header({ noStore: true }),
			await header({ maxAge: 60, noCache: true, sMaxAge: 600, staleWhileRevalidate: 30 }),
		]).toEqual([
			"public, max-age=31536000, immutable",
			"private, max-age=0, must-revalidate",
			"no-store",
			"no-cache, max-age=60, s-maxage=600, stale-while-revalidate=30",
		])
	})

	it("refuses a contradiction or a duration that is not a whole number of seconds, when it is made", () => {
		expect(made({ private: true, public: true })).toThrow(TypeError)
		expect(made({ maxAge: -1 })).toThrow(TypeError)
		expect(made({ sMaxAge: 1.5 })).toThrow(TypeError)
		expect(made({ staleWhileRevalidate: Number.NaN })).toThrow(TypeError)
		expect(made({})).toThrow(TypeError)
	})

	it("goes on a GET or HEAD answered 2xx that has none; a handler's own, a POST and an error answer are left alone", async () => {
		const app = honey<{}>()
			.logger(false)
			.use(cacheControl({ maxAge: 60 }))
		app.get("/plain").handler((ctx) => ctx.res.json("ok", {}))
		app.get("/own").handler((ctx) => ctx.res.json("ok", {}, { headers: { "cache-control": "no-store" } }))
		app.post("/plain").handler((ctx) => ctx.res.json("created", {}))
		const names = ["cache-control"]
		expect([
			(await seen(app.fetch(get("/plain"), {}), names))[1],
			(await seen(app.fetch(get("/plain", {}, "HEAD"), {}), names))[1],
			(await seen(app.fetch(get("/own"), {}), names))[1],
			(await seen(app.fetch(get("/plain", {}, "POST"), {}), names))[1],
			(await seen(app.fetch(get("/missing"), {}), names))[1],
		]).toEqual(["max-age=60", "max-age=60", "no-store", null, null])
	})
})

/** An app whose /doc answers `body`, last modified at MODIFIED, set by the handler or by the option. */
function modified(by: "handler" | "option") {
	const app = honey<{}>().use(cacheControl({ lastModified: by === "option" ? () => MODIFIED : undefined, maxAge: 60 }))
	app
		.get("/doc")
		.handler((ctx) =>
			ctx.res.text("ok", "body", by === "handler" ? { headers: { "last-modified": MODIFIED_TEXT } } : undefined),
		)
	app.post("/doc").handler((ctx) => ctx.res.text("ok", "posted"))
	return app
}

describe("cacheControl: Last-Modified and If-Modified-Since", () => {
	it("lastModified sets the header in whole seconds, unless the answer carries its own", async () => {
		const [fromOption, fromHandler] = [modified("option"), modified("handler")]
		expect([
			(await fromOption.fetch(get("/doc"), {})).headers.get("last-modified"),
			(await fromHandler.fetch(get("/doc"), {})).headers.get("last-modified"),
		]).toEqual([MODIFIED_TEXT, MODIFIED_TEXT])
	})

	it("an answer not modified since the date asked is a 304 with its validators and no body", async () => {
		for (const app of [modified("option"), modified("handler")]) {
			const names = ["last-modified", "cache-control"]
			expect([
				await seen(app.fetch(get("/doc", { "if-modified-since": MODIFIED_TEXT }), {}), names),
				await seen(app.fetch(get("/doc", { "if-modified-since": "Thu, 05 Mar 2026 00:00:00 GMT" }), {}), names),
				await seen(app.fetch(get("/doc", { "if-modified-since": MODIFIED_TEXT }, "HEAD"), {}), names),
			]).toEqual([
				[304, MODIFIED_TEXT, "max-age=60", ""],
				[304, MODIFIED_TEXT, "max-age=60", ""],
				[304, MODIFIED_TEXT, "max-age=60", ""],
			])
		}
	})

	it("an answer modified since, an invalid date, a POST and an answer without Last-Modified are answered whole", async () => {
		const app = modified("option")
		const plain = honey<{}>().use(cacheControl({ maxAge: 60 }))
		plain.get("/doc").handler((ctx) => ctx.res.text("ok", "body"))
		const status = async (target: typeof app, header: string, method = "GET") =>
			(await target.fetch(get("/doc", { "if-modified-since": header }, method), {})).status
		expect([
			await status(app, "Tue, 03 Mar 2026 00:00:00 GMT"),
			await status(app, "not a date"),
			await status(app, MODIFIED_TEXT, "POST"),
			await status(plain, MODIFIED_TEXT),
		]).toEqual([200, 200, 200, 200])
	})
})

describe("cacheControl: a stream answer", () => {
	it("a stream answer not modified since is a 304 too, its body cancelled unread", async () => {
		let pulled = 0
		const app = honey<{}>().use(cacheControl({ lastModified: () => MODIFIED, noCache: true }))
		app.get("/file").handler((ctx) =>
			ctx.res.generate(
				(function* () {
					for (;;) yield `${++pulled}`
				})(),
			),
		)
		const answer = await app.fetch(get("/file", { "if-modified-since": MODIFIED_TEXT }), {})
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect([answer.status, answer.body, pulled]).toEqual([304, null, 0])
	})
})

describe("cacheControl with etag: If-None-Match decides (RFC 9110 §13.1.3)", () => {
	it("a request carrying both is judged by If-None-Match alone, whatever If-Modified-Since says", async () => {
		const app = honey<{}>()
			.use(cacheControl({ lastModified: () => MODIFIED, maxAge: 60 }))
			.use(etag())
		app.get("/doc").handler((ctx) => ctx.res.text("ok", "body"))
		const tag = (await app.fetch(get("/doc"), {})).headers.get("etag") ?? ""
		const status = async (headers: Record<string, string>) => (await app.fetch(get("/doc", headers), {})).status
		expect([
			await status({ "if-modified-since": "Tue, 03 Mar 2026 00:00:00 GMT", "if-none-match": tag }),
			await status({ "if-modified-since": MODIFIED_TEXT, "if-none-match": '"other"' }),
			await status({ "if-modified-since": MODIFIED_TEXT }),
		]).toEqual([304, 200, 304])
	})

	it("without etag, If-None-Match still turns If-Modified-Since off", async () => {
		const app = honey<{}>().use(cacheControl({ lastModified: () => MODIFIED, maxAge: 60 }))
		app.get("/doc").handler((ctx) => ctx.res.text("ok", "body"))
		const answer = await app.fetch(get("/doc", { "if-modified-since": MODIFIED_TEXT, "if-none-match": '"x"' }), {})
		expect(answer.status).toBe(200)
	})
})
