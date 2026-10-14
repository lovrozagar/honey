/**
 * The in-process adversarial suite (F1, 00-rules "Security gate"): hostile inputs driven through
 * `app.fetch`, each a failing input first and the guard that answers it second. Every middleware
 * bit adds its cases; the mutation harness reruns this file with each guard disabled and requires
 * it to go red.
 */
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolve(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* the app under test is v0 until the cutover swap (H21); each bit retargets its cases as v1 lands */
const { honey } = (await import(resolve(REPO, "_v0/src/index.ts"))) as typeof import("../../../../../_v0/src/index.ts")

/* v1, from bit 02 on: imported after the mock, so a mutant reaches every module that uses it */
const v1 = (await import(
	resolve(REPO, "packages/core/src/routing/app.ts")
)) as typeof import("../../../src/routing/app.ts")
const { createMiddleware } = (await import(
	resolve(REPO, "packages/core/src/middleware/middleware.ts")
)) as typeof import("../../../src/middleware/middleware.ts")
const { createCookieSigner } = (await import(
	resolve(REPO, "packages/core/src/context/cookie-sign.ts")
)) as typeof import("../../../src/context/cookie-sign.ts")

function filesApp() {
	return honey()
		.get("/files/:name")
		.handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))
}

async function fetchPath(path: string): Promise<Response> {
	return filesApp().fetch(new Request(`http://app.test${path}`), {})
}

describe("adversarial: scope bypass via path normalization", () => {
	it("serves an ordinary param", async () => {
		const res = await fetchPath("/files/report")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ name: "report" })
	})

	it("rejects an encoded / before it can reach a param", async () => {
		expect((await fetchPath("/files/x%2F..%2Fsecret")).status).toBe(400)
		expect((await fetchPath("/files/x%2f..%2fsecret")).status).toBe(400)
	})

	it("rejects an encoded \\ the same way", async () => {
		expect((await fetchPath("/files/a%5Cb")).status).toBe(400)
	})

	it("resolves dot segments before matching, so they never escape the route", async () => {
		expect((await fetchPath("/files/../admin")).status).toBe(404)
	})
})

/** A sub with a scope on /admin, a wildcard and a catch-all param, mounted under /api. */
function guardedMount() {
	const sub = v1.honey<{}>()
	sub.use(
		"/admin",
		createMiddleware(() => new Response("denied", { status: 401 })),
	)
	sub.get("/admin/secret").handler((ctx) => ctx.res.text("ok", "SECRET"))
	sub.get("/files/*rest").handler((ctx) => ctx.res.text("ok", `file:${ctx.params.rest}`))
	sub.get("/:slug").handler((ctx) => ctx.res.text("ok", `slug:${ctx.params.slug}`))
	return v1.honey<{}>().route("/api", sub)
}

async function answer(
	app: { fetch: (r: Request, env: never) => Response | Promise<Response> },
	target: string,
	init?: RequestInit,
) {
	const res = await app.fetch(new Request(`http://app.test${target}`, init), {} as never)
	return { body: await res.text(), status: res.status }
}

/** A request whose url is the raw target, unresolved, as an adapter that skips URL parsing hands it on. */
function rawRequest(target: string): Request {
	const request = new Request("http://app.test/")
	Object.defineProperty(request, "url", { value: `http://app.test${target}` })
	return request
}

async function answerRaw(target: string) {
	const res = await guardedMount().fetch(rawRequest(target), {})
	return { body: await res.text(), status: res.status }
}

describe("v1 adversarial: a scope inside a mount, reached by another spelling", () => {
	it.each([
		"/api/admin/secret",
		"/api//admin/secret",
		"//api/admin/secret",
		"/api/./admin/secret",
		"/api/x/../admin/secret",
		"/api/../api/admin/secret",
		"/api/files/../admin/secret",
		"/api/files/%2e%2e/admin/secret",
		"/api/files/.%2e/admin/secret",
		"/api/%61dmin/secret",
		"/api/admin/secret/",
	])("%s, sent raw, is denied by the scope", async (target) => {
		expect(await answerRaw(target)).toEqual({ body: "denied", status: 401 })
	})

	it.each([
		"/api/admin%2fsecret",
		"/api/admin%2Fsecret",
		"/api/files/..%2fadmin%2fsecret",
		"/api/files/a%5c..%5cadmin",
		"/api/%2fadmin/secret",
	])("%s, an encoded separator sent raw, is a 400 before any route", async (target) => {
		const { body, status } = await answerRaw(target)
		expect([status, (JSON.parse(body) as { error_key: string }).error_key]).toEqual([400, "bad_request"])
	})

	it("a double-encoded dot segment stays literal inside the wildcard, never decoded twice", async () => {
		expect(await answerRaw("/api/files/%252e%252e/admin/secret")).toEqual({
			body: "file:%2e%2e/admin/secret",
			status: 200,
		})
	})
})

/** A small seeded generator, so a failing fuzz case reproduces. */
function rng(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const HOSTILE = [
	"\r",
	"\n",
	";",
	",",
	"=",
	'"',
	"\\",
	" ",
	"\t",
	"\u0000",
	"%",
	"%0d%0a",
	"é",
	"🍯",
	"Set-Cookie: evil=1",
	"a",
	"Z",
	"9",
	"-",
	".",
]

/** An app that sets the cookie value it is given, and reads the cookie it is sent. */
function cookieEcho() {
	const app = v1.honey<{}>()
	app.get("/set").handler((ctx) => ctx.res.json("ok", {}, { cookies: { f: { value: ctx.search.v ?? "" } } }))
	app
		.get("/read")
		.handler((ctx) => ctx.res.json("ok", { f: ctx.cookies.f ?? null, proto: Object.getPrototypeOf(ctx.cookies) }))
	return app
}

describe("v1 adversarial: cookie codec fuzz", () => {
	it("any value, hostile characters included, is one Set-Cookie line that comes back unchanged", async () => {
		const next = rng(0x5eed)
		const app = cookieEcho()
		for (let i = 0; i < 300; i++) {
			const value = Array.from(
				{ length: 1 + Math.floor(next() * 8) },
				() => HOSTILE[Math.floor(next() * HOSTILE.length)],
			).join("")
			const set = await app.fetch(new Request(`http://app.test/set?v=${encodeURIComponent(value)}`), {})
			const lines = set.headers.getSetCookie()
			expect([set.status, lines.length, /[\r\n]/.test(lines[0] ?? "")], JSON.stringify(value)).toEqual([200, 1, false])
			const pair = (lines[0] as string).split(";")[0] as string
			expect(await answer(app, "/read", { headers: { cookie: pair } })).toEqual({
				body: JSON.stringify({ f: value, proto: null }),
				status: 200,
			})
		}
	})

	it("a header named like Object.prototype members reads as plain cookies and pollutes nothing", async () => {
		const header = "__proto__=x; constructor=y; toString=z; polluted=1"
		const app = v1.honey<{}>()
		app
			.get("/t")
			.handler((ctx) => ctx.res.json("ok", { names: Object.keys(ctx.cookies), toString: ctx.cookies.toString ?? null }))
		expect(await answer(app, "/t", { headers: { cookie: header } })).toEqual({
			body: JSON.stringify({ names: ["__proto__", "constructor", "toString", "polluted"], toString: "z" }),
			status: 200,
		})
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})
})

describe("v1 adversarial: signed-cookie tamper", () => {
	it("only the untouched value under a known secret and its name verifies", async () => {
		const signer = createCookieSigner(["current", "previous"])
		const signed = await signer.sign("u-42", { name: "sid" })
		const rotated = await createCookieSigner(["previous"]).sign("u-42", { name: "sid" })
		const tampered = [
			signed.replace("u-42", "u-43"),
			`${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`,
			signed.slice(0, -3),
			"u-42",
			"u-42.",
			`${signed}.x`,
			await createCookieSigner(["stranger"]).sign("u-42", { name: "sid" }),
			await signer.sign("u-42", { name: "other" }),
		]
		expect(await signer.verify(signed, { legacy: false, name: "sid" })).toBe("u-42")
		expect(await signer.verify(rotated, { legacy: false, name: "sid" })).toBe("u-42")
		for (const value of tampered) expect(await signer.verify(value, { legacy: false, name: "sid" }), value).toBeNull()
	})
})
