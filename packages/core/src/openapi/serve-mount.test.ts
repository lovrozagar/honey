import { describe, expect, it } from "vitest"
import { cors } from "../middleware/cors.ts"
import { honey } from "../routing/app.ts"
import { serveManifest, serveOpenApi } from "./serve.ts"

type Doc = { info: Record<string, unknown>; paths: Record<string, Record<string, Record<string, unknown>>> }
type App = { fetch(request: Request, env: object): Promise<Response> | Response }

const get = (app: App, path: string, init?: RequestInit) => app.fetch(new Request(`http://x${path}`, init), {})
const json = async (app: App, path: string) => (await (await get(app, path)).json()) as Doc
const text = async (app: App, path: string) => (await get(app, path)).text()
const preflight = (path: string) =>
	new Request(`http://x${path}`, {
		headers: { "access-control-request-method": "GET", origin: "http://o" },
		method: "OPTIONS",
	})

/** Health and the users routes. */
function users() {
	const app = honey<{}>()
	app.get("/health").handler((c) => c.res.text("ok", "ok"))
	app.get("/users").handler((c) => c.res.json("ok", []))
	app.get("/users/:id").handler((c) => c.res.json("ok", {}))
	return app
}

/** A call serving `app`'s document, `more` options over a title and version. */
const serving =
	(app: object, more: object = {}) =>
	() =>
		serveOpenApi(app, { title: "T", version: "1", ...more })

describe("serveOpenApi: mounting", () => {
	// v0: ee4a70af47
	it("mounts nothing when disabled", async () => {
		const app = serveManifest(serveOpenApi(users(), { docs: "scalar", enabled: false, title: "T", version: "1" }), {
			enabled: false,
		})
		const statuses = await Promise.all(
			["/openapi.json", "/openapi.yaml", "/docs", "/manifest.json"].map(async (p) => (await get(app, p)).status),
		)
		expect(statuses).toEqual([404, 404, 404, 404])
	})

	// v0: a995ac2b2d
	it("is never shadowed by a root /:slug or /*rest route", async () => {
		for (const pattern of ["/:slug", "/*rest"]) {
			const app = honey<{}>()
			app.get(pattern).handler((c) => c.res.text("ok", "user"))
			serveOpenApi(app, { docs: "scalar", title: "T", version: "1" })
			expect([
				(await json(app, "/openapi.json")).info.title,
				(await text(app, "/docs")).includes("scalar"),
				await text(app, "/other"),
			]).toEqual(["T", true, "user"])
		}
	})
})

describe("serveOpenApi: a taken path", () => {
	// v0: 8fe682d4f3
	// v0: 20ef9ca598
	// v0: 744ccc2c54
	// v0: 6fd89b27e9
	it("refuses a path a route already owns, in either order, and then mounts nothing of that call", async () => {
		const owned = honey<{}>()
		owned.get("/openapi.json").handler((c) => c.res.text("ok", "mine"))
		const all = honey<{}>()
		all.all("/openapi.yaml").handler((c) => c.res.text("ok", "mine"))
		const twice = serveOpenApi(users(), { docs: "scalar", title: "First", version: "1" })
		const docs = honey<{}>()
		docs.get("/docs").handler((c) => c.res.text("ok", "user-docs"))
		const refused: [() => unknown, string][] = [
			[serving(owned), "Duplicate route: GET /openapi.json"],
			[serving(twice), "Duplicate route: GET /openapi.json"],
			[serving(twice, { docs: "scalar", path: "/other" }), "Duplicate route: GET /docs"],
			[serving(docs, { docs: "scalar", docsPath: "/docs" }), "Duplicate route: GET /docs"],
			[serving(honey<{}>(), { docs: "scalar", docsPath: "/openapi.yml" }), "Duplicate route: GET /openapi.yml"],
			[serving(honey<{}>(), { docs: "scalar", docsPath: "/:page" }), "cannot serve at /:page: a served path is fixed"],
			[
				() =>
					(serving(honey<{}>())() as App & { get(path: string): { handler(fn: unknown): unknown } })
						.get("/openapi.json")
						.handler(() => null),
				"Duplicate route: GET /openapi.json",
			],
		]
		for (const [call, message] of refused) expect(call).toThrow(message)
		expect(serving(all)).not.toThrow()
		expect([
			(await json(twice, "/openapi.json")).info.title,
			(await get(twice, "/other.json")).status,
			(await get(docs, "/openapi.json")).status,
		]).toEqual(["First", 404, 404])
	})
})

describe("serveOpenApi: one document per call", () => {
	// v0: 024cb0334e
	// v0: e850ba3c5f
	it("serves each call's own document, profile and cache, its YAML and its docs page pointing at it", async () => {
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({ meta: { tenant: "x-secret" }, profiles: { public: { exclude: ["x-secret"] } } })
		app
			.get("/a")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.text("ok", "ok"))
		serveOpenApi(app, { docs: "scalar", path: "/internal/openapi", title: "Internal", version: "1" })
		serveOpenApi(app, {
			docs: "swagger",
			docsPath: "/public-docs",
			path: "/openapi",
			profile: "public",
			title: "Public",
			version: "1",
		})
		const pub = await json(app, "/openapi.json")
		const internal = await json(app, "/internal/openapi.json")
		expect([
			[internal.info.title, internal.paths["/a"]?.get?.["x-secret"]],
			[pub.info.title, pub.paths["/a"]?.get?.["x-secret"]],
			(await text(app, "/openapi.yaml")).includes("x-secret"),
			(await text(app, "/docs")).includes('"url":"/internal/openapi.json"'),
			(await text(app, "/public-docs")).includes('"url":"/openapi.json"'),
		]).toEqual([["Internal", "orgId"], ["Public", undefined], false, true, true])
	})

	// v0: 5b651bbe77
	// v0: c0a77667df
	it("runs the handle's middleware, so a CORS preflight on the document and docs page answers 204", async () => {
		const app = honey<{}>()
		serveOpenApi(app.use(cors({ origin: "*" })), { docs: "scalar", title: "T", version: "1" })
		const statuses = await Promise.all(
			["/openapi.json", "/docs"].map(async (p) => (await app.fetch(preflight(p), {})).status),
		)
		expect(statuses).toEqual([204, 204])
	})
})
