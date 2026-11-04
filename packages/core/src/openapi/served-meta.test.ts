import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { SILENT } from "../telemetry/logger.ts"
import { scalar } from "./scalar.ts"
import { serveManifest, serveOpenApi } from "./serve.ts"
import { serveStaticOpenApi } from "./static.ts"

type AppMeta = { cacheControl?: string; tenant?: "org" | "project" }

/* An app whose middleware sets cache-control from the route's own meta, as a consumer's gateway does: a served
   route's meta has to reach it, or the header it writes is the default. */
function gateway() {
	const app = honey<{}>().logger(SILENT).metaType<AppMeta>()
	return app.use(async (ctx, next) => {
		const res = await next()
		res.headers.set("x-meta-cache", String((ctx.meta as AppMeta).cacheControl ?? "none"))
		return res
	})
}

const header = async (app: { fetch(r: Request, env: object): Promise<Response> | Response }, path: string) =>
	(await app.fetch(new Request(`http://x${path}`), {})).headers.get("x-meta-cache")

describe("served routes: the handle's own declared meta", () => {
	it("reaches the middleware on every route serveStaticOpenApi mounts, the docs page included", async () => {
		const app = gateway()
		serveStaticOpenApi(app, {
			docs: { "/docs": scalar },
			json: { inline: { openapi: "3.1.0" } },
			meta: { cacheControl: "public, s-maxage=3600" },
			yaml: { inline: "openapi: 3.1.0\n" },
		})
		const seen = await Promise.all(
			["/openapi.json", "/openapi.yaml", "/openapi.yml", "/docs"].map((p) => header(app, p)),
		)
		expect(seen).toEqual(Array.from({ length: 4 }, () => "public, s-maxage=3600"))
	})

	it("reaches it on every route serveOpenApi and serveManifest mount", async () => {
		const app = gateway()
		app.get("/health").handler((c) => c.res.text("ok", "ok"))
		serveOpenApi(app, { docs: { "/docs": scalar }, meta: { cacheControl: "max-age=60" }, title: "T", version: "1" })
		serveManifest(app, { meta: { cacheControl: "max-age=5" } })
		const paths = ["/openapi.json", "/openapi.yaml", "/openapi.yml", "/docs", "/manifest.json"]
		const seen = await Promise.all(paths.map((p) => header(app, p)))
		expect(seen).toEqual(["max-age=60", "max-age=60", "max-age=60", "max-age=60", "max-age=5"])
	})

	it("carries security on the docs page as on the document, for both serve functions", async () => {
		const guarded = () =>
			honey<{}>()
				.logger(SILENT)
				.use(async (ctx, next) => {
					const res = await next()
					res.headers.set("x-meta-cache", JSON.stringify(ctx.meta.security ?? null))
					return res
				})
		const generated = guarded()
		generated.get("/health").handler((c) => c.res.text("ok", "ok"))
		serveOpenApi(generated, { docs: { "/docs": scalar }, meta: { security: ["iaKey"] }, title: "T", version: "1" })
		const prebuilt = guarded()
		serveStaticOpenApi(prebuilt, { docs: { "/docs": scalar }, json: { inline: "{}" }, meta: { security: ["iaKey"] } })
		const seen = await Promise.all(
			[generated, prebuilt].flatMap((app) => ["/openapi.json", "/docs"].map((p) => header(app, p))),
		)
		expect(seen).toEqual(Array.from({ length: 4 }, () => '["iaKey"]'))
	})
})

describe("served routes: the meta type", () => {
	it("types meta by what the handle declares, minus internal", () => {
		const app = gateway()
		const plain = honey<{}>().logger(SILENT)
		const json = { inline: "{}" }
		/* declared keys, with their declared types */
		serveStaticOpenApi(app, { enabled: false, json, meta: { cacheControl: "x", tenant: "org" } })
		serveOpenApi(app, { enabled: false, meta: { tenant: "project" }, title: "T", version: "1" })
		serveManifest(app, { enabled: false, meta: { cacheControl: "x" } })
		expect(() => {
			// @ts-expect-error a key the handle never declared
			serveStaticOpenApi(app, { enabled: false, json, meta: { owner: "x" } })
			// @ts-expect-error a declared key with the wrong type
			serveOpenApi(app, { enabled: false, meta: { tenant: "team" }, title: "T", version: "1" })
			// @ts-expect-error a served route is internal; no caller lifts that
			serveManifest(app, { enabled: false, meta: { internal: false } })
			// @ts-expect-error a handle that declared nothing takes honey's own keys only
			serveStaticOpenApi(plain, { enabled: false, json, meta: { cacheControl: "x" } })
		}).not.toThrow()
	})
})
