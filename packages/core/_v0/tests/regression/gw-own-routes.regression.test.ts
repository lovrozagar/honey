/**
 * Regression guard for GW-OWN-ROUTES (docs/regression-matrix/ws1-3.md) and the WS1 gateway
 * `/:slug` finding. A `codegen.mergeTree` gateway that registers routes of its own, next to the
 * root-wildcard catch-all its downstream routes delegate to — anyrow's gateway shape. Runs the
 * real generation path (`generateAndWrite`) over a downstream-only `routes.gen.ts`, the file
 * such a gateway already has committed, then serves the regenerated app.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { generateRouteTreeFromRouteTree } from "../../src/codegen.ts"
import { honey, mergeTree } from "../../src/index.ts"
import { generateAndWrite, resolveHoneyConfig } from "../../src/plugin.ts"

const ROOT = resolve(import.meta.dirname, "../../.tmp-gw-own-routes")

const USERS = [
	'import { honey } from "@lovrozagar/honey"',
	"export const users = honey()",
	'users.get("/users/list").meta({ summary: "List users" }).handler((c) => c.res.json("ok", {}))',
	'users.get("/users/:id").handler((c) => c.res.json("ok", {}))',
	"",
].join("\n")

const MERGE = [
	'import { mergeTree } from "@lovrozagar/honey"',
	'import { users } from "./users.ts"',
	'export const tree = mergeTree([users.toRouteTree(), { worker: "users" }])',
	"",
].join("\n")

function gatewaySource(extra = ""): string {
	return [
		'import { honey } from "@lovrozagar/honey"',
		'import { routeTree } from "./_gen/routes.gen.ts"',
		"export const app = honey().routeTree(routeTree)",
		'app.get("/health").handler((c) => c.res.json("ok", { ok: true }))',
		'app.get("/:slug").handler((c) => c.res.json("ok", { slug: c.params.slug }))',
		'app.get("/nl/c/:delivery/:url").handler((c) => c.res.json("ok", c.params))',
		'app.get("/v1/openapi/spec").handler((c) => c.res.json("ok", { spec: true }))',
		extra,
		'app.all("/*").handler((c) => c.res.json("ok", { pattern: c.routePattern, worker: (c.meta as { worker?: string }).worker ?? null }))',
		"",
	].join("\n")
}

function seed(gateway: string): void {
	rmSync(ROOT, { force: true, recursive: true })
	mkdirSync(join(ROOT, "src/_gen"), { recursive: true })
	writeFileSync(join(ROOT, "src/users.ts"), USERS)
	writeFileSync(join(ROOT, "src/route-tree.ts"), MERGE)
	writeFileSync(join(ROOT, "src/app.ts"), gateway)
	/* what the gateway has committed: a tree of the downstream routes alone */
	const users = honey()
	users.get("/users/list").handler((c) => c.res.json("ok", {}))
	users.get("/users/:id").handler((c) => c.res.json("ok", {}))
	writeFileSync(
		join(ROOT, "src/_gen/routes.gen.ts"),
		generateRouteTreeFromRouteTree(mergeTree([users.toRouteTree(), { worker: "users" }])),
	)
}

const config = resolveHoneyConfig({
	app: "src/app.ts",
	codegen: {
		mergeTree: "src/route-tree.ts",
		openApi: { title: "Gateway", version: "1.0.0" },
		tree: true,
	},
})

type Fetchable = { fetch(r: Request, e?: object): Response | Promise<Response> }

async function get(app: Fetchable, path: string): Promise<{ body: unknown; status: number }> {
	const res = await app.fetch(new Request(`http://x${path}`), {})
	return { body: await res.json(), status: res.status }
}

describe("GW-OWN-ROUTES", () => {
	let app: Fetchable
	let spec: { paths: Record<string, unknown> }

	beforeAll(async () => {
		seed(gatewaySource())
		await generateAndWrite(config, ROOT)
		spec = JSON.parse(readFileSync(join(ROOT, "src/_gen/openapi.gen.json"), "utf-8")) as typeof spec
		app = ((await import(join(ROOT, "src/app.ts"))) as { app: Fetchable }).app
	}, 60_000)

	afterAll(() => {
		rmSync(ROOT, { force: true, recursive: true })
	})

	// regression: GW-OWN-ROUTES
	it("GW-OWN-ROUTES: a merged gateway serves its own routes next to the delegated downstream routes", async () => {
		expect(await get(app, "/health")).toEqual({ body: { ok: true }, status: 200 })
		expect(await get(app, "/nl/c/d1/aHR0cHM")).toEqual({ body: { delivery: "d1", url: "aHR0cHM" }, status: 200 })
		expect(await get(app, "/v1/openapi/spec")).toEqual({ body: { spec: true }, status: 200 })
		expect(await get(app, "/users/7")).toEqual({ body: { pattern: "/users/:id", worker: "users" }, status: 200 })
		expect((await get(app, "/a/b/c")).status).toBe(404)
	})

	// regression: M gateway fallthrough with a root /:slug
	it("M-gateway-slug: a downstream route reaches the catch-all with its own meta despite a root /:slug", async () => {
		expect(await get(app, "/users/list")).toEqual({ body: { pattern: "/users/list", worker: "users" }, status: 200 })
		expect(await get(app, "/about")).toEqual({ body: { slug: "about" }, status: 200 })
	})

	it("GW-OWN-ROUTES: the generated document lists own and downstream routes", () => {
		expect(Object.keys(spec.paths)).toEqual(
			expect.arrayContaining(["/health", "/{slug}", "/nl/c/{delivery}/{url}", "/users/list", "/users/{id}"]),
		)
	})

	it("GW-OWN-ROUTES: an own route that is also a downstream route fails generation by name", async () => {
		seed(gatewaySource('app.get("/users/list").handler((c) => c.res.json("ok", {}))'))
		await expect(generateAndWrite(config, ROOT)).rejects.toThrow("GET /users/list")
	}, 60_000)
})
