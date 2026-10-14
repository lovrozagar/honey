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

describe("stripPrefix basic", () => {
	// v0: 43479ee78c
	it("strips /api prefix from /api/health", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api"), "/health"),
				"/api/health",
			),
		).toEqual([200, "ok"])
	})

	// v0: 2dccaca6b1
	it("exact prefix match becomes root", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api"), "/", "root"),
				"/api",
			),
		).toEqual([200, "root"])
	})

	// v0: 51e66f3a69
	it("no match passes through unchanged", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api"), "/other/health", "other"),
				"/other/health",
			),
		).toEqual([200, "other"])
	})

	// v0: 3e4b3afe6e
	it("non-prefixed path returns 404 for unrelated routes", async () => {
		expect(
			(
				await get(
					serving((a) => a.stripPrefix("/api"), "/users"),
					"/other/users",
				)
			)[0],
		).toBe(404)
	})

	// v0: 5f3fb6b7f4
	it("multi-segment prefix", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api/v1"), "/users", "users"),
				"/api/v1/users",
			),
		).toEqual([200, "users"])
	})
})

describe("stripPrefix boundary safety", () => {
	// v0: e39db192a9
	it("does NOT strip prefix that is substring of segment", async () => {
		expect(
			(
				await get(
					serving((a) => a.stripPrefix("/api"), "/-docs"),
					"/api-docs",
				)
			)[0],
		).toBe(404)
	})

	// v0: fdb922499a
	it("does NOT strip /apiary", async () => {
		expect(
			(
				await get(
					serving((a) => a.stripPrefix("/api"), "/ary"),
					"/apiary",
				)
			)[0],
		).toBe(404)
	})

	// v0: 420f680ef2
	it("strips /api from /api/ correctly", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api"), "/", "root"),
				"/api/",
			),
		).toEqual([200, "root"])
	})
})

describe("stripPrefix normalization", () => {
	// v0: ba99826af9
	it("trailing slash on prefix is normalized", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api/"), "/health"),
				"/api/health",
			),
		).toEqual([200, "ok"])
	})

	// v0: f54a65f0c8
	it("prefix without leading slash gets normalized", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("api"), "/health"),
				"/api/health",
			),
		).toEqual([200, "ok"])
	})

	// v0: c7bf49ba30
	it("empty string prefix is no-op", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix(""), "/health"),
				"/health",
			),
		).toEqual([200, "ok"])
	})

	// v0: 22ee825969
	it("slash-only prefix is no-op", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/"), "/health"),
				"/health",
			),
		).toEqual([200, "ok"])
	})
})

describe("stripPrefix + basePath interaction", () => {
	// v0: 3a91894d74
	it("stripPrefix and basePath compose correctly", async () => {
		const app = honey<{}>().stripPrefix("/gateway").basePath("/v1")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))
		expect(await get(app as unknown as Honey<{}>, "/gateway/v1/users")).toEqual([200, "users"])
	})

	// v0: ca0b63a843
	it("basePath without stripPrefix still works", async () => {
		const app = honey<{}>().basePath("/v1")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))
		expect(await get(app as unknown as Honey<{}>, "/v1/users")).toEqual([200, "users"])
	})
})

describe("stripPrefix double and nested", () => {
	// v0: ab6b7bc42a
	it("double prefix in URL strips only once", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api"), "/api/deep", "deep"),
				"/api/api/deep",
			),
		).toEqual([200, "deep"])
	})

	// v0: 035b84d974
	it("request to root with prefix configured still matches root route", async () => {
		expect(
			await get(
				serving((a) => a.stripPrefix("/api"), "/", "root"),
				"/",
			),
		).toEqual([200, "root"])
	})
})

describe("stripPrefix chaining", () => {
	// v0: 500fe0c015
	it("returns same instance for chaining", () => {
		const app = honey<{}>()
		expect(app.stripPrefix("/api")).toBe(app)
	})
})

describe("stripPrefix encoded paths", () => {
	// v0: 204706c5e1
	it("an encoded slash is rejected, never stripped as a separator", async () => {
		expect(
			(
				await get(
					serving((a) => a.stripPrefix("/api"), "/test"),
					"/api%2Ftest",
				)
			)[0],
		).toBe(400)
	})
})

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
