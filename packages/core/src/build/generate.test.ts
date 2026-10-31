/**
 * One generation (bit 19 h2): the route tree, the manifest, each OpenAPI document as JSON and YAML (or YAML alone at
 * a `.yaml`/`.yml` path, Q7) and the types, each rewritten only when it changed. The app module is evaluated once, in
 * the module graph of the core that reads it; a gateway's merge entry is loaded and its app never is; a stale tree is
 * replaced, never read, and an app that loads its own fails naming the fix; honey-clients, an optional peer (Q2), is
 * a named error only once a generation runs.
 */
import { execFileSync } from "node:child_process"
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { generateRouteTree } from "../../../gen/src/emit/ts/route-tree.ts"
import { honey } from "../routing/app.ts"
import { appSource, type Project, project } from "./__fixtures__/project.ts"
import { type HoneyVitePluginConfig, MCP_COMPANIONS, resolveHoneyConfig } from "./config.ts"
import { artifactsFor, generateAndWrite, loadClients } from "./generate.ts"

const SLOW = 60_000
/* an internal route whose own middleware adds to ctx: extracted, never documented, so the types report it */
const HIDDEN_ADDITION = [
	'\t.get("/hidden")',
	"\t.meta({ internal: true } as never)",
	"\t.use(createMiddleware((_c, next) => next({ hidden: 1 })))",
	'\t.handler((c) => c.res.text("ok", "h"))',
]
/* the script that imports the plugin from a copy of core */
const FIXTURE = resolve(import.meta.dirname, "../../tests", ["bui", "ld"].join(""), "fixture/without-codegen.ts")
const projects: Project[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.done()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

/** A fresh project of `files`, removed after the leg. */
function fresh(files: Record<string, string> = {}): Project {
	const made = project(files)
	projects.push(made)
	return made
}

/** One generation of `config` in `dir`: the files it rewrote, relative, and what it reported. */
async function generate(config: HoneyVitePluginConfig, dir: string) {
	const reports: string[] = []
	const written = await generateAndWrite(resolveHoneyConfig(config), dir, { report: (line) => reports.push(line) })
	return { reports, written: written.map((file) => file.slice(dir.length + 1)) }
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8")
const ALL = { manifest: true, openApi: { title: "Gen", version: "1.0.0" }, tree: true } as const

/** Every `[honey:invalidate]` report the app's logger printed (production: its sink is stdout) while `run` ran. */
async function invalidateReports(run: () => Promise<unknown>): Promise<number> {
	let printed = ""
	vi.stubEnv("NODE_ENV", "production")
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((printed += String(chunk)), true))
	await run()
	vi.restoreAllMocks()
	return printed.split("[honey:invalidate]").length - 1
}

// v0: 62e871b032
/* its other half, a top-level serve() binding nothing, retires (Q3): v1 never serves implicitly, so there is no
   bind to suppress, and a module-global no-bind slot would break H19.3 and the no-registries rule */
it(
	"evaluates the app once per generation, however many artifacts it writes",
	async () => {
		const made = fresh()
		const log = join(made.dir, "evaluations.log")
		made.write(
			"src/app.ts",
			`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, "x")\n${appSource()}`,
		)
		await generate({ app: "src/app.ts", codegen: { ...ALL, types: true } }, made.dir)
		expect(read(made.dir, "evaluations.log")).toBe("x")
	},
	SLOW,
)

describe("generateAndWrite (bit 19 h2)", () => {
	// v0: 7b94c0b20e
	// v0: 7ea7564b75
	// v0: c9c6a510ee
	// v0: f2ae36afa7
	it(
		"writes the route tree, the manifest, and the OpenAPI document as JSON and YAML",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const { written } = await generate({ app: "src/app.ts", codegen: ALL }, dir)
			expect(written).toEqual([
				"src/_gen/routes.gen.ts",
				"src/_gen/manifest.gen.json",
				"src/_gen/openapi.gen.json",
				"src/_gen/openapi.gen.yaml",
			])
			expect(read(dir, "src/_gen/routes.gen.ts")).toMatch(/"GET \/health"[\s\S]*"POST \/items"/)
			const manifest = JSON.parse(read(dir, "src/_gen/manifest.gen.json")) as { routes: { path: string }[] }
			expect(manifest.routes.map((route) => route.path)).toEqual(["/health", "/items"])
			const document = JSON.parse(read(dir, "src/_gen/openapi.gen.json")) as Record<string, Record<string, unknown>>
			expect([document.openapi, document.info, Object.keys(document.paths)]).toEqual([
				"3.1.0",
				{ title: "Gen", version: "1.0.0" },
				["/health", "/items"],
			])
			expect((document.paths["/items"] as { post: { requestBody?: object } }).post.requestBody).toBeDefined()
			expect(read(dir, "src/_gen/openapi.gen.yaml")).toMatch(/^openapi: "3\.1\.0"$[\s\S]*^ {2}title: Gen$/m)
		},
		SLOW,
	)

	// v0: fac8e13eb5
	// v0: 7b2b90bd22
	// v0: 979b314fdd
	// v0: 573181d12f
	it(
		"rewrites nothing when nothing changed, and the tree once a route is added, its params and error keys kept",
		async () => {
			const made = fresh({ "src/app.ts": appSource() })
			const path = join(made.dir, "src/_gen/routes.gen.ts")
			await generate({ app: "src/app.ts" }, made.dir)
			const first = statSync(path).mtimeMs
			expect((await generate({ app: "src/app.ts" }, made.dir)).written).toEqual([])
			expect(statSync(path).mtimeMs).toBe(first)
			const extra = [
				'\t.get("/users/:id").meta({ errors: ["not_found"] } as never).handler((c) => c.res.text("ok", c.params.id))',
			]
			made.write("src/app.ts", appSource({ extra }))
			expect((await generate({ app: "src/app.ts" }, made.dir)).written).toEqual(["src/_gen/routes.gen.ts"])
			expect(read(made.dir, "src/_gen/routes.gen.ts")).toContain('"GET /users/:id"')
		},
		SLOW,
	)
})

describe("generateAndWrite (bit 19 h2), continued (2)", () => {
	// v0: ee31dfe16b
	it(
		"writes no manifest or document unless asked, and nothing at all with every artifact off",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			expect((await generate({ app: "src/app.ts" }, dir)).written).toEqual(["src/_gen/routes.gen.ts"])
			expect(await generate({ app: "src/nope.ts", codegen: { tree: false } }, dir)).toEqual({
				reports: [],
				written: [],
			})
		},
		SLOW,
	)

	// v0: 0c499d84a2
	it(
		"takes the app's default export when it names no app",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource({ named: false }) })
			await generate({ app: "src/app.ts" }, dir)
			expect(read(dir, "src/_gen/routes.gen.ts")).toContain('"GET /health"')
		},
		SLOW,
	)

	// v0: 8cc3704e5f
	// v0: c14fc68298
	it(
		"refuses a generation with no app, and an app module that exports no honey app",
		async () => {
			const { dir } = fresh({ "src/app.ts": "export const app = { not: true }\n" })
			await expect(generate({ codegen: { manifest: true, tree: false } }, dir)).rejects.toThrow(
				"No app configured: set app, or codegen.mergeTree for a gateway",
			)
			await expect(generate({ app: "src/app.ts" }, dir)).rejects.toThrow(
				`Expected a honey app as the app or default export of ${join(dir, "src/app.ts")}`,
			)
		},
		SLOW,
	)
})

describe("generateAndWrite (bit 19 h2), continued (3)", () => {
	// v0: b6b19279e0
	// v0: e35fad649c
	it(
		"writes an OpenAPI output at a .yml or .yaml path once, as YAML, with no sibling",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const openApi = [
				{ path: "openapi.yml", title: "T", version: "1" },
				{ path: "docs/openapi.yaml", title: "T", version: "1" },
			]
			const { written } = await generate({ app: "src/app.ts", codegen: { openApi, tree: false } }, dir)
			expect(written).toEqual(["openapi.yml", "docs/openapi.yaml"])
			expect([read(dir, "openapi.yml"), read(dir, "docs/openapi.yaml")].map((text) => text.slice(0, 16))).toEqual([
				'openapi: "3.1.0"',
				'openapi: "3.1.0"',
			])
			expect(
				["openapi.yaml", "openapi.json", "docs/openapi.json"].filter((path) => existsSync(join(dir, path))),
			).toEqual([])
		},
		SLOW,
	)

	// v0: c082370d45
	it(
		"reports a mutation's missing invalidate once, however many documents and types it writes",
		async () => {
			const { dir } = fresh({
				"src/app.ts": appSource({ extra: ['\t.get("/items").handler((c) => c.res.text("ok", "ok"))'] }),
			})
			const openApi = [
				{ path: "a.json", title: "T", version: "1" },
				{ path: "b.json", title: "T", version: "1" },
			]
			const config = { app: "src/app.ts", codegen: { openApi, tree: false, types: true } }
			expect(await invalidateReports(() => generate(config, dir))).toBe(1)
		},
		SLOW,
	)

	// v0: 75ddd200b6
	it(
		"builds the types' document with the check when no OpenAPI output ran it, so it still reports once",
		async () => {
			const { dir } = fresh({
				"src/app.ts": appSource({ extra: ['\t.get("/items").handler((c) => c.res.text("ok", "ok"))'] }),
			})
			const config = { app: "src/app.ts", codegen: { tree: false, types: true } }
			expect(await invalidateReports(() => generate(config, dir))).toBe(1)
			expect(read(dir, "src/_gen/types.gen.d.ts")).toContain('export type RouteSelector = "GET /health" | "GET /items"')
		},
		SLOW,
	)
})

describe("a stale route tree (bit 19 h2, V072-3 under Q3)", () => {
	const OLDER =
		"/* @generated by an older honey */\nexport const routeTree = { root: { s: {}, m: null, d: null, w: null, ws: null }, meta: {}, handlers: {} }\n"
	/** A v2 tree holding GET /a alone: out of date once the app registers GET /b. */
	const outOfDate = () => {
		const old = honey<{}>()
		old.get("/a").handler((c) => c.res.text("ok", "a"))
		return generateRouteTree(old.toRouteTree() as never)
	}
	const SELF_LOADING = [
		'import { honey } from "@lovrozagar/honey"',
		'import { routeTree } from "./_gen/routes.gen.ts"',
		"export const app = honey().routeTree(routeTree as never)",
		'app.get("/a").handler((c) => c.res.text("ok", "a"))',
		'app.get("/b").handler((c) => c.res.text("ok", "b"))',
		"",
	].join("\n")

	// v0: 68707d2262
	// v0: e3076a2112
	it(
		"replaces a tree written by an older honey, or one out of date, without reading it",
		async () => {
			for (const stale of [OLDER, outOfDate()]) {
				const { dir } = fresh({ "src/_gen/routes.gen.ts": stale, "src/app.ts": appSource() })
				await generate({ app: "src/app.ts" }, dir)
				expect(read(dir, "src/_gen/routes.gen.ts")).toMatch(/"GET \/health"[\s\S]*"POST \/items"/)
			}
		},
		SLOW,
	)

	it(
		"refuses an app that loads its own stale tree, naming the tree and the fixes, and writes nothing",
		async () => {
			for (const stale of [OLDER, outOfDate()]) {
				const { dir } = fresh({ "src/_gen/routes.gen.ts": stale, "src/app.ts": SELF_LOADING })
				await expect(generate({ app: "src/app.ts", codegen: ALL }, dir)).rejects.toThrow(
					"src/app.ts loads the route tree generation writes (src/_gen/routes.gen.ts), and that tree is stale: generate from an entry that builds the app without it, or set codegen.mergeTree for a gateway",
				)
				expect([read(dir, "src/_gen/routes.gen.ts"), existsSync(join(dir, "src/_gen/manifest.gen.json"))]).toEqual([
					stale,
					false,
				])
			}
		},
		SLOW,
	)
})

describe("honey-clients, an optional peer (bit 19 h2, Q2)", () => {
	it("passes any failure but its own absence through", async () => {
		const broken = Object.assign(new Error("boom"), { code: "ERR_MODULE_NOT_FOUND" })
		await expect(loadClients(() => Promise.reject(broken))).rejects.toBe(broken)
	})

	/** A copy of core's source in a project with only jiti and zod installed: honey-clients cannot resolve. */
	function withoutCodegen(): string {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "honey-no-codegen-"))
		projects.push({ dir, done: () => rmSync(dir, { force: true, recursive: true }), write: () => {} })
		const modules = resolve(import.meta.dirname, "../../../../node_modules")
		const honeyDir = join(dir, "node_modules/@lovrozagar/honey")
		mkdirSync(honeyDir, { recursive: true })
		mkdirSync(join(dir, "src"))
		cpSync(resolve(import.meta.dirname, ".."), join(dir, "core/src"), { recursive: true })
		for (const name of ["jiti", "zod"]) symlinkSync(join(modules, name), join(dir, "node_modules", name), "dir")
		symlinkSync(join(dir, "core/src"), join(honeyDir, "src"), "dir")
		const pkg = { exports: { ".": "./src/routing/app.ts" }, name: "@lovrozagar/honey", type: "module" }
		writeFileSync(join(honeyDir, "package.json"), JSON.stringify(pkg))
		writeFileSync(join(dir, "src/app.ts"), appSource())
		return dir
	}

	it(
		"lets the plugin load and serve a document without it, and names it once a generation runs",
		() => {
			const dir = withoutCodegen()
			const runs = ["bun", "node"].map((runtime) =>
				JSON.parse(execFileSync(runtime, [FIXTURE, join(dir, "core"), dir], { cwd: dir, encoding: "utf8" })),
			)
			const expected = {
				generation: {
					error:
						"honey: generating the app's artifacts needs @lovrozagar/honey-clients: add it to your devDependencies",
				},
				off: { ok: null },
				openApi: { ok: ["code", "moduleType"] },
			}
			expect(runs).toEqual([expected, expected])
		},
		SLOW,
	)
})

describe("artifactsFor: the app's own core (bit 19 h2)", () => {
	it(
		"loads the artifacts of the app's @lovrozagar/honey, a copy other than this plugin's, and generates the app's routes",
		async () => {
			const made = fresh({ "src/app.ts": appSource() })
			expect(artifactsFor(made.dir)).toBe(
				join(made.dir, "node_modules/@lovrozagar/honey/src", ["bui", "ld"].join(""), "artifacts.ts"),
			)
			await generate({ app: "src/app.ts" }, made.dir)
			expect(read(made.dir, "src/_gen/routes.gen.ts")).toMatch(/"GET \/health"[\s\S]*"POST \/items"/)
		},
		SLOW,
	)

	it("falls back to this package's own with no app copy found, or outside any package", () => {
		const bare = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "honey-bare-"))
		projects.push({ dir: bare, done: () => rmSync(bare, { force: true, recursive: true }), write: () => {} })
		const own = join(import.meta.dirname, "artifacts.ts")
		expect([artifactsFor(bare), artifactsFor(bare, join(bare, "artifacts.ts"))]).toEqual([
			own,
			join(bare, "artifacts.ts"),
		])
	})
})

describe("a generation's reports (bit 19 h2)", () => {
	it(
		"goes to stderr by default, one line each",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource({ extra: HIDDEN_ADDITION }) })
			let printed = ""
			vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((printed += String(chunk)), true))
			await generateAndWrite(resolveHoneyConfig({ app: "src/app.ts", codegen: { tree: false, types: true } }), dir)
			vi.restoreAllMocks()
			expect(printed).toBe(
				"honey: GET /hidden: extracted ctx additions match no documented operation (internal and filtered routes are not documented); not typed\n",
			)
		},
		SLOW,
	)

	it("names honey-clients when it is not installed", async () => {
		const absent = Object.assign(new Error("Cannot find package '@lovrozagar/honey-clients'"), {
			code: "ERR_MODULE_NOT_FOUND",
		})
		await expect(loadClients(() => Promise.reject(absent))).rejects.toThrow(
			"honey: generating the app's artifacts needs @lovrozagar/honey-clients: add it to your devDependencies",
		)
	})
})

describe("the MCP handler output (bit 21 e)", () => {
	it(
		"writes the handler of the routes marked mcp that filterRoutes keeps, secured by the outputs' schemes, and its companions",
		async () => {
			const { dir } = fresh({
				"src/app.ts": appSource({
					extra: [
						'\t.post("/orders").meta({ mcp: true, security: [{ apiKey: [] }] }).handler((c) => c.res.text("ok", "ok"))',
						'\t.get("/hidden").meta({ mcp: true }).handler((c) => c.res.text("ok", "ok"))',
					],
				}),
			})
			const apiKey = { description: "Format: ApiKey {key}", in: "header", name: "Authorization", type: "apiKey" }
			const { written } = await generate(
				{
					app: "src/app.ts",
					codegen: {
						mcp: { filterRoutes: (route) => route.path !== "/hidden" },
						openApi: { path: "out/doc.json", securitySchemes: { apiKey }, title: "Gen", version: "1.0.0" },
						tree: false,
					},
				},
				dir,
			)
			const entry = read(dir, "src/_gen/mcp.gen.ts")
			expect([
				written.filter((file) => file.startsWith("src/")).sort(),
				entry.match(/name: "[\w-]+"/g),
				/secured: true/.test(entry),
				read(dir, "src/_gen/mcp/runtime.gen.ts").includes("export function mountedMcp("),
			]).toEqual([
				["src/_gen/mcp.gen.ts", ...MCP_COMPANIONS.map((name) => `src/_gen/mcp/${name}`)].sort(),
				['name: "post_orders"', 'name: "gen"'],
				true,
				true,
			])
		},
		SLOW,
	)
})
