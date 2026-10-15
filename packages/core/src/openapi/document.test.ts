import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../routing/app.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "Test API", version: "1.0" }

function app() {
	const a = honey<{}>()
	a.get("/health").handler((c) => c.res.text("ok", "ok"))
	a.get("/users").handler((c) => c.res.json("ok", []))
	a.post("/users")
		.input({ json: z.object({ name: z.string() }) })
		.handler((c) => c.res.json("created", {}))
	a.get("/users/:id").handler((c) => c.res.json("ok", {}))
	return a
}

/** Register GET `path` on `target`, answering an object with one `name` key. */
const register = (target: ReturnType<typeof honey<{}>>, [path, name]: [string, string]) =>
	target
		.get(path)
		.output({ "application/json": { ok: z.object({ [name]: z.string() }) } })
		.handler((c) => c.res.json("ok", { [name]: "x" } as never))

describe("the document: OpenAPI 3.1, assembled", () => {
	// v0: 9eecdff3f3
	// v0: f14c9e8f32

	it("is 3.1.0 with the info it was given and a path item per route, its methods inside", () => {
		const doc = generateOpenApi(app(), { info: INFO })
		expect([doc.openapi, doc.info, Object.keys(doc.paths), Object.keys(doc.paths["/users"] ?? {})]).toEqual([
			"3.1.0",
			INFO,
			["/health", "/users", "/users/{id}"],
			["get", "post"],
		])
	})

	it("keeps only info's own fields, a description among them, and writes the top-level keys in one order", () => {
		const info = { description: "about", extra: 1, title: "T", version: "2" }
		const doc = generateOpenApi(app(), { info: info as never, securitySchemes: { k: { type: "http" } } })
		expect([doc.info, Object.keys(doc)]).toEqual([
			{ description: "about", title: "T", version: "2" },
			["openapi", "info", "paths", "components"],
		])
	})

	// v0: 2f97e7d2b5

	it("leaves components out when there is nothing to put in it", () => {
		const a = honey<{}>()
		a.get("/health").handler((c) => c.res.text("ok", "ok"))
		expect(generateOpenApi(a, { info: INFO })).not.toHaveProperty("components")
	})

	it("passes x-realtime, x-websocket and x-mcp through to the operation", () => {
		const a = honey<{}>()
		a.get("/live")
			.meta({ extensions: { "x-realtime": true }, mcp: true })
			.handler((c) => c.res.text("ok", "ok"))
		a.ws("/socket").handler({ onMessage() {} })
		const doc = generateOpenApi(a, { info: INFO })
		expect([
			doc.paths["/live"]?.get?.["x-realtime"],
			doc.paths["/live"]?.get?.["x-mcp"],
			doc.paths["/socket"]?.get?.["x-websocket"],
		]).toEqual([true, true, true])
	})
})

describe("the document: OpenAPI 3.1, assembled", () => {
	it("is the same bytes on every run and whatever order the routes were registered in", () => {
		const forward = honey<{}>()
		const backward = honey<{}>()
		const routes: [string, string][] = [
			["/b", "B"],
			["/a", "A"],
			["/c", "C"],
		]
		for (const route of routes) register(forward, route)
		for (const route of routes.toReversed()) register(backward, route)
		const once = JSON.stringify(generateOpenApi(forward, { info: INFO }))
		expect(JSON.stringify(generateOpenApi(forward, { info: INFO }))).toBe(once)
		expect(Object.keys(generateOpenApi(backward, { info: INFO }).components?.schemas ?? {})).toEqual(
			Object.keys(generateOpenApi(forward, { info: INFO }).components?.schemas ?? {}),
		)
	})
})

describe("the document: where it is served", () => {
	it("names the stripped prefix as its server, and has no servers without one", () => {
		const prefixed = app()
		prefixed.stripPrefix("/api")
		expect([generateOpenApi(prefixed, { info: INFO }).servers, generateOpenApi(app(), { info: INFO }).servers]).toEqual(
			[[{ url: "/api" }], undefined],
		)
	})
})
