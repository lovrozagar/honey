import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { readableStream } from "./input.ts"

/** A POST of `body` with `type`, to `path`. */
function post(path: string, body: BodyInit, type?: string): Request {
	return new Request(`http://localhost${path}`, {
		body,
		headers: type === undefined ? {} : { "content-type": type },
		method: "POST",
	})
}

/** The status and JSON body of an answer. */
async function answer(res: Response | Promise<Response>): Promise<[number, unknown]> {
	const r = await res
	return [r.status, await r.json()]
}

/** A schema that must never run: readableStream entries hand the request on unvalidated. */
const untouchable = {
	"~standard": {
		validate: (): never => {
			throw new Error("validate ran")
		},
		vendor: "test",
		version: 1 as const,
	},
}

describe("readableStream(schema)", () => {
	// v0: 26174519c6
	// v0: 7200d6bba4
	// v0: 194cc2eaa7
	it("wraps the schema itself, a fresh wrapper per call", () => {
		const [a, b] = [readableStream(untouchable), readableStream(untouchable)]
		expect([a, a.schema === untouchable, a === b]).toEqual([
			{ _tag: "readableStream", schema: untouchable },
			true,
			false,
		])
	})
})

describe("readableStream(schema) on a route", () => {
	// v0: 73fca81de4
	// v0: 03c3f0ae27
	// v0: bbe8d88382
	// v0: 08c1f73850
	// v0: 8a2417c04a
	// v0: 8012e6f3db
	it("leaves a json or form body unread and unvalidated, for the handler to read", async () => {
		const app = honey<{}>()
		app
			.post("/json")
			.input({ json: readableStream(untouchable) })
			.handler(async (ctx) => ctx.res.json("created", { body: (await ctx.req.json()) as unknown, input: ctx.input }))
		app
			.post("/form")
			.input({ form: readableStream(untouchable) })
			.handler(async (ctx) =>
				ctx.res.json("created", { title: (await ctx.req.formData()).get("title"), input: ctx.input }),
			)
		const form = new FormData()
		form.append("title", "My Document")
		expect([
			await answer(app.fetch(post("/json", '{"any":"data"}', "application/json"), {})),
			await answer(app.fetch(post("/form", form), {})),
		]).toEqual([
			[201, { body: { any: "data" }, input: {} }],
			[201, { input: {}, title: "My Document" }],
		])
	})
})

describe("route .input(): each source validated before the handler", () => {
	// v0: 24f29b0f35
	// v0: ddefd2593b
	// v0: 637582e346
	// v0: 374e29d19f
	// v0: 43e64d3be2
	// v0: 153349f65a
	// v0: f00b1d2273
	// v0: 9b74335def
	// v0: e2f458e75c
	// v0: 23b1eda7b9
	// v0: 9b27914e17
	// v0: 9fe7088757
	it("puts every declared source on ctx.input, as its schema produced it", async () => {
		const app = honey<{}>()
		app
			.post("/orgs/:id")
			.input({
				cookies: z.object({ session: z.string() }),
				headers: z.object({ "x-page": z.coerce.number() }),
				json: z.object({ name: z.string() }),
				params: z.object({ id: z.coerce.number() }),
				search: z.object({ tags: z.array(z.string()) }),
			})
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		const req = new Request("http://localhost/orgs/7?tags=a&tags=b", {
			body: '{"name":"Alice","extra":true}',
			headers: { "content-type": "application/json", cookie: "session=abc", "x-page": "3" },
			method: "POST",
		})
		expect(await answer(app.fetch(req, {}))).toEqual([
			200,
			{
				cookies: { session: "abc" },
				headers: { "x-page": 3 },
				json: { name: "Alice" },
				params: { id: 7 },
				search: { tags: ["a", "b"] },
			},
		])
	})
})

describe("route .input(): the first source that fails answers", () => {
	// v0: a6ba6e548b
	// v0: 060af08fc9
	// v0: e2a123fe48
	// v0: 4343b0bfbc
	// v0: b73d5c0994
	// v0: de57f919fb
	// v0: fef91c9180
	it("stops at the first source that fails: a 400 naming its fields, and the handler never runs", async () => {
		let ran = false
		const app = honey<{}>()
		app
			.post("/api/:version")
			.input({
				json: z.object({ secret: z.string().min(8), toString: z.string() }),
				params: z.object({ version: z.string().startsWith("v") }),
			})
			.handler((ctx) => {
				ran = true
				return ctx.res.json("ok", {})
			})
		const [badParam, badBody] = [
			await app.fetch(post("/api/2", '{"secret":"long enough","toString":"x"}', "application/json"), {}),
			await app.fetch(post("/api/v2", '{"secret":"short","toString":1}', "application/json"), {}),
		]
		const body = (await badBody.json()) as { error_key: string; fields: Record<string, { path: string }[]> }
		expect([badParam.status, badBody.status, body.error_key, Object.keys(body.fields).sort(), ran]).toEqual([
			400,
			400,
			"validation_failed",
			["secret", "toString"],
			false,
		])
		expect(JSON.stringify(body)).not.toContain("min(8)")
	})
})

describe("route .input() beside middleware", () => {
	// v0: 3f39d6e7bc
	// v0: 7f804f0944
	// v0: a4cdf6a778
	// v0: 1d917a8ed4
	// v0: 2bd120b92c
	it("runs after the chain and route middleware, whose additions the handler still sees", async () => {
		const seen: string[] = []
		const app = honey<{}>().context({ region: "eu" })
		app
			.use(createMiddleware((_ctx, next) => (seen.push("chain"), next({ fromMw: true }))))
			.post("/t")
			.use(createMiddleware((_ctx, next) => (seen.push("route"), next({ routeFlag: "yes" }))))
			.input({ json: z.object({ value: z.number() }) })
			.handler((ctx) =>
				ctx.res.json("ok", {
					fromMw: ctx.fromMw,
					region: ctx.region,
					routeFlag: ctx.routeFlag,
					value: ctx.input.json.value,
				}),
			)
		const ok = await answer(app.fetch(post("/t", '{"value":42}', "application/json"), {}))
		const bad = await app.fetch(post("/t", '{"value":"x"}', "application/json"), {})
		expect([ok, bad.status, seen]).toEqual([
			[200, { fromMw: true, region: "eu", routeFlag: "yes", value: 42 }],
			400,
			["chain", "route", "chain", "route"],
		])
	})

	it("ctx.input is the framework's: a middleware's addition never lands, nor can context() set one", async () => {
		const app = honey<{}>()
		app
			.use(createMiddleware((_ctx, next) => next({ input: { json: { admin: true } } } as {})))
			.post("/t")
			.input({ json: z.object({ admin: z.boolean().default(false) }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		expect(await answer(app.fetch(post("/t", "{}", "application/json"), {}))).toEqual([200, { json: { admin: false } }])
		expect(() => honey<{}>().context({ input: {} } as never)).toThrow('context() cannot set reserved key "input"')
	})
})

describe("route .input(): the declared body against the request", () => {
	// v0: 59b536f884
	// v0: 5650cc6637
	// v0: 77abd02bc2
	// v0: 7c465bffa8
	// v0: 9524a2da76
	// v0: 421370fc01
	// v0: 10ae07be0f
	it("answers 415 for a body its media type does not declare, 400 for one the schema refuses", async () => {
		const app = honey<{}>()
		app
			.post("/json")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))
		app
			.post("/form")
			.input({ form: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))
		const statuses = await Promise.all(
			[
				post("/json", "{}"),
				post("/json", "just text", "text/plain"),
				post("/form", "{}", "application/json"),
				post("/json", '{"name":1}', "application/json"),
				post("/json", '{"name":"a"}', "application/json"),
			].map(async (req) => (await app.fetch(req, {})).status),
		)
		expect(statuses).toEqual([415, 415, 415, 400, 201])
	})

	// v0: 2595655908
	// v0: 08e479d91a
	it("refuses a body schema on GET when the route registers; DELETE validates its body", async () => {
		expect(() =>
			honey<{}>()
				.get("/x")
				.input({ json: z.object({}) }),
		).toThrow(/GET \/x declares a json body schema/)
		const app = honey<{}>()
		app
			.delete("/d")
			.input({ json: z.object({ reason: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))
		const [bad, none] = [
			await app.fetch(
				new Request("http://localhost/d", {
					body: '{"reason":1}',
					headers: { "content-type": "application/json" },
					method: "DELETE",
				}),
				{},
			),
			await app.fetch(new Request("http://localhost/d", { method: "DELETE" }), {}),
		]
		expect([bad.status, none.status]).toEqual([400, 415])
	})
})

/** A schema whose validate answers synchronously, or through a promise when `async`. */
function schema(async = false) {
	return {
		"~standard": {
			validate: (value: unknown) => (async ? Promise.resolve({ value }) : { value }),
			vendor: "test",
			version: 1 as const,
		},
	}
}

describe("the sync spine (F6): a request stays synchronous until something has to wait", () => {
	// v0: 6fcfbe9c6f
	it("no .input(), or only sync validators and no body schema: app.fetch returns the Response itself", () => {
		const app = honey<{}>()
		app.get("/plain").handler((ctx) => ctx.res.text("ok", "plain"))
		app
			.get("/u/:id")
			.input({ cookies: schema(), headers: schema(), params: schema(), search: schema() })
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		const plain = app.fetch(new Request("http://localhost/plain"), {})
		const validated = app.fetch(new Request("http://localhost/u/7?q=1", { headers: { cookie: "a=1" } }), {})
		expect([plain instanceof Response, validated instanceof Response, (validated as Response).status]).toEqual([
			true,
			true,
			200,
		])
	})

	it("an async validator, or a body schema, makes only that route's answer a promise", async () => {
		const app = honey<{}>()
		app
			.get("/async")
			.input({ search: schema(true) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		app
			.post("/body")
			.input({ json: schema() })
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		app
			.get("/sync")
			.input({ search: schema() })
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		const answers = [
			app.fetch(new Request("http://localhost/async?q=1"), {}),
			app.fetch(post("/body", "{}", "application/json"), {}),
			app.fetch(new Request("http://localhost/sync?q=1"), {}),
		]
		expect(answers.map((pending) => pending instanceof Promise)).toEqual([true, true, false])
		expect((await Promise.all(answers)).map((res) => res.status)).toEqual([200, 200, 200])
	})

	it("a sync validator's issues answer 400 synchronously too", () => {
		const refusing = {
			"~standard": {
				validate: () => ({ issues: [{ message: "no", path: ["q"] }] }),
				vendor: "test",
				version: 1 as const,
			},
		}
		const app = honey<{}>()
		app
			.get("/s")
			.input({ search: refusing })
			.handler((ctx) => ctx.res.text("ok", "unreached"))
		const refused = app.fetch(new Request("http://localhost/s?q=1"), {})
		expect([refused instanceof Response, (refused as Response).status]).toEqual([true, 400])
	})
})

describe("ws .input(): validated before the upgrade", () => {
	// v0: 23dabab196
	// v0: 54b2848b30
	// v0: 0e1fa478be
	// v0: 89cb956860
	it("a query the schema refuses answers 400 and never upgrades; a valid one upgrades with ctx.input", async () => {
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		const opened: unknown[] = []
		const socket = { close() {}, raw: null, readyState: 1 as const, send() {} }
		const app = honey<{}>().wsAdapter({
			upgrade: (_req, _env, handler) => {
				handler.onOpen?.(undefined, socket)
				return { response: upgraded, socket }
			},
		})
		app
			.ws("/live")
			.input({ search: z.object({ token: z.string().min(1) }) })
			.handler({ onOpen: (ctx) => void opened.push(ctx.input) })
		const headers = { connection: "Upgrade", upgrade: "websocket" }
		const refused = await app.fetch(new Request("http://localhost/live", { headers }), {})
		const accepted = await app.fetch(new Request("http://localhost/live?token=t", { headers }), {})
		expect([refused.status, accepted.status, opened]).toEqual([400, 101, [{ search: { token: "t" } }]])
	})
})

describe("route .input() across validators, methods and encodings", () => {
	// v0: 54cc7400ba
	it.each([
		["zod", z.object({ q: z.string() }), z.object({ "x-tenant": z.string() })],
		["valibot", v.object({ q: v.string() }), v.object({ "x-tenant": v.string() })],
	] as const)("with %s, search and headers validate the request's own values", async (_lib, search, headers) => {
		const app = honey<{}>()
		app
			.get("/search")
			.input({ search })
			.handler((ctx) => ctx.res.json("ok", ctx.input.search))
		app
			.get("/headers")
			.input({ headers })
			.handler((ctx) => ctx.res.json("ok", { tenant: ctx.input.headers["x-tenant"] }))
		const send = (path: string, init?: RequestInit) =>
			answer(app.fetch(new Request(`http://localhost${path}`, init), {}))
		const missing = (await send("/search")) as [number, { fields: Record<string, { path: string }[]> }]
		expect([
			await send("/search?q=hello"),
			[missing[0], missing[1].fields.q?.[0]?.path],
			await send("/headers", { headers: { "x-tenant": "acme" } }),
			(await send("/headers"))[0],
		]).toEqual([[200, { q: "hello" }], [400, "search.q"], [200, { tenant: "acme" }], 400])
	})

	// v0: 8e4802ea09
	// v0: 84b6b52388
	// v0: 0891578be7
	// v0: bce4fc21e6
	it("one path's methods declare their own sources: search on GET, a form on POST, params only on DELETE", async () => {
		const app = honey<{}>()
		app
			.get("/item/:id")
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		app
			.post("/item/:id")
			.input({ form: z.object({ name: z.string(), nickname: z.string().min(3).optional() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))
		app
			.delete("/item/:id")
			.input({ params: z.object({ id: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))
		expect([
			await answer(app.fetch(new Request("http://localhost/item/1?q=x"), {})),
			await answer(app.fetch(post("/item/1", "name=Alice", "application/x-www-form-urlencoded"), {})),
			await answer(app.fetch(new Request("http://localhost/item/42", { method: "DELETE" }), {})),
		]).toEqual([
			[200, { search: { q: "x" } }],
			[201, { form: { name: "Alice" } }],
			[200, { params: { id: "42" } }],
		])
	})
})

describe("route .input(): validated search beside ctx.search", () => {
	// v0: fa37f1b147
	// v0: a9cdacf82e
	it("validated search and ctx.search agree on a repeated key's first value", async () => {
		const app = honey<{}>()
		app
			.get("/s")
			.input({ search: z.object({ role: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { raw: ctx.search.role, validated: ctx.input.search.role }))
		expect(await answer(app.fetch(new Request("http://localhost/s?role=user&role=admin"), {}))).toEqual([
			200,
			{ raw: "user", validated: "user" },
		])
	})
})

describe("route .input() under load and slow validators", () => {
	// v0: 6c2e7eb44a
	// v0: c05eda8bee
	it("50 requests at once each validate their own body: valid ones answer their own value, invalid ones 400", async () => {
		const app = honey<{}>()
		app
			.post("/api")
			.input({ json: z.object({ value: z.number() }) })
			.handler((ctx) => ctx.res.json("created", { doubled: ctx.input.json.value * 2 }))
		const results = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				answer(app.fetch(post("/api", JSON.stringify({ value: i % 5 === 4 ? "nope" : i }), "application/json"), {})),
			),
		)
		expect(results.map(([status, body]) => (status === 201 ? (body as { doubled: number }).doubled : status))).toEqual(
			Array.from({ length: 50 }, (_, i) => (i % 5 === 4 ? 400 : i * 2)),
		)
	})

	// v0: dcad279b5c
	it("an async refinement is awaited before the handler runs", async () => {
		const order: string[] = []
		const slow = z.string().superRefine(async (value, ctx) => {
			await new Promise((resolve) => setTimeout(resolve, 10))
			order.push("refined")
			if (value.length < 1) ctx.addIssue({ code: "custom", message: "too short" })
		})
		const app = honey<{}>()
		app
			.post("/t")
			.input({ json: z.object({ name: slow }) })
			.handler((ctx) => (order.push("handler"), ctx.res.json("ok", { name: ctx.input.json.name })))
		const res = await answer(app.fetch(post("/t", '{"name":"valid"}', "application/json"), {}))
		/* zod's standard validate tries a sync parse first and reruns async, so the refinement may run twice */
		expect([res, order.at(-1), order.slice(0, -1).every((step) => step === "refined")]).toEqual([
			[200, { name: "valid" }],
			"handler",
			true,
		])
	})
})
