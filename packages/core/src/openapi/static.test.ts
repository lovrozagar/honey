import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { SERVED } from "../routing/register.ts"
import { SILENT } from "../telemetry/logger.ts"
import { generateOpenApi } from "./generate.ts"
import { generateManifest } from "./manifest.ts"
import { scalar } from "./scalar.ts"
import { serveStaticOpenApi } from "./static.ts"
import { swagger } from "./swagger.ts"

type App = { fetch(request: Request, env: object): Promise<Response> | Response }

/** What a refused `docs` value is shown to pass instead. */
const MAP_FIX =
	'import { scalar } from "@lovrozagar/honey/openapi/scalar" (or swagger from "@lovrozagar/honey/openapi/swagger") and pass docs: { "/docs": scalar }'

const DOC = { info: { title: "Prebuilt", version: "2.0.0" }, openapi: "3.1.0", paths: {} }
const YAML = 'openapi: "3.1.0"\ninfo:\n  title: Prebuilt\n'

const get = (app: App, path: string, env: object = {}, init?: RequestInit) =>
	app.fetch(new Request(`http://x${path}`, init), env)
/** An app with one route of its own, so a document route is never the only one. */
function host() {
	const app = honey<{}>().logger(SILENT)
	app.get("/health").handler((c) => c.res.text("ok", "ok"))
	return app
}

/** An `env` whose `binding` serves `files`, counting every call. */
function assets(files: Record<string, { body?: string; etag?: string; status?: number }>, binding = "ASSETS") {
	const urls: string[] = []
	const fetched = (input: URL | string) => {
		const url = new URL(String(input))
		urls.push(url.toString())
		const file = files[url.pathname]
		if (file === undefined) return new Response("not found", { status: 404 })
		const headers = file.etag === undefined ? undefined : { etag: file.etag }
		return new Response(file.body ?? "", { headers, status: file.status ?? 200 })
	}
	return { env: { [binding]: { fetch: fetched } }, urls }
}

let server: Server
let base = ""
const hits: string[] = []
let flaky = 0
beforeAll(async () => {
	server = createServer((req, res) => {
		hits.push(req.url ?? "")
		if (req.url === "/doc.json") {
			res.writeHead(200, { etag: '"upstream"' })
			res.end(JSON.stringify(DOC))
		} else if (req.url === "/weak.json") {
			res.writeHead(200, { etag: 'W/"weak"' })
			res.end(JSON.stringify(DOC))
		} else if (req.url === "/flaky.json" && ++flaky === 1) {
			res.writeHead(503)
			res.end("later")
		} else if (req.url === "/flaky.json") {
			res.writeHead(200)
			res.end(JSON.stringify(DOC))
		} else {
			res.writeHead(500)
			res.end("boom")
		}
	})
	await new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", resolve))
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)
afterAll(async () => {
	await new Promise<void>((resolve) => void server.close(() => resolve()))
})

describe("serveStaticOpenApi: every source it serves a document from", () => {
	it("serves an inline object, an inline string and a loader's string or Response, each as its own content-type", async () => {
		const inline = serveStaticOpenApi(host(), { json: { inline: DOC }, yaml: { inline: YAML } })
		const text = serveStaticOpenApi(host(), { json: { inline: JSON.stringify(DOC) } })
		const loaded = serveStaticOpenApi(host(), {
			json: () => JSON.stringify(DOC),
			yaml: () => new Response(YAML),
		})
		const json = await get(inline, "/openapi.json")
		const yaml = await get(inline, "/openapi.yaml")
		expect([
			await json.json(),
			json.headers.get("content-type"),
			[await yaml.text(), yaml.headers.get("content-type")],
			await (await get(text, "/openapi.json")).json(),
			await (await get(loaded, "/openapi.json")).json(),
			await (await get(loaded, "/openapi.yml")).text(),
		]).toEqual([DOC, "application/json; charset=utf-8", [YAML, "application/yaml; charset=utf-8"], DOC, DOC, YAML])
	})
})

describe("serveStaticOpenApi: every source it serves a document from", () => {
	it("serves an asset binding's file, asked for on the request's own origin, and reads a loader's env and request", async () => {
		const { env, urls } = assets({ "/openapi.json": { body: JSON.stringify(DOC) } })
		const app = serveStaticOpenApi(host(), { json: { asset: "/openapi.json" } })
		const seen: string[] = []
		const loader = serveStaticOpenApi(host(), {
			json: (ctx) => {
				seen.push(String((ctx.env as { REGION?: string }).REGION), new URL(ctx.req.url).pathname)
				return JSON.stringify(DOC)
			},
		})
		const served = await get(app, "/openapi.json", env)
		expect([await served.json(), urls, (await get(loader, "/openapi.json", { REGION: "eu" })).status, seen]).toEqual([
			DOC,
			["http://x/openapi.json"],
			200,
			["eu", "/openapi.json"],
		])
	})
})

describe("serveStaticOpenApi: every source it serves a document from", () => {
	it("takes the binding's name from `binding`, and the asset's path relative to the request's origin", async () => {
		const { env, urls } = assets({ "/spec/openapi.json": { body: JSON.stringify(DOC) } }, "SPEC")
		const app = serveStaticOpenApi(host(), { json: { asset: "/spec/openapi.json", binding: "SPEC" } })
		expect([(await get(app, "/openapi.json", env)).status, urls]).toEqual([200, ["http://x/spec/openapi.json"]])
	})
})

describe("serveStaticOpenApi: a document fetched over the network", () => {
	it("serves what the URL answered, with the request init it was given and the upstream's strong ETag", async () => {
		const app = serveStaticOpenApi(host(), {
			json: { init: { headers: { "x-token": "t" } }, url: `${base}/doc.json` },
		})
		const res = await get(app, "/openapi.json")
		expect([res.status, await res.json(), res.headers.get("etag"), res.headers.get("content-type")]).toEqual([
			200,
			DOC,
			'"upstream"',
			"application/json; charset=utf-8",
		])
	}, 60_000)
})

describe("serveStaticOpenApi: a document fetched over the network", () => {
	it("tags a document the upstream validates weakly itself, and answers a non-2xx URL with a 502", async () => {
		const weak = serveStaticOpenApi(host(), { json: { url: `${base}/weak.json` } })
		const broken = serveStaticOpenApi(host(), { json: { url: `${base}/boom.json` } })
		const unreachable = serveStaticOpenApi(host(), { json: { url: "http://127.0.0.1:1/nowhere.json" } })
		const tagged = (await get(weak, "/openapi.json")).headers.get("etag") ?? ""
		const gateway = await get(broken, "/openapi.json")
		const failed = await get(unreachable, "/openapi.json")
		expect([
			tagged !== 'W/"weak"' && /^"[\w-]{22}"$/.test(tagged),
			[gateway.status, ((await gateway.json()) as { error_key: string }).error_key],
			[failed.status, ((await failed.json()) as { error_key: string }).error_key],
		]).toEqual([true, [502, "bad_gateway"], [502, "bad_gateway"]])
	}, 60_000)
})

describe("serveStaticOpenApi: a document fetched over the network", () => {
	it("loads once for a storm of first requests, and retries a load that failed", async () => {
		const app = serveStaticOpenApi(host(), { json: { url: `${base}/doc.json` } })
		const before = hits.length
		const storm = await Promise.all(Array.from({ length: 20 }, () => get(app, "/openapi.json")))
		const once = hits.length - before
		const retried = serveStaticOpenApi(host(), { json: { url: `${base}/flaky.json` } })
		const first = await get(retried, "/openapi.json")
		const second = await get(retried, "/openapi.json")
		expect([once, new Set(storm.map((res) => res.status)), [first.status, second.status], await second.json()]).toEqual(
			[1, new Set([200]), [502, 200], DOC],
		)
	}, 60_000)
})

describe("serveStaticOpenApi: where it mounts", () => {
	it("serves the JSON at the stem, the YAML only when a YAML source is given, and the paths that replace the stem", async () => {
		const plain = serveStaticOpenApi(host(), { json: { inline: DOC } })
		const stemmed = serveStaticOpenApi(host(), { json: { inline: DOC }, path: "/spec", yaml: { inline: YAML } })
		const exact = serveStaticOpenApi(host(), {
			json: { inline: DOC },
			jsonPath: "/v1/openapi/spec",
			yaml: { inline: YAML },
			yamlPath: "/v1/openapi/spec.yaml",
		})
		expect([
			[(await get(plain, "/openapi.json")).status, (await get(plain, "/openapi.yaml")).status],
			[(await get(plain, "/openapi.yml")).status, (await get(stemmed, "/spec.yml")).status],
			(await get(stemmed, "/spec.json")).status,
			[(await get(exact, "/v1/openapi/spec")).status, (await get(exact, "/v1/openapi/spec.yaml")).status],
			[(await get(exact, "/openapi.json")).status, (await get(exact, "/v1/openapi/spec.yml")).status],
		]).toEqual([[200, 404], [404, 200], 200, [200, 200], [404, 404]])
	})
})

describe("serveStaticOpenApi: where it mounts", () => {
	it("mounts under the handle's basePath, and nothing at all with `enabled: false`", async () => {
		const based = host()
		serveStaticOpenApi(based.basePath("/api"), { json: { inline: DOC } })
		const off = serveStaticOpenApi(host(), { enabled: false, json: { inline: DOC }, yaml: { inline: YAML } })
		expect([
			(await get(based, "/api/openapi.json")).status,
			(await get(based, "/openapi.json")).status,
			(await get(off, "/openapi.json")).status,
			(await get(off, "/health")).status,
		]).toEqual([200, 404, 404, 200])
	})
})

describe("serveStaticOpenApi: where it mounts", () => {
	it("mounts all of its routes or, when one path is taken, none of them", async () => {
		const app = host()
		app.get("/openapi.yaml").handler((c) => c.res.text("ok", "mine"))
		expect(() => serveStaticOpenApi(app, { json: { inline: DOC }, yaml: { inline: YAML } })).toThrow(
			"Duplicate route: GET /openapi.yaml",
		)
		const parameterized = host()
		expect(() => serveStaticOpenApi(parameterized, { json: { inline: DOC }, jsonPath: "/:spec" })).toThrow(
			"cannot serve at /:spec: a served path is fixed",
		)
		expect([(await get(app, "/openapi.json")).status, await (await get(app, "/openapi.yaml")).text()]).toEqual([
			404,
			"mine",
		])
	})
})

describe("serveStaticOpenApi: where it mounts", () => {
	it("serves each docs page at its own path, every one pointing at the JSON URL the browser sees", async () => {
		const app = honey<{}>().stripPrefix("/edge")
		serveStaticOpenApi(app.basePath("/v1"), {
			docs: { "/openapi/scalar": scalar, "/openapi/swagger": swagger },
			json: { inline: DOC },
			jsonPath: "/spec",
		})
		const plain = serveStaticOpenApi(host(), { docs: { "/reference": scalar }, json: { inline: DOC } })
		expect([
			await (await get(app, "/edge/v1/openapi/scalar")).text(),
			await (await get(app, "/edge/v1/openapi/swagger")).text(),
			await (await get(plain, "/reference")).text(),
			(await get(plain, "/docs")).status,
		]).toEqual([
			expect.stringContaining('"url":"/edge/v1/spec"'),
			expect.stringContaining('"url":"/edge/v1/spec"'),
			expect.stringContaining('"url":"/openapi.json"'),
			404,
		])
	})

	it("mounts no route when a page's path is taken or given twice", async () => {
		const app = host()
		app.get("/swagger").handler((c) => c.res.text("ok", "mine"))
		expect(() =>
			serveStaticOpenApi(app, { docs: { "/scalar": scalar, "/swagger": swagger }, json: { inline: DOC } }),
		).toThrow("Duplicate route: GET /swagger")
		expect(() => serveStaticOpenApi(host(), { docs: { "/openapi.json": scalar }, json: { inline: DOC } })).toThrow(
			"Duplicate route: GET /openapi.json",
		)
		expect([(await get(app, "/scalar")).status, (await get(app, "/openapi.json")).status]).toEqual([404, 404])
	})
})

describe("serveStaticOpenApi: where it mounts", () => {
	it("refuses a page given without its path, and a name in place of a page, showing the map", () => {
		expect(() =>
			serveStaticOpenApi(host(), {
				// @ts-expect-error docs maps each path to its page
				docs: scalar,
				json: { inline: DOC },
			}),
		).toThrow(new TypeError(`docs maps each path to its page: ${MAP_FIX}`))
		expect(() =>
			serveStaticOpenApi(host(), {
				// @ts-expect-error a page is the page itself, not its name
				docs: { "/reference": "scalar" },
				json: { inline: DOC },
			}),
		).toThrow(new TypeError(`docs at /reference is not a page: ${MAP_FIX}`))
	})
})

describe("serveStaticOpenApi: what it answers with", () => {
	it("sends a strong ETag with no-cache and nosniff, answers a match with an empty 304, and takes a cache-control", async () => {
		const app = serveStaticOpenApi(host(), { json: { inline: DOC }, yaml: { inline: YAML } })
		const cached = serveStaticOpenApi(host(), {
			cacheControl: "public, s-maxage=3600, stale-while-revalidate=86400",
			json: { inline: DOC },
		})
		for (const path of ["/openapi.json", "/openapi.yaml"]) {
			const res = await get(app, path)
			const tag = res.headers.get("etag") ?? ""
			const hit = await get(app, path, {}, { headers: { "if-none-match": tag } })
			expect([
				/^"[\w-]{22}"$/.test(tag),
				res.headers.get("cache-control"),
				res.headers.get("x-content-type-options"),
				[hit.status, await hit.text(), hit.headers.get("etag") === tag],
			]).toEqual([true, "no-cache", "nosniff", [304, "", true]])
		}
		expect((await get(cached, "/openapi.json")).headers.get("cache-control")).toBe(
			"public, s-maxage=3600, stale-while-revalidate=86400",
		)
	})
})

describe("serveStaticOpenApi: what it answers with", () => {
	it("keeps every served route out of the document and the manifest, the caller's own meta under the internal marking", async () => {
		const app = serveStaticOpenApi(host(), {
			docs: { "/docs": scalar },
			json: { inline: DOC },
			meta: { security: [{ bearer: [] }], summary: "The published document" },
			yaml: { inline: YAML },
		})
		const seen: Record<string, unknown>[] = []
		app.use("/openapi.json", async (ctx, next) => {
			seen.push(ctx.meta)
			return next()
		})
		await get(app, "/openapi.json")
		const meta = seen[0] as { [SERVED]?: unknown; internal?: unknown; security?: unknown; summary?: unknown }
		expect([
			Object.keys(generateOpenApi(app, { info: { title: "T", version: "1" } }).paths),
			generateManifest(app).routes.map((route) => route.path),
			[meta.internal, meta[SERVED], meta.security, meta.summary],
		]).toEqual([["/health"], ["/health"], [true, true, [{ bearer: [] }], "The published document"]])
	})
})

describe("serveStaticOpenApi: what it answers with", () => {
	it("answers a failed asset, a binding missing or unable to fetch, and a failing loader with a 500", async () => {
		const causes: string[] = []
		/* the formatter an app sets is where it sees the error itself: the envelope says only that it was a 500 */
		const app = () =>
			honey<{}>()
				.logger(SILENT)
				.defaultErrorFormatter((error, shape) => {
					causes.push(String((error.cause as Error | undefined)?.message))
					return shape
				})
		const unbound = serveStaticOpenApi(app(), { json: { asset: "/openapi.json" } })
		const named = serveStaticOpenApi(app(), { json: { asset: "/openapi.json", binding: "SPEC" } })
		const unfetchable = serveStaticOpenApi(app(), { json: { asset: "/openapi.json" } })
		const absent = serveStaticOpenApi(app(), { json: { asset: "/nowhere.json" } })
		const thrown = serveStaticOpenApi(app(), {
			json: () => {
				throw new Error("no document here")
			},
		})
		const refused = serveStaticOpenApi(app(), { json: () => new Response("nope", { status: 404 }) })
		const { env } = assets({ "/openapi.json": { body: JSON.stringify(DOC) } })
		const statuses = []
		for (const [served, used] of [
			[unbound, {}],
			[named, env],
			[unfetchable, { ASSETS: {} }],
			[absent, env],
			[thrown, {}],
			[refused, {}],
		] as const) {
			const res = await get(served, "/openapi.json", used)
			statuses.push([res.status, ((await res.json()) as { error_key: string }).error_key])
		}
		const envelope = [500, "internal_server_error"]
		expect([statuses, causes]).toEqual([
			[envelope, envelope, envelope, envelope, envelope, envelope],
			[
				expect.stringContaining("no asset binding ASSETS"),
				expect.stringContaining("no asset binding SPEC"),
				expect.stringContaining("no asset binding ASSETS"),
				"asset /nowhere.json answered 404",
				"no document here",
				"the loader answered 404",
			],
		])
	})
})

describe("serveStaticOpenApi: what it answers with", () => {
	it("refuses the options a document source cannot have", () => {
		const app = host()
		expect(() =>
			serveStaticOpenApi(app, {
				json: { inline: DOC },
				// @ts-expect-error a served route is internal; no caller lifts that
				meta: { internal: false },
			}),
		).not.toThrow()
		expect(() =>
			serveStaticOpenApi(host(), {
				json: { inline: DOC },
				// @ts-expect-error security is a scheme list, a name or names
				meta: { security: 1 },
			}),
		).not.toThrow()
		expect(() =>
			serveStaticOpenApi(host(), {
				json: { inline: DOC },
				// @ts-expect-error a YAML document is text: nothing converts an object at runtime
				yaml: { inline: { openapi: "3.1.0" } },
			}),
		).not.toThrow()
	})
})
