/**
 * A gateway's generation (bit 19 h2, `codegen.mergeTree`, v0's shape as re-ruled): the tree written is the merged one
 * plus the gateway's own routes, built from the merge entry's `app` export (made without its tree), else config.app.
 * The documents come from config.app, imported once that tree is current, its errors included, with its services'
 * schemas; with no config.app, from an app booted on the tree. A first run (no tree yet) bootstraps the merged tree; a gateway whose tree is stale only
 * in its services' leaves regenerates over it; a new own route, which its stale tree cannot hold, names the fix.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Project, project } from "./__fixtures__/project.ts"
import { type HoneyVitePluginConfig, resolveHoneyConfig } from "./config.ts"
import { generateAndWrite } from "./generate.ts"
import { sourceOf } from "./source.ts"
import { honey } from "./plugin.ts"

const SLOW = 60_000
const BIN = resolve(import.meta.dirname, "../../bin/honey.js")
const projects: Project[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.done()
})

/** The downstream service: GET /orders and POST /items with a JSON body, plus `extra` lines. */
const downSource = (extra: readonly string[] = []) =>
	[
		'import { honey } from "@lovrozagar/honey"',
		'import * as z from "zod"',
		"export const app = honey()",
		'\t.get("/orders").handler((c) => c.res.text("ok", "orders"))',
		'\t.post("/items")',
		"\t.input({ json: z.object({ name: z.string() }) })",
		'\t.handler((c) => c.res.text("ok", "ok"))',
		...extra,
		"",
	].join("\n")

/** The gateway factory: built with or without its tree, its own routes and errors, and a catch-all. */
const GATEWAY_SOURCE = [
	'import { defineErrors, honey } from "@lovrozagar/honey"',
	"export function createGateway(tree?: unknown) {",
	'\tconst app = honey().errorFactory(defineErrors({ maintenance: "service_unavailable" }))',
	"\tif (tree !== undefined) app.routeTree(tree as never)",
	'\tapp.get("/health").errors("maintenance").handler((c) => c.res.text("ok", "up"))',
	'\tapp.get("/robots.txt").handler((c) => c.res.text("ok", "User-agent: *"))',
	'\tapp.all("/*").handler((c) => c.res.text("ok", "forwarded"))',
	"\treturn app",
	"}",
	"",
].join("\n")

/** A downstream service, its gateway factory (built with or without a tree), and the served gateway over its tree. */
function gatewayProject(): Project {
	const made = project({
		"src/down.ts": downSource(),
		"src/gateway.ts": GATEWAY_SOURCE,
		/* the served gateway, as anyrow.gateway.app.ts: it loads the tree generation writes */
		"src/gateway.app.ts":
			'import { routeTree } from "./_gen/routes.gen.ts"\nimport { createGateway } from "./gateway.ts"\nexport const app = createGateway(routeTree)\n',
		/* the merge entry that also exports the gateway built without its tree */
		"src/seed.ts":
			'import { mergeTree } from "@lovrozagar/honey"\nimport { app as down } from "./down.ts"\nimport { createGateway } from "./gateway.ts"\nexport const tree = mergeTree([down.toRouteTree(), { worker: "down" }])\nexport const app = createGateway()\n',
		"src/route-tree.ts":
			'import { mergeTree } from "@lovrozagar/honey"\nimport { app as down } from "./down.ts"\nexport const tree = mergeTree([down.toRouteTree(), { worker: "down" }])\n',
	})
	projects.push(made)
	return made
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8")
const OUTPUTS = { manifest: true, openApi: { title: "Gateway", version: "1" } } as const
const ALL_WRITTEN = [
	"src/_gen/routes.gen.ts",
	"src/_gen/manifest.gen.json",
	"src/_gen/openapi.gen.json",
	"src/_gen/openapi.gen.yaml",
]
const generate = (config: HoneyVitePluginConfig, dir: string) =>
	generateAndWrite(resolveHoneyConfig(config), dir, { report: () => {} }).then(
		(written) => written.map((file) => file.slice(dir.length + 1)),
		(error: Error) => error.message,
	)
/** The route ids a written tree holds (interned or inline), sorted. */
const routeIds = (dir: string) =>
	[
		...new Set([...read(dir, "src/_gen/routes.gen.ts").matchAll(/"((?:GET|POST|ALL) \/[^"]*)"/g)].map((m) => m[1])),
	].sort()
type Document = { paths: Record<string, Record<string, { requestBody?: object; responses: Record<string, unknown> }>> }
const documentAt = (dir: string) => JSON.parse(read(dir, "src/_gen/openapi.gen.json")) as Document

describe("a gateway's app (bit 19 h2)", () => {
	it(
		"builds the tree from the merge entry's app export, and imports config.app only once that tree is written",
		async () => {
			const made = gatewayProject()
			/* the served gateway gains an own route its tree (none yet, then a stale one) lacks: importing it first would throw */
			const evaluations = join(made.dir, "served.log")
			made.write(
				"src/gateway.app.ts",
				`import { appendFileSync } from "node:fs"\nimport { routeTree } from "./_gen/routes.gen.ts"\nimport { createGateway } from "./gateway.ts"\nappendFileSync(${JSON.stringify(evaluations)}, "x")\nexport const app = createGateway(routeTree)\n`,
			)
			const config = { app: "src/gateway.app.ts", codegen: { ...OUTPUTS, mergeTree: "src/seed.ts" } }
			expect(await generate(config, made.dir)).toEqual(ALL_WRITTEN)
			made.write(
				"src/gateway.ts",
				read(made.dir, "src/gateway.ts").replace(
					"\treturn app",
					'\tapp.get("/status").handler((c) => c.res.text("ok", "s"))\n\treturn app',
				),
			)
			expect(await generate(config, made.dir)).toEqual(ALL_WRITTEN)
			expect(routeIds(made.dir)).toEqual([
				"GET /health",
				"GET /orders",
				"GET /robots.txt",
				"GET /status",
				"POST /items",
			])
			const document = documentAt(made.dir)
			expect([
				Object.keys(document.paths).sort(),
				Object.keys(document.paths["/health"]?.get?.responses ?? {}),
			]).toEqual([["/health", "/items", "/orders", "/robots.txt", "/status"], ["503"]])
			expect(document.paths["/items"]?.post?.requestBody).toBeDefined()
			/* once per generation, each over a tree already written */
			expect(read(made.dir, "served.log")).toBe("xx")
		},
		SLOW,
	)
})

describe("a gateway's app (bit 19 h2), continued (2)", () => {
	// v0: 34399b0ef1
	// v0: 94d4a94b1c
	it(
		"on a first run, bootstraps the merged tree its served app imports, then documents its services' bodies",
		async () => {
			const made = gatewayProject()
			made.write(
				"src/plain.app.ts",
				'import { honey } from "@lovrozagar/honey"\nimport { routeTree } from "./_gen/routes.gen.ts"\nexport const app = honey().routeTree(routeTree)\n',
			)
			const done = await generate(
				{ app: "src/plain.app.ts", codegen: { ...OUTPUTS, mergeTree: "src/route-tree.ts" } },
				made.dir,
			)
			expect(done).toEqual([
				"src/_gen/routes.gen.ts",
				"src/_gen/manifest.gen.json",
				"src/_gen/openapi.gen.json",
				"src/_gen/openapi.gen.yaml",
			])
			expect([routeIds(made.dir), /\biv:/.test(read(made.dir, "src/_gen/routes.gen.ts"))]).toEqual([
				["GET /orders", "POST /items"],
				false,
			])
			const body = documentAt(made.dir).paths["/items"]?.post?.requestBody as
				| { content: Record<string, unknown> }
				| undefined
			expect(body?.content["application/json"]).toBeDefined()
		},
		SLOW,
	)
})

/** The project generated once through the seed entry, so its served gateway has a tree to load. */
async function seeded(): Promise<Project> {
	const made = gatewayProject()
	expect(await generate({ codegen: { mergeTree: "src/seed.ts" } }, made.dir)).toEqual(["src/_gen/routes.gen.ts"])
	return made
}

const SERVED = { app: "src/gateway.app.ts", codegen: { ...OUTPUTS, mergeTree: "src/route-tree.ts" } }

describe("a gateway over its own tree (bit 19 h2, Anyrow's shape)", () => {
	it(
		"writes the merged tree plus its own routes, and documents both with its errors, through config.app",
		async () => {
			const made = await seeded()
			expect(await generate(SERVED, made.dir)).toEqual([
				"src/_gen/manifest.gen.json",
				"src/_gen/openapi.gen.json",
				"src/_gen/openapi.gen.yaml",
			])
			expect(routeIds(made.dir)).toEqual(["GET /health", "GET /orders", "GET /robots.txt", "POST /items"])
			const document = documentAt(made.dir)
			expect(Object.keys(document.paths["/health"]?.get?.responses ?? {})).toEqual(["503"])
			expect(document.paths["/items"]?.post?.requestBody).toBeDefined()
		},
		SLOW,
	)

	it(
		"regenerates over a tree stale only in its services' leaves, the new leaf in the tree and the document",
		async () => {
			const made = await seeded()
			made.write("src/down.ts", downSource(['\t.get("/added").handler((c) => c.res.text("ok", "new"))']))
			const done = await generate(SERVED, made.dir)
			expect(done).toEqual([
				"src/_gen/routes.gen.ts",
				"src/_gen/manifest.gen.json",
				"src/_gen/openapi.gen.json",
				"src/_gen/openapi.gen.yaml",
			])
			expect(routeIds(made.dir)).toContain("GET /added")
			expect(Object.keys(documentAt(made.dir).paths).sort()).toEqual([
				"/added",
				"/health",
				"/items",
				"/orders",
				"/robots.txt",
			])
		},
		SLOW,
	)
})

describe("a gateway over its own tree on Bun (bit 20 k-fix)", () => {
	it(
		"regenerates over a tree stale in its services' leaves, the redo pass documenting the tree just written",
		async () => {
			const made = await seeded()
			made.write("src/down.ts", downSource(['\t.get("/added").handler((c) => c.res.text("ok", "new"))']))
			made.write(
				"vite.config.ts",
				`import { honey } from "@lovrozagar/honey/plugin"\nexport default { plugins: [honey(${JSON.stringify(SERVED)})] }\n`,
			)
			/* Bun keeps each module for the process: the redo pass's fresh graph must not be the first pass's */
			const done = spawnSync("bun", [BIN, "generate"], {
				cwd: made.dir,
				encoding: "utf8",
				env: { ...process.env, HONEY_NO_BUN_HANDOFF: "1" },
				timeout: SLOW,
			})
			expect([done.status, done.stderr, Object.keys(documentAt(made.dir).paths).sort()]).toEqual([
				0,
				"",
				["/added", "/health", "/items", "/orders", "/robots.txt"],
			])
		},
		SLOW,
	)
})

describe("a gateway over its own tree (bit 19 h2, Anyrow's shape), continued (2)", () => {
	it(
		"refuses a new own route its stale tree cannot hold, naming the merge entry's tree-less app as the fix",
		async () => {
			const made = await seeded()
			const tree = read(made.dir, "src/_gen/routes.gen.ts")
			made.write(
				"src/gateway.ts",
				read(made.dir, "src/gateway.ts").replace(
					"\treturn app",
					'\tapp.get("/status").handler((c) => c.res.text("ok", "s"))\n\treturn app',
				),
			)
			expect(await generate(SERVED, made.dir)).toBe(
				"src/gateway.app.ts loads the route tree generation writes (src/_gen/routes.gen.ts), and that tree is stale: export the gateway's app, built without its tree, from src/route-tree.ts as app",
			)
			expect([
				read(made.dir, "src/_gen/routes.gen.ts"),
				existsSync(join(made.dir, "src/_gen/openapi.gen.json")),
			]).toEqual([tree, false])
		},
		SLOW,
	)
})

describe("a gateway through the plugin in dev (bit 19 h2)", () => {
	it(
		"runs one generation per save, its tree write and redo included, and none for the files it writes",
		async () => {
			const made = gatewayProject()
			const evaluations = join(made.dir, "served.log")
			made.write(
				"src/gateway.app.ts",
				`import { appendFileSync } from "node:fs"\nimport { routeTree } from "./_gen/routes.gen.ts"\nimport { createGateway } from "./gateway.ts"\nappendFileSync(${JSON.stringify(evaluations)}, "x")\nexport const app = createGateway(routeTree)\n`,
			)
			expect(await generate({ codegen: { mergeTree: "src/seed.ts" } }, made.dir)).toEqual(["src/_gen/routes.gen.ts"])
			const config = {
				app: "src/gateway.app.ts",
				codegen: { ...OUTPUTS, mergeTree: "src/route-tree.ts" },
				watch: ["src/**"],
			}
			const [plugin] = honey(config)
			plugin.configResolved({ root: made.dir })
			const server = { moduleGraph: { getModuleById: () => undefined } }
			made.write("src/down.ts", downSource(['\t.get("/added").handler((c) => c.res.text("ok", "new"))']))
			await plugin.hotUpdate({ file: join(made.dir, "src/down.ts"), modules: [], server, timestamp: 1 })
			/* one generation: config.app imported to build the changed tree, which is written, then once more over it */
			expect([routeIds(made.dir).includes("GET /added"), read(made.dir, "served.log")]).toEqual([true, "xx"])
			for (const file of ["src/_gen/routes.gen.ts", "src/_gen/openapi.gen.json", "src/_gen/manifest.gen.json"])
				await plugin.hotUpdate({ file: join(made.dir, file), modules: [], server, timestamp: 2 })
			expect(read(made.dir, "served.log")).toBe("xx")
		},
		SLOW,
	)
})

describe("a gateway with no app (bit 19 h2)", () => {
	it(
		"writes the merged tree and documents it from an app booted on it; types need a gateway app",
		async () => {
			const made = gatewayProject()
			expect(await generate({ codegen: { ...OUTPUTS, mergeTree: "src/route-tree.ts" } }, made.dir)).toHaveLength(4)
			expect([routeIds(made.dir), Object.keys(documentAt(made.dir).paths)]).toEqual([
				["GET /orders", "POST /items"],
				["/items", "/orders"],
			])
			expect(await generate({ codegen: { mergeTree: "src/route-tree.ts", types: true } }, made.dir)).toBe(
				"codegen.types with codegen.mergeTree needs a gateway app: config.app, or the merge entry's app export",
			)
			made.write("src/route-tree.ts", "export const tree = 1\n")
			expect(await generate({ codegen: { mergeTree: "src/route-tree.ts" } }, made.dir)).toBe(
				`Expected a route tree as the tree or default export of ${join(made.dir, "src/route-tree.ts")}`,
			)
		},
		SLOW,
	)
})

/** A project linking core's source, for a native leg; removed after it. */
function linked(files: Record<string, string>): Project {
	const made = project(files, { link: true })
	projects.push(made)
	return made
}

const OLDER =
	"export const routeTree = { root: { s: {}, m: null, d: null, w: null, ws: null }, meta: {}, handlers: {} }\n"
const SELF_LOADING =
	'import { honey } from "@lovrozagar/honey"\nimport { routeTree } from "./_gen/routes.gen.ts"\nexport const app = honey().routeTree(routeTree as never)\n'
const MERGE =
	'import { mergeTree } from "@lovrozagar/honey"\nimport { app } from "./down.ts"\nexport const tree = mergeTree([app.toRouteTree(), {}])\n'
const failure = (run: Promise<unknown>) =>
	run.then(
		() => "resolved",
		(error: Error) => error.message,
	)

describe("sourceOf natively: what fails and how it is named (bit 19 h2)", () => {
	it("names a stale tree the app loads with the fix that fits, and passes any other failure through", async () => {
		const plain = linked({ "src/_gen/routes.gen.ts": OLDER, "src/app.ts": SELF_LOADING })
		const off = linked({ "src/_gen/routes.gen.ts": OLDER, "src/app.ts": SELF_LOADING })
		const gateway = linked({
			"src/_gen/routes.gen.ts": OLDER,
			"src/app.ts": SELF_LOADING,
			"src/down.ts": downSource(),
			"src/routes.ts": MERGE,
		})
		const broken = linked({ "src/app.ts": 'throw new Error("not stale")\n' })
		expect([
			await failure(sourceOf(resolveHoneyConfig({ app: "src/app.ts" }), plain.dir)),
			await failure(sourceOf(resolveHoneyConfig({ app: "src/app.ts", codegen: { tree: false } }), off.dir)),
			await failure(
				sourceOf(resolveHoneyConfig({ app: "src/app.ts", codegen: { mergeTree: "src/routes.ts" } }), gateway.dir, true),
			),
			await failure(sourceOf(resolveHoneyConfig({ app: "src/app.ts" }), broken.dir)),
		]).toEqual([
			"src/app.ts loads the route tree generation writes (src/_gen/routes.gen.ts), and that tree is stale: generate from an entry that builds the app without it, or set codegen.mergeTree for a gateway",
			"src/app.ts loads the route tree generation writes (its routes.gen.ts), and that tree is stale: generate from an entry that builds the app without it, or set codegen.mergeTree for a gateway",
			"src/app.ts loads the route tree generation writes (src/_gen/routes.gen.ts), and that tree is stale: export the gateway's app, built without its tree, from src/routes.ts as app",
			"not stale",
		])
	})

	it("refuses a module with no honey app, a merge entry with no tree, and no app at all", async () => {
		const made = linked({ "src/app.ts": "export const app = 1\n", "src/routes.ts": "export const tree = 1\n" })
		expect([
			await failure(sourceOf(resolveHoneyConfig({ app: "src/app.ts" }), made.dir)),
			await failure(sourceOf(resolveHoneyConfig({ codegen: { mergeTree: "src/routes.ts" } }), made.dir)),
			await failure(sourceOf(resolveHoneyConfig({}), made.dir)),
		]).toEqual([
			`Expected a honey app as the app or default export of ${join(made.dir, "src/app.ts")}`,
			`Expected a route tree as the tree or default export of ${join(made.dir, "src/routes.ts")}`,
			"No app configured: set app, or codegen.mergeTree for a gateway",
		])
	})
})

const GATEWAY = (tree: string) => ({
	"src/down.ts": downSource(),
	"src/gateway.ts": GATEWAY_SOURCE,
	"src/served.ts": `import { createGateway } from "./gateway.ts"\n${tree}export const app = createGateway(${tree === "" ? "" : "routeTree"})\n`,
	"src/routes.ts": MERGE,
	"src/seed.ts":
		'import { mergeTree } from "@lovrozagar/honey"\nimport { app as down } from "./down.ts"\nimport { createGateway } from "./gateway.ts"\nexport const tree = mergeTree([down.toRouteTree(), {}])\nexport const app = createGateway()\n',
})

describe("sourceOf natively: a gateway's app (bit 19 h2)", () => {
	it("is the merge entry's app with no config.app, its routes in the tree and its documents from that tree", async () => {
		const made = linked(GATEWAY(""))
		const source = await sourceOf(resolveHoneyConfig({ codegen: { mergeTree: "src/seed.ts" } }), made.dir)
		const documented = await source.documented()
		expect([source.loadsTree, Object.keys(source.tree.routes).sort(), documented.exportName]).toEqual([
			false,
			["GET /health", "GET /orders", "GET /robots.txt", "POST /items"],
			"app",
		])
	})

	it("is the merge entry's app for the tree and config.app for the documents, imported only when asked", async () => {
		const made = linked(GATEWAY('import { routeTree } from "./_gen/routes.gen.ts"\n'))
		const source = await sourceOf(
			resolveHoneyConfig({ app: "src/served.ts", codegen: { mergeTree: "src/seed.ts" } }),
			made.dir,
			true,
		)
		expect([source.loadsTree, Object.keys(source.tree.routes).length]).toEqual([true, 4])
		/* config.app loads a tree not written yet: importing it now fails, as it would before generate.ts wrote it */
		expect(await failure(source.documented())).toMatch(/routes\.gen/)
	})

	it("is config.app, imported over its current tree, when the merge entry has none", async () => {
		const made = linked({
			...GATEWAY(""),
			"src/served.ts": 'import { createGateway } from "./gateway.ts"\nexport const app = createGateway()\n',
		})
		const source = await sourceOf(
			resolveHoneyConfig({ app: "src/served.ts", codegen: { mergeTree: "src/routes.ts" } }),
			made.dir,
		)
		const documented = await source.documented()
		expect([source.loadsTree, documented.entry, Object.keys(source.tree.routes).length]).toEqual([
			true,
			join(made.dir, "src/served.ts"),
			4,
		])
	})

	it("bootstraps a first pass whose config.app imports a tree not yet written, and only that", async () => {
		const tree = 'import { routeTree } from "./_gen/routes.gen.ts"\n'
		const config = resolveHoneyConfig({ app: "src/served.ts", codegen: { mergeTree: "src/routes.ts" } })
		const first = await sourceOf(config, linked(GATEWAY(tree)).dir, true)
		expect([first.loadsTree, Object.keys(first.tree.routes)]).toEqual([true, ["GET /orders", "POST /items"]])
		expect(await failure(first.documented())).toMatch(/routes\.gen/)
		const later = await failure(sourceOf(config, linked(GATEWAY(tree)).dir, false))
		const off = resolveHoneyConfig({ app: "src/served.ts", codegen: { mergeTree: "src/routes.ts", tree: false } })
		const noTree = await failure(sourceOf(off, linked(GATEWAY(tree)).dir, true))
		expect([later, noTree].map((message) => /routes\.gen/.test(message))).toEqual([true, true])
	})
})

describe("sourceOf natively: the documents' app, imported on demand (bit 19 h2)", () => {
	it("imports config.app for the documents once asked, the tree having come from the merge entry's app", async () => {
		const made = linked({
			"src/down.ts": downSource(),
			"src/gateway.ts": GATEWAY_SOURCE,
			"src/seed.ts":
				'import { mergeTree } from "@lovrozagar/honey"\nimport { app as down } from "./down.ts"\nimport { createGateway } from "./gateway.ts"\nexport const tree = mergeTree([down.toRouteTree(), {}])\nexport const app = createGateway()\n',
			"src/served.ts": 'import { createGateway } from "./gateway.ts"\nexport const app = createGateway()\n',
		})
		const source = await sourceOf(
			resolveHoneyConfig({ app: "src/served.ts", codegen: { mergeTree: "src/seed.ts" } }),
			made.dir,
		)
		const documented = await source.documented()
		expect([documented.entry, documented.exportName]).toEqual([join(made.dir, "src/served.ts"), "app"])
	})
})
