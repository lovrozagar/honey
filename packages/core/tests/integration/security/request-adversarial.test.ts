/**
 * The adversarial suite's hostile-request cases (F1): concurrent requests that would expose shared
 * state, cookie names and values built to inject a header or an attribute, CRLF in a request
 * header, a target ten thousand characters long, a thousand-key query, and NUL in a path or a
 * query. Each is a failing input first and the property that answers it second; the mutation
 * harness reruns this directory with each guard disabled.
 */
import { resolve as resolvePath } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolvePath(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolvePath(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { honey } = (await import(
	resolvePath(REPO, "packages/core/src/routing/app.ts")
)) as typeof import("../../../src/routing/app.ts")

const get = (target: string) => new Request(`http://app.test${target}`)

describe("v1 adversarial: concurrent requests share no state", () => {
	// v0: bc90bcafb2
	it("fifty requests in flight at once, each awaiting a random delay, each answer its own query", async () => {
		const app = honey<{}>()
		app.get("/test").handler(async (ctx) => {
			const id = ctx.search.id
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 5))
			return ctx.res.json("ok", { id, still: ctx.search.id })
		})
		const answers = await Promise.all(
			Array.from({ length: 50 }, async (_, i) => (await app.fetch(get(`/test?id=${i}`), {})).json()),
		)
		expect(answers).toEqual(Array.from({ length: 50 }, (_, i) => ({ id: String(i), still: String(i) })))
	})
})

/** A cookie value built to close the pair, add attributes and start a header. */
const VALUE = "x; Path=/admin; HttpOnly\r\nX-Injected: evil=1"

describe("v1 adversarial: a cookie cannot inject a header or an attribute", () => {
	// v0: 35e097a957
	// v0: 49832705ee
	it.each(["invalid;name", "a=b", "x\r\nSet-Cookie: admin=1", "x\nX-Injected: evil"])(
		"a name like %j is refused: a 500, and no Set-Cookie goes out",
		async (name) => {
			const app = honey<{}>().logger(false)
			app.get("/t").handler((ctx) => ctx.res.json("ok", {}, { cookies: { [name]: { value: "bad" } } }))
			const res = await app.fetch(get("/t"), {})
			expect([res.status, res.headers.getSetCookie(), res.headers.get("x-injected")]).toEqual([500, [], null])
		},
	)

	it("a value carrying ;, = and CRLF is encoded into the one cookie, never a second attribute or header", async () => {
		const app = honey<{}>()
		app.get("/t").handler((ctx) => ctx.res.json("ok", {}, { cookies: { session: { value: VALUE } } }))
		const res = await app.fetch(get("/t"), {})
		const [cookie] = res.headers.getSetCookie()
		expect([
			res.status,
			res.headers.getSetCookie().length,
			res.headers.get("x-injected"),
			/[;\r\n]/.test(cookie?.split("; ")[0] ?? ";"),
		]).toEqual([200, 1, null, false])
		/* the one name=value pair carries the whole value, encoded: it decodes back to exactly what was set */
		expect(decodeURIComponent((cookie ?? "").split("; ")[0]?.slice("session=".length) ?? "")).toBe(VALUE)
	})
})

describe("v1 adversarial: CRLF in a request header", () => {
	// v0: fd49bf70c9
	it.each(["application/json\r\nX-Injected: evil", "a\nb", "a\rb"])(
		"a header value like %j never becomes a request: the platform refuses it",
		(value) => {
			expect(() => new Request("http://app.test/t", { headers: { "content-type": value }, method: "POST" })).toThrow()
		},
	)
})

describe("v1 adversarial: oversized and NUL-carrying targets", () => {
	// v0: 4c3927a6af
	it("a 10 000-character path misses a literal route cleanly, and a wildcard captures it whole", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))
		app.get("/deep/*rest").handler((ctx) => ctx.res.json("ok", { length: ctx.params.rest.length }))
		const long = "a".repeat(10_000)
		const [missed, caught] = [await app.fetch(get(`/test/${long}`), {}), await app.fetch(get(`/deep/${long}`), {})]
		expect([missed.status, caught.status, await caught.json()]).toEqual([404, 200, { length: 10_000 }])
	})

	// v0: 0f174c7aaf
	it("a thousand-key query is read whole", async () => {
		const app = honey<{}>()
		app
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", { keys: Object.keys(ctx.search).length, last: ctx.search.k999 }))
		const query = Array.from({ length: 1000 }, (_, i) => `k${i}=v${i}`).join("&")
		expect(await (await app.fetch(get(`/test?${query}`), {})).json()).toEqual({ keys: 1000, last: "v999" })
	})

	// v0: 7e60bd3b38
	it("NUL in a path never reaches the literal route, and a param receives it untruncated", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "literal"))
		app.get("/files/:name").handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))
		const [literal, param] = [await app.fetch(get("/test%00evil"), {}), await app.fetch(get("/files/a%00b.txt"), {})]
		expect([literal.status, param.status, await param.json()]).toEqual([404, 200, { name: "a\u0000b.txt" }])
	})

	// v0: 393e8c6507
	it("NUL in a query value is kept, never a truncation", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))
		const res = await app.fetch(get("/test?q=hello%00world"), {})
		expect([res.status, await res.json()]).toEqual([200, { q: "hello\u0000world" }])
	})
})
