import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createHoneyResponse } from "../response/builder.ts"
import { HoneyRes } from "../response/response.ts"
import { honey } from "../routing/app.ts"
import { bodyKind, headResponse } from "./body-kind.ts"

/** A generator counting how far it was pulled. */
function counter() {
	const pulled = { count: 0 }
	const generator = (function* () {
		for (;;) yield `${++pulled.count}`
	})()
	return { generator, pulled }
}

const head = (path: string) => new Request(`http://localhost${path}`, { method: "HEAD" })

/** The status, the named headers and the body text of an answer. */
async function seen(answer: Response | Promise<Response>, names: string[]): Promise<unknown[]> {
	const res = await answer
	return [res.status, ...names.map((name) => res.headers.get(name)), await res.text()]
}

describe("bodyKind: read from how the answer was built, never from its body", () => {
	// v0: be6ccf73ce
	it("buffered for a body honey built, stream for one it produces, empty for none, on both paths", () => {
		for (const res of [new HoneyRes(), new HoneyRes(true)]) {
			expect([
				bodyKind(res.json("ok", {})),
				bodyKind(res.binary("ok", new Uint8Array(1))),
				bodyKind(res.noContent()),
				bodyKind(res.redirect("/x")),
				bodyKind(res.sse(async () => {}, { headers: { "content-length": "5" } })),
				bodyKind(res.generate(counter().generator)),
				bodyKind(res.stream(async () => {})),
			]).toEqual(["buffered", "buffered", "empty", "empty", "stream", "stream", "stream"])
		}
	})

	it("a response honey did not build is buffered only when it declares its length", () => {
		expect([
			bodyKind(new Response("x", { headers: { "content-length": "1" } })),
			bodyKind(new Response("x", { headers: { "content-length": "1x" } })),
			bodyKind(new Response(new ReadableStream())),
			bodyKind(new Response(null)),
			bodyKind(createHoneyResponse({ headers: {}, status: 200, stream: new ReadableStream() })),
			bodyKind(createHoneyResponse({ headers: {}, status: 200 })),
		]).toEqual(["buffered", "stream", "stream", "empty", "stream", "empty"])
	})
})

describe("headResponse: the answer GET would send, without its body", () => {
	it("keeps the status and headers and states the byte length of a body honey built", async () => {
		for (const res of [new HoneyRes(), new HoneyRes(true)]) {
			const names = ["content-type", "content-length", "x-a"]
			expect([
				await seen(headResponse(res.json("created", { name: "é" }, { headers: { "x-a": "1" } })), names),
				await seen(headResponse(res.text("ok", "x", { headers: { "content-length": "1" } })), names),
				await seen(headResponse(res.noContent()), names),
			]).toEqual([
				[201, "application/json", "13", "1", ""],
				[200, "text/plain; charset=utf-8", "1", null, ""],
				[204, null, null, null, ""],
			])
		}
	})

	it("states the length of bytes too, and answers even when cancelling a foreign body fails", async () => {
		const failing = new Response(
			new ReadableStream({
				cancel() {
					throw new Error("cancel failed")
				},
			}),
		)
		expect([
			await seen(headResponse(new HoneyRes().binary("ok", new Uint8Array(4))), ["content-length"]),
			await seen(headResponse(failing), ["content-length"]),
		]).toEqual([
			[200, "4", ""],
			[200, null, ""],
		])
	})

	it("cancels a stream unread, so its producer never starts", async () => {
		const { generator, pulled } = counter()
		const answer = headResponse(new HoneyRes().generate(generator))
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect([answer.status, answer.body, pulled.count]).toEqual([200, null, 0])
	})
})

describe("HEAD through the app: GET's answer, its body left out", () => {
	// v0: 9fe9b6344c
	// v0: b2242ec048
	// v0: bfa701f82b
	// v0: 56132a5175
	// v0: 0064d66a63
	it("a HEAD route, a GET route found statically or by pattern, an ALL route and a child's GET route", async () => {
		const app = honey<{}>()
		app.head("/head").handler((ctx) => ctx.res.json("ok", { items: [1, 2, 3] }))
		app.get("/static").handler((ctx) => ctx.res.text("ok", "hello"))
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
		app.all("/any").handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))
		app
			.use((_ctx, next) => next())
			.get("/child")
			.handler((ctx) => ctx.res.text("ok", "from the child"))
		const names = ["content-type", "content-length"]
		expect(
			await Promise.all(
				["/head", "/static", "/users/7", "/any", "/child"].map((path) => seen(app.fetch(head(path), {}), names)),
			),
		).toEqual([
			[200, "application/json", "17", ""],
			[200, "text/plain; charset=utf-8", "5", ""],
			[200, "application/json", "10", ""],
			[200, "application/json", "17", ""],
			[200, "text/plain; charset=utf-8", "14", ""],
		])
	})
})

describe("HEAD through the app: what it never does", () => {
	it("an error answer to HEAD carries no body either; a sync answer stays synchronous", async () => {
		const app = honey<{}>().logger(false)
		app.get("/t").handler((ctx) => ctx.res.text("ok", "x"))
		const sync = app.fetch(head("/t"), {})
		expect([sync instanceof Response, await seen(app.fetch(head("/missing"), {}), ["content-type"])]).toEqual([
			true,
			[404, "application/json", ""],
		])
	})

	it("a route producing a stream answers HEAD without starting its producer", async () => {
		const { generator, pulled } = counter()
		const app = honey<{}>()
		app.get("/stream").handler((ctx) => ctx.res.generate(generator))
		const answer = await app.fetch(head("/stream"), {})
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect([answer.status, answer.body, pulled.count]).toEqual([200, null, 0])
	})

	// v0: 4adfce3684
	it("output validation checks the body GET would send before HEAD leaves it out", async () => {
		const app = honey<{}>().logger(false).outputValidation("always")
		const out = { "application/json": { ok: z.object({ id: z.number() }) } }
		app
			.get("/good")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { id: 1 }))
		app
			.get("/bad")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { id: "1" } as never))
		expect([
			await seen(app.fetch(head("/good"), {}), ["content-type"]),
			await seen(app.fetch(head("/bad"), {}), ["content-type"]),
		]).toEqual([
			[200, "application/json", ""],
			[500, "application/json", ""],
		])
	})
})
