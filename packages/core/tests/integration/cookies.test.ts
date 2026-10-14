/**
 * Cookies through the app: ctx.cookies read once from the request, cookies set on an answer as
 * Set-Cookie headers, what an invalid cookie does to the answer, cookies kept on error answers, and
 * a value's trip to the client and back, plain or signed. The codec's own rules are in
 * cookie-codec.test.ts.
 */
import { describe, expect, it } from "vitest"
import { createCookieSigner } from "../../src/context/cookie-sign.ts"
import { type CookieOptions, serializeCookie } from "../../src/context/cookie.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never) => Response | Promise<Response> }

async function send(app: Fetchable, target: string, cookie?: string) {
	const headers: Record<string, string> = cookie === undefined ? {} : { cookie }
	const res = await app.fetch(new Request(`http://localhost${target}`, { headers }), {} as never)
	return { body: (await res.json()) as unknown, setCookie: res.headers.getSetCookie(), status: res.status }
}

/** The name=value pair a client sends back for a Set-Cookie header. */
const sentBack = (setCookie: string) => setCookie.split(";")[0] as string

/** An unknown error's 500 carries a random digest; its operator line carries the same (H17). */
const DIGEST = { digest: expect.stringMatching(/^[0-9a-f]{16}$/) }
const internal = {
	...DIGEST,
	error_key: "internal_server_error",
	fields: {},
	message: "internal_server_error",
	status: 500,
	status_key: "internal_server_error",
	success: false,
}

describe("ctx.cookies", () => {
	// v0: 0d29d15044
	it("is read from the request once, and is the same object on every access", async () => {
		const app = honey<{}>()
		app
			.get("/t")
			.handler((ctx) => ctx.res.json("ok", { same: ctx.cookies === ctx.cookies, session: ctx.cookies.session }))
		expect(await send(app, "/t", "session=abc")).toEqual({
			body: { same: true, session: "abc" },
			setCookie: [],
			status: 200,
		})
	})
})

describe("ctx.cookies: a long header", () => {
	// v0: 84c2d77289
	it("a hundred cookies are all read", async () => {
		const app = honey<{}>()
		app
			.get("/t")
			.handler((ctx) =>
				ctx.res.json("ok", { count: Object.keys(ctx.cookies).length, first: ctx.cookies.c0, last: ctx.cookies.c99 }),
			)
		const cookie = Array.from({ length: 100 }, (_, i) => `c${i}=v${i}`).join("; ")
		expect((await send(app, "/t", cookie)).body).toEqual({ count: 100, first: "v0", last: "v99" })
	})

	// v0: f03ee55186
	// v0: 152af6048e
	// v0: 9269971ab8
	// v0: 9148c1d5fa
	it("keeps spaces and an empty value; nothing but separators is none; a thousand pairs all", async () => {
		const app = honey<{}>()
		app.get("/t").handler((ctx) => ctx.res.json("ok", { count: Object.keys(ctx.cookies).length, ...ctx.cookies }))
		const many = Array.from({ length: 1000 }, (_, i) => `k${i}=v${i}`).join("; ")
		const thousand = (await send(app, "/t", many)).body as Record<string, unknown>
		expect([
			(await send(app, "/t", "msg=hello world; other=test; empty=")).body,
			(await send(app, "/t", ";;;")).body,
			[thousand.count, thousand.k0, thousand.k999],
		]).toEqual([{ count: 3, empty: "", msg: "hello world", other: "test" }, { count: 0 }, [1000, "v0", "v999"]])
	})
})

describe("ctx.cookies: names that shadow Object.prototype", () => {
	it("are read as plain cookies, and nothing else answers to them", async () => {
		const names = ["__proto__", "constructor", "toString", "hasOwnProperty"]
		const app = honey<{}>()
		app
			.get("/t")
			.handler((ctx) =>
				ctx.res.json("ok", { missing: ctx.cookies.valueOf ?? null, values: names.map((n) => ctx.cookies[n] ?? null) }),
			)
		const cookie = names.map((n) => `${n}=v-${n}`).join("; ")
		expect(await send(app, "/t", cookie)).toEqual({
			body: { missing: null, values: names.map((n) => `v-${n}`) },
			setCookie: [],
			status: 200,
		})
	})
})

describe("cookies on the answer", () => {
	// v0: 3a72e25a94
	// v0: 0a2e6e8df9
	// v0: 4eddca8e68
	// v0: df99fd5bfb
	// v0: b5e16f1644
	// v0: 0d85f532d3
	// v0: 8f7e060744
	// v0: d52cc14e31
	it("each cookie becomes its own Set-Cookie header, with its attributes", async () => {
		const app = honey<{}>()
		app.get("/t").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ ok: true },
				{
					cookies: {
						csrf: { sameSite: "strict", value: "csrf-tok" },
						lang: { path: "/", value: "en" },
						session: { httpOnly: true, maxAge: 86_400, secure: true, value: "sess-tok" },
						sid: { domain: "example.com", path: "/app", value: "tok" },
					},
				},
			),
		)
		expect(await send(app, "/t")).toEqual({
			body: { ok: true },
			setCookie: [
				"csrf=csrf-tok; SameSite=Strict",
				"lang=en; Path=/",
				"session=sess-tok; Max-Age=86400; HttpOnly; Secure",
				"sid=tok; Domain=example.com; Path=/app",
			],
			status: 200,
		})
	})
})

describe("cookies and error answers", () => {
	// v0: fabdb78fb9
	// v0: c734f34a75
	// v0: d590069cbb
	// v0: 6d78df0457
	it.each<[number, { body: unknown; setCookie: string[]; status: number }]>([
		[0, { body: {}, setCookie: ["s=x; Max-Age=0"], status: 200 }],
		[Number.NaN, { body: internal, setCookie: [], status: 500 }],
		[Infinity, { body: internal, setCookie: [], status: 500 }],
		[-1, { body: internal, setCookie: [], status: 500 }],
	])("a cookie with Max-Age %d gives %o", async (maxAge, answer) => {
		const app = honey<{}>()
		app.get("/t").handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge, value: "x" } } }))
		expect(await send(app, "/t")).toEqual(answer)
	})

	// v0: cbe0ffcff7
	it("the Set-Cookie of a Response onError answers with goes out with it", async () => {
		const app = honey<{}>().onError(
			() => new Response("{}", { headers: { "set-cookie": "error_tracked=1; Path=/" }, status: 500 }),
		)
		app.get("/t").handler(() => {
			throw new Error("boom")
		})
		const { setCookie, status } = await send(app, "/t")
		expect([status, setCookie]).toEqual([500, ["error_tracked=1; Path=/"]])
	})

	// v0: 4e6984c802
	it("a cookie a middleware adds after next() rides the error answer too", async () => {
		const app = honey<{}>()
		const remember = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.append("set-cookie", serializeCookie("sid", { httpOnly: true, value: "kept" }))
			return res
		})
		app
			.use(remember)
			.get("/fail")
			.handler(() => {
				throw new Error("boom")
			})
		expect(await send(app, "/fail")).toEqual({ body: internal, setCookie: ["sid=kept; HttpOnly"], status: 500 })
	})
})

/** An app that sets `token` from `options` on /set and reports it on /read, through `read`. */
function roundTripApp(options: CookieOptions, read: (raw: string | undefined) => unknown = (raw) => raw) {
	const app = honey<{}>()
	app.get("/set").handler((ctx) => ctx.res.json("ok", {}, { cookies: { token: options } }))
	app.get("/read").handler(async (ctx) => ctx.res.json("ok", { token: await read(ctx.cookies.token) }))
	return app
}

describe("a cookie's trip to the client and back", () => {
	// v0: b45c14884d
	// v0: ad58080518
	it.each(["hello world@123", "value with spaces & symbols!", "🍯 日本語", "a;b,c=d", "%41"])(
		"%j comes back as it was set",
		async (value) => {
			const app = roundTripApp({ httpOnly: true, value })
			const [setCookie] = (await send(app, "/set")).setCookie
			expect(await send(app, "/read", sentBack(setCookie as string))).toEqual({
				body: { token: value },
				setCookie: [],
				status: 200,
			})
		},
	)

	it("a signed value comes back verified; a tampered one, or one checked under another name, is refused", async () => {
		const signer = createCookieSigner(["secret-1"])
		const signed = await signer.sign("u-42", { name: "token" })
		const app = roundTripApp({ value: signed }, async (raw) => (raw ? signer.verify(raw, { name: "token" }) : null))
		const [setCookie] = (await send(app, "/set")).setCookie
		const pair = sentBack(setCookie as string)
		expect((await send(app, "/read", pair)).body).toEqual({ token: "u-42" })
		expect((await send(app, "/read", pair.replace("u-42", "u-43"))).body).toEqual({ token: null })
		expect(await signer.verify(signed, { legacy: false, name: "session" })).toBeNull()
	})
})
