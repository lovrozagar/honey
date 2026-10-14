import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { prettyJson } from "./pretty-json.ts"

const DATA = { items: ["a", "b"], total: 2 }

/** An app answering DATA as JSON, the same as text, and a few bodies prettyJson must leave alone. */
function makeApp(options?: Parameters<typeof prettyJson>[0]) {
	const app = honey<{}>().use(prettyJson(options))
	app.get("/data").handler((ctx) => ctx.res.json("ok", DATA, { headers: { "x-custom": "yes" } }))
	app.get("/created").handler((ctx) => ctx.res.json("created", { id: 1 }))
	app
		.get("/problem")
		.handler((ctx) =>
			ctx.res.raw(
				new Response('{"a":1}', { headers: { "content-length": "7", "content-type": "application/problem+json" } }),
			),
		)
	app.get("/text").handler((ctx) => ctx.res.text("ok", "plain text"))
	app
		.get("/bytes")
		.handler((ctx) => ctx.res.binary("ok", new TextEncoder().encode('{"a":1}'), { contentType: "application/json" }))
	app.get("/nothing").handler((ctx) => ctx.res.json("ok", undefined))
	app
		.get("/jsonx")
		.handler((ctx) =>
			ctx.res.raw(new Response('{"a":1}', { headers: { "content-length": "7", "content-type": "application/jsonx" } })),
		)
	app
		.get("/empty")
		.handler((ctx) =>
			ctx.res.raw(new Response("", { headers: { "content-length": "0", "content-type": "application/json" } })),
		)
	app
		.get("/bad")
		.handler((ctx) =>
			ctx.res.raw(new Response("{oops", { headers: { "content-length": "5", "content-type": "application/json" } })),
		)
	app.get("/stream").handler((ctx) =>
		ctx.res.generate(
			(function* () {
				yield '{"a":1}'
			})(),
			{ contentType: "application/json" },
		),
	)
	return app
}

/** The status and body text of `target`. */
async function seen(app: ReturnType<typeof makeApp>, target: string): Promise<[number, string]> {
	const res = await app.fetch(new Request(`http://localhost${target}`), {})
	return [res.status, await res.text()]
}

describe("prettyJson: the trigger", () => {
	// v0: b38764561f
	// v0: 7203eb98be
	// v0: 2bd756bd5c
	it("indents a JSON answer only when the query carries a parameter of exactly that name", async () => {
		const app = makeApp()
		expect([
			await seen(app, "/data?pretty"),
			await seen(app, "/data?pretty=1"),
			await seen(app, "/data"),
			await seen(app, "/data?notpretty=1"),
			await seen(app, "/data?q=pretty"),
		]).toEqual([
			[200, JSON.stringify(DATA, null, 2)],
			[200, JSON.stringify(DATA, null, 2)],
			[200, JSON.stringify(DATA)],
			[200, JSON.stringify(DATA)],
			[200, JSON.stringify(DATA)],
		])
	})

	// v0: fd59a590d5
	// v0: e5d79c3445
	it("takes another parameter name and another indent", async () => {
		expect([
			await seen(makeApp({ query: "format" }), "/data?format"),
			await seen(makeApp({ space: 4 }), "/data?pretty"),
		]).toEqual([
			[200, JSON.stringify(DATA, null, 2)],
			[200, JSON.stringify(DATA, null, 4)],
		])
	})
})

describe("prettyJson: the answer", () => {
	// v0: d98286050c
	// v0: d9c850a487
	it("keeps the status and the headers, and drops a content length the new body no longer has", async () => {
		const app = makeApp()
		const [created, data] = await Promise.all(
			["/created?pretty", "/data?pretty"].map((target) => app.fetch(new Request(`http://localhost${target}`), {})),
		)
		expect([
			[created.status, await created.text()],
			[data.headers.get("x-custom"), data.headers.get("content-type"), data.headers.get("content-length")],
		]).toEqual([
			[201, JSON.stringify({ id: 1 }, null, 2)],
			["yes", "application/json", null],
		])
	})

	it("reads JSON by the parsed media type: a +json suffix is JSON, a type that only starts like it is not", async () => {
		const app = makeApp()
		expect([
			await seen(app, "/problem?pretty"),
			await seen(app, "/bytes?pretty"),
			await seen(app, "/jsonx?pretty"),
		]).toEqual([
			[200, JSON.stringify({ a: 1 }, null, 2)],
			[200, JSON.stringify({ a: 1 }, null, 2)],
			[200, '{"a":1}'],
		])
	})

	// v0: 714aa07ba3
	// v0: 139ad39433
	it("passes through untouched: a text answer, an empty or invalid JSON body, a stream", async () => {
		const app = makeApp()
		expect([
			await seen(app, "/text?pretty"),
			await seen(app, "/empty?pretty"),
			await seen(app, "/nothing?pretty"),
			await seen(app, "/bad?pretty"),
			await seen(app, "/stream?pretty"),
		]).toEqual([
			[200, "plain text"],
			[200, ""],
			[200, ""],
			[200, "{oops"],
			[200, '{"a":1}'],
		])
	})
})
