import { describe, expect, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { type Honey, honey } from "./app.ts"
import { createSettings, defaultErrorFormatter, normalizeStripPrefix } from "./settings.ts"

/** Status and body of one GET through `app`. */
async function get(app: Honey<{}>, path: string): Promise<[number, string]> {
	const res = await app.fetch(new Request(`http://localhost${path}`), {})
	return [res.status, await res.text()]
}

/** An app that answers `path` with `body`, after `configure`. */
function serving(configure: (app: Honey<{}>) => Honey<{}>, path: string, body = "ok"): Honey<{}> {
	const app = configure(honey<{}>())
	app.get(path).handler((ctx) => ctx.res.text("ok", body))
	return app
}

const schema = {
	"~standard": { validate: (value: unknown) => ({ value }), vendor: "t", version: 1 },
} satisfies StandardSchemaLike

describe("settings defaults and normalization", () => {
	it("a fresh app ignores trailing slashes, rejects encoded slashes and formats with the identity", () => {
		const s = createSettings()
		expect(s).toMatchObject({
			encodedSlashes: "reject",
			errorFactory: null,
			stripPrefix: null,
			trailingSlash: "ignore",
		})
		expect(s.errorFormatter).toBe(defaultErrorFormatter)
		const shape = { a: 1 }
		expect(defaultErrorFormatter(new HoneyError({ errorKey: "x", status: "gone" }), shape)).toBe(shape)
	})

	it("normalizeStripPrefix gives a leading slash, drops trailing ones, and null for none", () => {
		expect(normalizeStripPrefix("api//")).toBe("/api")
		expect(normalizeStripPrefix("/")).toBeNull()
		expect(normalizeStripPrefix("")).toBeNull()
	})
})

describe("settings setters apply to the whole app", () => {
	it("trailingSlash strip and enforce redirect with 308, keeping the query; ignore serves both", async () => {
		const strip = serving((a) => a.trailingSlash("strip"), "/a")
		const res = await strip.fetch(new Request("http://localhost/a/?q=1"), {})
		expect([res.status, res.headers.get("location")]).toEqual([308, "/a?q=1"])
		const enforce = serving((a) => a.trailingSlash("enforce"), "/a")
		expect((await enforce.fetch(new Request("http://localhost/a"), {})).headers.get("location")).toBe("/a/")
		expect(
			(
				await get(
					serving((a) => a.trailingSlash("ignore"), "/a"),
					"/a/",
				)
			)[0],
		).toBe(200)
		expect(
			(
				await get(
					serving((a) => a.trailingSlash("strip"), "/"),
					"/",
				)
			)[0],
		).toBe(200)
	})

	it("encodedSlashes allow keeps an encoded slash inside a param", async () => {
		const app = honey<{}>().encodedSlashes("allow")
		app.get("/repos/:id").handler((ctx) => ctx.res.text("ok", ctx.params.id))
		expect(await get(app, "/repos/group%2Fproject")).toEqual([200, "group/project"])
	})
})

describe("settings setters: handles and formatters", () => {
	it("a setter on a derived handle reaches the root", async () => {
		const root = honey<{}>()
		root.basePath("/v1").stripPrefix("/api")
		root.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		expect(await get(root, "/api/x")).toEqual([200, "x"])
	})

	it("the error formatters take a function or a schema with a mapper", async () => {
		const app = honey<{}>()
			.defaultErrorFormatter((_e, shape) => ({ ...shape, plain: true }))
			.customErrorFormatter((_e, data) => ({ ...data, custom: true }))
		app.get("/std").handler(() => {
			throw new HoneyError({ errorKey: "gone", status: "gone" })
		})
		app.get("/data").handler(() => {
			throw new HoneyError({ data: { d: 1 }, errorKey: "x", status: "conflict" })
		})
		expect(JSON.parse((await get(app, "/std"))[1])).toMatchObject({ error_key: "gone", plain: true })
		expect(JSON.parse((await get(app, "/data"))[1])).toEqual({ custom: true, d: 1 })
		const mapped = honey<{}>()
			.defaultErrorFormatter(schema, (e) => ({ code: e.errorKey }))
			.customErrorFormatter(schema, (e, data) => ({ code: e.errorKey, ...data }))
		mapped.get("/std").handler(() => {
			throw new HoneyError({ errorKey: "gone", status: "gone" })
		})
		mapped.get("/data").handler(() => {
			throw new HoneyError({ data: { d: 1 }, errorKey: "x", status: "conflict" })
		})
		expect(JSON.parse((await get(mapped, "/std"))[1])).toEqual({ code: "gone" })
		expect(JSON.parse((await get(mapped, "/data"))[1])).toEqual({ code: "x", d: 1 })
	})
})
