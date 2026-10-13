import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { prettyJson } from "../../../src/pretty-json.ts"

function makeApp(opts?: Parameters<typeof prettyJson>[0]) {
	const app = honey<{}>().use(prettyJson(opts))
	app.get("/data").handler((ctx) => ctx.res.json("ok", { items: ["a", "b"], total: 2 }))
	app.get("/text").handler((ctx) => ctx.res.text("ok", "plain text"))
	return app
}

describe("pretty-json middleware", () => {
	it("?pretty → indented JSON output", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/data?pretty"), {})
		const text = await res.text()
		expect(text).toContain("\n")
		expect(text).toBe(JSON.stringify({ items: ["a", "b"], total: 2 }, null, 2))
	})

	it("no ?pretty → untouched response (passthrough)", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/data"), {})
		const text = await res.text()
		expect(text).not.toContain("\n")
		expect(text).toBe(JSON.stringify({ items: ["a", "b"], total: 2 }))
	})

	it("custom query param name (?format)", async () => {
		const app = makeApp({ query: "format" })
		const res = await app.fetch(new Request("http://localhost/data?format"), {})
		const text = await res.text()
		expect(text).toContain("\n")
		expect(text).toBe(JSON.stringify({ items: ["a", "b"], total: 2 }, null, 2))
	})

	it("custom space value (4)", async () => {
		const app = makeApp({ space: 4 })
		const res = await app.fetch(new Request("http://localhost/data?pretty"), {})
		const text = await res.text()
		expect(text).toBe(JSON.stringify({ items: ["a", "b"], total: 2 }, null, 4))
	})

	it("non-JSON response → passthrough (no crash)", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/text?pretty"), {})
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toBe("plain text")
	})

	it("preserves response status", async () => {
		const app = honey<{}>().use(prettyJson())
		app.get("/created").handler((ctx) => ctx.res.json("created", { id: 1 }))
		const res = await app.fetch(new Request("http://localhost/created?pretty"), {})
		expect(res.status).toBe(201)
		const text = await res.text()
		expect(text).toContain("\n")
	})

	it("preserves response headers", async () => {
		const app = honey<{}>().use(prettyJson())
		app.get("/h").handler((ctx) => ctx.res.json("ok", { x: 1 }, { headers: { "x-custom": "yes" } }))
		const res = await app.fetch(new Request("http://localhost/h?pretty"), {})
		expect(res.headers.get("x-custom")).toBe("yes")
	})
})

describe("prettyJson — trigger and bodies", () => {
	const make = () => {
		const app = honey<{}>().use(prettyJson())
		app.get("/d").handler((ctx) => ctx.res.json("ok", { a: 1 }))
		app.get("/empty").handler(() => new Response("", { headers: { "content-type": "application/json" } }))
		app
			.get("/bad")
			.handler(() => new Response("{oops", { headers: { "content-length": "5", "content-type": "application/json" } }))
		return app
	}

	it("triggers only on a parameter with exactly that name", async () => {
		const app = make()
		expect(await (await app.fetch(new Request("http://x/d?pretty"), {})).text()).toContain("\n")
		expect(await (await app.fetch(new Request("http://x/d?pretty=1"), {})).text()).toContain("\n")
		expect(await (await app.fetch(new Request("http://x/d?notpretty=1"), {})).text()).toBe('{"a":1}')
		expect(await (await app.fetch(new Request("http://x/d?q=pretty"), {})).text()).toBe('{"a":1}')
	})

	it("passes an empty or invalid JSON body through instead of a 500", async () => {
		const app = make()
		const empty = await app.fetch(new Request("http://x/empty?pretty"), {})
		expect(empty.status).toBe(200)
		const bad = await app.fetch(new Request("http://x/bad?pretty"), {})
		expect(bad.status).toBe(200)
		expect(await bad.text()).toBe("{oops")
	})
})
