import { describe, expect, it } from "vitest"
import { z } from "zod"
import { HoneyError, honey } from "../../../src/index.ts"
import { HoneyOutHeaders } from "../../../src/honey-response.ts"
import { issuesToFieldErrors } from "../../../src/validation.ts"

const PROTO_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]

describe("request-keyed objects have no prototype", () => {
	it("ctx.search and ctx.searchAll treat prototype names as plain keys", async () => {
		const app = honey<{}>()
		app.get("/q").handler((ctx) =>
			ctx.res.json("ok", {
				all: PROTO_KEYS.map((k) => ctx.searchAll[k] ?? null),
				first: PROTO_KEYS.map((k) => ctx.search[k] ?? null),
				missing: ctx.search["nope"] ?? null,
			}),
		)
		const query = PROTO_KEYS.map((k) => `${k}=v-${k}&${k}=w`).join("&")
		const res = await app.fetch(new Request(`http://localhost/q?${query}`), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { all: string[][]; first: string[]; missing: null }
		expect(body.first).toEqual(PROTO_KEYS.map((k) => `v-${k}`))
		expect(body.all).toEqual(PROTO_KEYS.map((k) => [`v-${k}`, "w"]))
		expect(body.missing).toBeNull()
	})

	it("an unknown search key is undefined, not an Object.prototype member", async () => {
		const app = honey<{}>()
		app.get("/q").handler((ctx) => ctx.res.json("ok", { type: typeof ctx.search["constructor"] }))
		const res = await app.fetch(new Request("http://localhost/q"), {})
		expect(await res.json()).toEqual({ type: "undefined" })
	})

	it("ctx.headers is a null-prototype view", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) => ctx.res.json("ok", { type: typeof ctx.headers["constructor"] }))
		expect(await (await app.fetch(new Request("http://localhost/h"), {})).json()).toEqual({ type: "undefined" })
	})

	it("errorI18n with a prototype-named query still translates", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { de: { nope: "Nein" } },
			resolveLocale: ({ search }) => search["lang"] ?? "de",
		})
		app.get("/e").handler(() => {
			throw new HoneyError({ errorKey: "nope", status: "bad_request" })
		})
		const res = await app.fetch(new Request("http://localhost/e?constructor=1&__proto__=x&toString=y"), {})
		expect(res.status).toBe(400)
		expect(((await res.json()) as { message: string }).message).toBe("Nein")
	})

	it("validated search: a repeated __proto__ cannot replace the prototype; constructor is just a value", async () => {
		const app = honey<{}>()
		app
			.get("/v")
			.input({ search: z.record(z.string(), z.union([z.string(), z.array(z.string())])) })
			.handler((ctx) => {
				const search = ctx.input.search as Record<string, unknown>
				return ctx.res.json("ok", {
					constructor: search["constructor"],
					proto: Object.getPrototypeOf(search) === Object.prototype || Object.getPrototypeOf(search) === null,
				})
			})
		const res = await app.fetch(new Request("http://localhost/v?__proto__=a&__proto__=b&constructor=x"), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ constructor: "x", proto: true })
	})

	it("a validation issue on a prototype-named field is a 400, not a 500", async () => {
		const app = honey<{}>()
		app
			.post("/r")
			.input({ json: z.record(z.string(), z.number()) })
			.handler((ctx) => ctx.res.json("ok", {}))
		const res = await app.fetch(
			new Request("http://localhost/r", {
				body: JSON.stringify({ hasOwnProperty: "x", toString: "x" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const body = (await res.json()) as { fields: Record<string, unknown> }
		expect(Object.keys(body.fields).sort()).toEqual(["hasOwnProperty", "toString"])
	})

	it("issuesToFieldErrors keys fields without a prototype", () => {
		const fields = issuesToFieldErrors([{ code: "invalid_type", message: "m", meta: {}, path: ["toString"] }], "json")
		expect(Object.getPrototypeOf(fields)).toBeNull()
		expect(fields["toString"]).toHaveLength(1)
	})

	it("HoneyOutHeaders only reads own keys", () => {
		const headers = new HoneyOutHeaders({ "content-type": "text/plain" })
		expect(headers.get("constructor")).toBeNull()
		expect(headers.has("toString")).toBe(false)
		expect(headers.get("content-type")).toBe("text/plain")
	})
})

describe("error i18n never mutates the thrown error", () => {
	it("a shared error instance is translated per request, per locale", async () => {
		const shared = new HoneyError({ errorKey: "gone", status: "not_found" })
		const app = honey<{}>()
		app.errorI18n({
			errors: { de: { gone: "Weg" }, fr: { gone: "Parti" } },
			resolveLocale: ({ search }) => search["lang"] ?? "de",
		})
		app.get("/g").handler(() => {
			throw shared
		})
		const de = (await (await app.fetch(new Request("http://localhost/g?lang=de"), {})).json()) as { message: string }
		const fr = (await (await app.fetch(new Request("http://localhost/g?lang=fr"), {})).json()) as { message: string }
		expect(de.message).toBe("Weg")
		expect(fr.message).toBe("Parti")
		expect(shared.message).toBe("gone")
	})

	it("field-name translation copies field errors and ignores prototype names", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: { de: { email: "E-Mail" } },
			resolveLocale: () => "de",
		})
		app
			.post("/u")
			.input({ json: z.object({ constructor: z.string(), email: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", {}))
		const res = await app.fetch(
			new Request("http://localhost/u", {
				body: "{}",
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		const body = (await res.json()) as { fields: Record<string, { path: string }[]> }
		expect(body.fields["email"][0].path).toBe("E-Mail")
		expect(body.fields["constructor"][0].path).toBe("json.constructor")
	})

	it("the template is formatted for the resolved locale", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { de: { limit: "Höchstens {max, number} Einträge" } },
			resolveLocale: () => "de",
		})
		app.get("/l").handler(() => {
			throw new HoneyError({ errorKey: "limit", status: "bad_request", vars: { max: 1234567 } })
		})
		const body = (await (await app.fetch(new Request("http://localhost/l"), {})).json()) as { message: string }
		expect(body.message).toBe("Höchstens 1.234.567 Einträge")
	})
})
