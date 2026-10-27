/**
 * The artifacts as text (bit 19 h2): each OpenAPI output built from the same app with only its own filterRoutes
 * (shown the route's meta), securitySchemes and sanitize; the tree's topology holding every route, a websocket's
 * included; the virtual modules' code; and the app imported here sharing this core.
 */
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as codegen from "../../../gen/src/index.ts"
import { honey } from "../routing/app.ts"
import { appSource, type Project, project } from "./__fixtures__/project.ts"
import { artifactsOf, documentOf, prepare, virtualCode } from "./artifacts.ts"
import { type HoneyVitePluginConfig, resolveHoneyConfig } from "./config.ts"
import { sourceOf } from "./source.ts"

/* type extraction (ts-morph) runs for seconds under coverage */
const SLOW = 60_000
const projects: Project[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.done()
})

/** A fresh project of `files`, removed after the leg. */
function fresh(files: Record<string, string> = {}): Project {
	const made = project(files, { link: true })
	projects.push(made)
	return made
}

const SCHEMES = {
	apiKey: { in: "header", name: "Authorization", type: "apiKey" },
	iaKey: { in: "header", name: "x-ia-key", type: "apiKey" },
	jwt: { scheme: "bearer", type: "http" },
} as const

/** An app with a public route (apiKey or jwt), an internal one (iaKey) and a contract one. */
function app() {
	return honey<{}>()
		.get("/public")
		.meta({ public: true, security: ["apiKey", "jwt"] } as never)
		.handler((c) => c.res.text("ok", "p"))
		.get("/internal")
		.meta({ security: "iaKey" } as never)
		.handler((c) => c.res.text("ok", "i"))
		.get("/contract")
		.meta({ contract: true, security: "jwt" } as never)
		.handler((c) => c.res.text("ok", "c"))
}

type Document = {
	components?: { securitySchemes?: Record<string, unknown> }
	paths: Record<string, { get: Record<string, unknown> }>
}
const output = (entry: object) => ({ path: "x.json", title: "T", version: "1", ...entry })

describe("documentOf: each output its own (bit 19 h2)", () => {
	it("filters by the route's meta, declares only its own schemes, and sanitizes only itself", () => {
		const served = app()
		const all = documentOf(served, output({ securitySchemes: SCHEMES }), "off", undefined) as Document
		const contract = documentOf(
			served,
			output({
				filterRoutes: (route: { meta: { contract?: boolean } }) => route.meta.contract === true,
				securitySchemes: { jwt: SCHEMES.jwt },
			}),
			"off",
			undefined,
		) as Document
		const sanitize = { stripSecurityRequirements: ["jwt"], stripSecuritySchemes: ["iaKey"], stripXExtensions: true }
		const published = documentOf(
			served,
			output({
				filterRoutes: (route: { meta: { public?: boolean } }) => route.meta.public === true,
				sanitize,
				securitySchemes: SCHEMES,
			}),
			"off",
			undefined,
		) as Document
		expect([Object.keys(all.paths), Object.keys(contract.paths), Object.keys(published.paths)]).toEqual([
			["/public", "/internal", "/contract"],
			["/contract"],
			["/public"],
		])
		expect(Object.keys(all.components?.securitySchemes ?? {})).toEqual(["apiKey", "iaKey", "jwt"])
		expect(Object.keys(contract.components?.securitySchemes ?? {})).toEqual(["jwt"])
		expect(Object.keys(published.components?.securitySchemes ?? {})).toEqual(["apiKey", "jwt"])
		const keys = (document: Document, path: string) => Object.keys(document.paths[path]?.get ?? {})
		expect([
			keys(all, "/public").some((key) => key.startsWith("x-")),
			keys(published, "/public").some((key) => key.startsWith("x-")),
		]).toEqual([true, false])
		expect([all.paths["/public"]?.get.security, published.paths["/public"]?.get.security]).toEqual([
			[{ apiKey: [] }, { jwt: [] }],
			[{ apiKey: [] }],
		])
	})
})

/** Every artifact of `config` for the project at `dir`, through prepare() then artifactsOf(), with what it reported. */
async function artifacts(config: HoneyVitePluginConfig, dir: string) {
	const reports: string[] = []
	const run = { codegen, report: (line: string) => void reports.push(line), root: dir }
	const resolved = resolveHoneyConfig(config)
	const { rewrite, source } = await prepare(resolved, { ...run, first: true })
	/* a tree to write first is written before any artifact, as generate.ts does */
	const files = rewrite === undefined ? Object.fromEntries(await artifactsOf(resolved, run, source)) : {}
	return { files, reports, rewrite }
}

const WITH_HIDDEN_ADDITION = [
	'\t.get("/hidden")',
	"\t.meta({ internal: true } as never)",
	"\t.use(createMiddleware((_c, next) => next({ hidden: 1 })))",
	'\t.handler((c) => c.res.text("ok", "h"))',
]

describe("artifactsOf (bit 19 h2)", () => {
	// v0: 7d37ebfc5c
	it("writes every route into the tree's topology, a websocket's included", async () => {
		const { dir } = fresh({ "src/app.ts": appSource({ extra: ['\t.ws("/live").handler({})'] }) })
		const { files } = await artifacts({ app: "src/app.ts" }, dir)
		expect(Object.keys(files)).toEqual(["src/_gen/routes.gen.ts"])
		/* the leaf is the node's ws slot, an interned route id */
		expect(files["src/_gen/routes.gen.ts"]).toMatch(
			/const (P\d+) = "WS \/live"[\s\S]*"live": N\(undefined, null, null, null, \1\)/,
		)
	})

	it(
		"writes the manifest, each output as JSON and YAML or YAML alone, and the types from the first output's info",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const openApi = [
				{
					path: "a.json",
					securitySchemes: { key: { in: "header", name: "x-key", type: "apiKey" } },
					title: "A",
					version: "2",
				},
				{ path: "b.yaml", title: "B", version: "3" },
			]
			const { files } = await artifacts(
				{ app: "src/app.ts", codegen: { manifest: true, openApi, tree: false, types: true } },
				dir,
			)
			expect(Object.keys(files)).toEqual([
				"src/_gen/manifest.gen.json",
				"a.json",
				"a.yaml",
				"b.yaml",
				"src/_gen/types.gen.d.ts",
			])
			expect([
				(JSON.parse(files["a.json"] as string) as { info: unknown }).info,
				(files["b.yaml"] as string).split("\n").slice(1, 4),
			]).toEqual([{ title: "A", version: "2" }, ["info:", "  title: B", '  version: "3"']])
			expect(files["src/_gen/types.gen.d.ts"]).toContain('export type RouteSelector = "GET /health" | "POST /items"')
		},
		SLOW,
	)

	it(
		"builds types alone from a bare info, and reports what the types cannot join",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource({ extra: WITH_HIDDEN_ADDITION }) })
			const { files, reports } = await artifacts({ app: "src/app.ts", codegen: { tree: false, types: true } }, dir)
			expect([Object.keys(files), reports]).toEqual([
				["src/_gen/types.gen.d.ts"],
				[
					"GET /hidden: extracted ctx additions match no documented operation (internal and filtered routes are not documented); not typed",
				],
			])
		},
		SLOW,
	)
})

describe("artifactsOf (bit 19 h2), continued (2)", () => {
	it("refuses types for a gateway with no app, its types having no module to be read from", async () => {
		const made = fresh({ "src/down.ts": appSource() })
		made.write(
			"src/routes.ts",
			'import { mergeTree } from "@lovrozagar/honey"\nimport { app } from "./down.ts"\nexport const tree = mergeTree([app.toRouteTree(), {}])\n',
		)
		await expect(artifacts({ codegen: { mergeTree: "src/routes.ts", types: true } }, made.dir)).rejects.toThrow(
			"codegen.types with codegen.mergeTree needs a gateway app: config.app, or the merge entry's app export",
		)
	})
})

describe("prepare: the tree written first (bit 19 h2)", () => {
	const GATEWAY = {
		"src/app.ts":
			'import { honey } from "@lovrozagar/honey"\nimport { routeTree } from "./_gen/routes.gen.ts"\nexport const app = honey().routeTree(routeTree)\n',
		"src/down.ts": appSource(),
		"src/routes.ts":
			'import { mergeTree } from "@lovrozagar/honey"\nimport { app } from "./down.ts"\nexport const tree = mergeTree([app.toRouteTree(), {}])\n',
	}

	it("asks a gateway whose app loads the tree to write it first while it is missing or stale, then not", async () => {
		const config = { app: "src/app.ts", codegen: { mergeTree: "src/routes.ts" } }
		const missing = await artifacts(config, fresh(GATEWAY).dir)
		const stale = await artifacts(
			config,
			fresh({ ...GATEWAY, "src/_gen/routes.gen.ts": `${missing.rewrite?.[1]}// edited\n` }).dir,
		)
		expect([missing.rewrite?.[0], stale.rewrite?.[1]]).toEqual(["src/_gen/routes.gen.ts", missing.rewrite?.[1]])
		/* a fresh project, since the test runner keeps an import that failed: the tree as written is current */
		const current = await artifacts(
			config,
			fresh({ ...GATEWAY, "src/_gen/routes.gen.ts": missing.rewrite?.[1] as string }).dir,
		)
		expect(current.rewrite).toBeUndefined()
	})

	it("asks nothing of an app that does not load its tree, of a later pass, or with no tree to write", async () => {
		const made = fresh({ ...GATEWAY, "src/_gen/routes.gen.ts": "stale" })
		const run = { codegen, root: made.dir }
		const plain = await prepare(resolveHoneyConfig({ app: "src/down.ts" }), { ...run, first: true })
		const later = resolveHoneyConfig({ app: "src/down.ts", codegen: { mergeTree: "src/routes.ts" } })
		const off = resolveHoneyConfig({ app: "src/down.ts", codegen: { mergeTree: "src/routes.ts", tree: false } })
		const results = [plain, await prepare(later, { ...run, first: false }), await prepare(off, { ...run, first: true })]
		expect(results.map(({ rewrite }) => rewrite)).toEqual([undefined, undefined, undefined])
	})
})

describe("virtualCode (bit 19 h2)", () => {
	it("gives the route tree, the manifest and the first document as module code, a gateway's from its merge entry", async () => {
		const made = fresh({ "down/app.ts": appSource() })
		made.write(
			"src/routes.ts",
			'import { mergeTree } from "@lovrozagar/honey"\nimport { app } from "../down/app.ts"\nexport const tree = mergeTree([app.toRouteTree(), { worker: "down" }])\n',
		)
		const config = resolveHoneyConfig({
			codegen: {
				manifest: true,
				mergeTree: "src/routes.ts",
				openApi: [output({ title: "First" }), output({ title: "Second" })],
			},
		})
		const run = { codegen: async () => codegen, root: made.dir }
		const [routes, manifest, document] = await Promise.all(
			(["routes", "manifest", "openApi"] as const).map((kind) => virtualCode(kind, config, run)),
		)
		expect(routes).toMatch(/"POST \/items"/)
		const value = (code: string | undefined) =>
			JSON.parse(String(code).replace(/^export default /, "")) as Record<string, unknown>
		expect([(value(manifest).routes as unknown[]).length, value(document).info]).toEqual([
			2,
			{ title: "First", version: "1" },
		])
	})
})

describe("sourceOf, natively (bit 19 h2)", () => {
	it("imports the app into this core's graph, its default export when it names no app", async () => {
		const { dir } = fresh({ "src/app.ts": appSource({ named: false }) })
		const source = await sourceOf(resolveHoneyConfig({ app: "src/app.ts" }), dir)
		const { entry, exportName } = await source.documented()
		expect([exportName, entry, Object.keys(source.tree.routes)]).toEqual([
			"default",
			join(dir, "src/app.ts"),
			["GET /health", "POST /items"],
		])
	})
})
