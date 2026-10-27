/**
 * honey(), the Vite plugin (bit 19 h2): one plugin named honey carrying its config for `honey generate`; the virtual
 * route tree (JavaScript, in a real dev server too), manifest and document; a generation at build start (one across
 * Vite's environments), and on a watched save in dev (one per save across environments, never for a generated file
 * or a temp file, the route tree joining HMR); with a config file, each generation a child that sees edited imports.
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { appSource, type Project, project } from "./__fixtures__/project.ts"
import type { HoneyVitePluginConfig } from "./config.ts"
import { honey, toJavaScript } from "./plugin.ts"

const SLOW = 60_000
const ROUTES = "\0virtual:honey/routes"
const projects: Project[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.done()
})

/** A fresh project of `files`, removed after the leg. */
function fresh(files: Record<string, string> = {}): Project {
	const made = project(files)
	projects.push(made)
	return made
}

/** honey()'s plugin, resolved at `root` as Vite resolves it. */
function pluginAt(config: HoneyVitePluginConfig, root?: string) {
	const [plugin] = honey(config)
	if (root !== undefined) plugin.configResolved({ root })
	return plugin
}

/** An app module that appends to `evaluations.log` each time it is evaluated, so a leg can count generations. */
function counted(made: Project): () => number {
	const log = join(made.dir, "evaluations.log")
	made.write(
		"src/app.ts",
		`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, "x")\n${appSource()}`,
	)
	return () => (existsSync(log) ? readFileSync(log, "utf8").length : 0)
}

const graph = (found: unknown) => ({ moduleGraph: { getModuleById: vi.fn(() => found) } })
const tree = (dir: string) => readFileSync(join(dir, "src/_gen/routes.gen.ts"), "utf8")

describe("honey() (bit 19 h2)", () => {
	// v0: 82d46bf4d5
	// v0: 6c71b279c9
	// v0: a242b669a8
	it("is one plugin named honey that carries its config for honey generate", () => {
		const config = { app: "src/app.ts" }
		const plugins = honey(config)
		expect([plugins.length, plugins[0].name, plugins[0].api.honeyConfig]).toEqual([1, "honey", config])
	})

	// v0: dccdaa093c
	// v0: 0ddf313f4d
	it("resolves the route tree always, and the manifest and document only when configured", () => {
		const on = pluginAt({ app: "src/app.ts", codegen: { manifest: true, openApi: { title: "T", version: "1" } } })
		const off = pluginAt({ app: "src/app.ts" })
		const ids = ["virtual:honey/routes", "virtual:honey/manifest", "virtual:honey/openapi", "./other"]
		expect([ids.map((id) => on.resolveId(id)), ids.map((id) => off.resolveId(id))]).toEqual([
			["\0virtual:honey/routes", "\0virtual:honey/manifest", "\0virtual:honey/openapi", undefined],
			["\0virtual:honey/routes", undefined, undefined, undefined],
		])
	})

	// v0: 5f20f383c2
	// v0: c896cc29ce
	it(
		"loads the route tree as JavaScript, the manifest and document as modules, and nothing for another id",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const plugin = pluginAt(
				{ app: "src/app.ts", codegen: { manifest: true, openApi: { title: "T", version: "1" } } },
				dir,
			)
			const routes = await plugin.load(ROUTES)
			expect([routes?.moduleType, routes?.code.includes("GET /health")]).toEqual(["js", true])
			/* JavaScript, not the TypeScript the tree codegen writes to disk */
			expect(routes?.code).not.toMatch(/import type|: TreeNode|as unknown as/)
			const manifest = await plugin.load("\0virtual:honey/manifest")
			const document = await plugin.load("\0virtual:honey/openapi")
			expect([manifest?.code.startsWith("export default {"), document?.code.includes('"title":"T"')]).toEqual([
				true,
				true,
			])
			expect(await plugin.load("./other.ts")).toBeUndefined()
			expect(await pluginAt({ app: "src/app.ts" }, dir).load("\0virtual:honey/openapi")).toBeUndefined()
			expect(await pluginAt({ app: "src/app.ts" }, dir).load("\0virtual:honey/manifest")).toBeUndefined()
		},
		SLOW,
	)
})

describe("honey() (bit 19 h2), continued (2)", () => {
	// v0: add50a69c3
	it(
		"builds the virtual document with its output's profile",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const plugin = pluginAt(
				{ app: "src/app.ts", codegen: { openApi: { profile: "nope", title: "T", version: "1" } } },
				dir,
			)
			/* an unknown profile is refused, which proves the profile reached generateOpenApi */
			await expect(plugin.load("\0virtual:honey/openapi")).rejects.toThrow(/profile/i)
		},
		SLOW,
	)

	// v0: bf67e0518d
	it(
		"serves the virtual route tree in a real Vite dev server",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const { createServer } = await import("vite")
			const server = await createServer({
				configFile: false,
				logLevel: "silent",
				plugins: honey({ app: "src/app.ts", codegen: { tree: false } }),
				root: dir,
				server: { middlewareMode: true, ws: false },
			})
			try {
				const mod = (await server.ssrLoadModule("virtual:honey/routes")) as { routeTree?: { routes: object } }
				expect(Object.keys(mod.routeTree?.routes ?? {})).toEqual(["GET /health", "POST /items"])
			} finally {
				await server.close()
			}
		},
		SLOW,
	)
})

describe("honey() at build start (bit 19 h2)", () => {
	// v0: 0bc0d6a701
	// v0: e459c5305b
	// v0: d27db436ac
	it(
		"writes the route tree, the document with its JSON Schema bodies, and the manifest",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			await pluginAt(
				{ app: "src/app.ts", codegen: { manifest: true, openApi: { title: "Test", version: "2.0" } } },
				dir,
			).buildStart()
			expect(tree(dir)).toMatch(/"GET \/health"[\s\S]*"POST \/items"/)
			const document = JSON.parse(readFileSync(join(dir, "src/_gen/openapi.gen.json"), "utf8")) as {
				info: { title: string }
				paths: Record<string, { post?: { requestBody?: { content: Record<string, { schema: object }> } } }>
			}
			expect([
				document.info.title,
				document.paths["/items"]?.post?.requestBody?.content["application/json"]?.schema,
			]).toEqual(["Test", { $ref: "#/components/schemas/CreateItemRequest" }])
			expect(readFileSync(join(dir, "src/_gen/openapi.gen.yaml"), "utf8")).toMatch(/title: Test[\s\S]*\/items:/)
			const manifest = JSON.parse(readFileSync(join(dir, "src/_gen/manifest.gen.json"), "utf8")) as {
				routes: unknown[]
			}
			expect(manifest.routes).toHaveLength(2)
		},
		SLOW,
	)

	// v0: d9c5a2484f
	// v0: 593dc013be
	it(
		"writes to custom paths, and no tree when it is off",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			await pluginAt(
				{ app: "src/app.ts", codegen: { manifest: "gen/manifest.json", tree: "gen/routes.gen.ts" } },
				dir,
			).buildStart()
			expect(["gen/routes.gen.ts", "gen/manifest.json"].map((path) => existsSync(join(dir, path)))).toEqual([
				true,
				true,
			])
			const off = fresh({ "src/app.ts": appSource() })
			await pluginAt({ app: "src/app.ts", codegen: { tree: false } }, off.dir).buildStart()
			expect(existsSync(join(off.dir, "src/_gen/routes.gen.ts"))).toBe(false)
		},
		SLOW,
	)
})

describe("honey() at build start (bit 19 h2), continued (2)", () => {
	// v0: 56527a95bd
	it(
		"runs one generation when Vite starts two environments back to back, and anew on a later build",
		async () => {
			const made = fresh()
			const evaluations = counted(made)
			const plugin = pluginAt({ app: "src/app.ts" }, made.dir)
			await Promise.all([plugin.buildStart(), plugin.buildStart()])
			expect(evaluations()).toBe(1)
			await plugin.buildStart()
			expect(evaluations()).toBe(2)
		},
		SLOW,
	)

	// v0: e05ef8636e
	it(
		"with a config file, generates in a child that sees edits to the modules the app imports",
		async () => {
			const made = fresh({
				"src/app.ts":
					'import { honey } from "@lovrozagar/honey"\nimport { path } from "./routes.ts"\nexport const app = honey().get(path).handler((c) => c.res.text("ok", "ok"))\n',
				"src/routes.ts": 'export const path = "/first"\n',
				"vite.config.ts":
					'import { honey } from "@lovrozagar/honey/plugin"\nexport default { plugins: [honey({ app: "src/app.ts", codegen: { tree: "src/_gen/routes.gen.ts" } })] }\n',
			})
			const [plugin] = honey({ app: "src/app.ts" })
			const configFile = join(made.dir, "vite.config.ts")
			plugin.configResolved({ command: "build", configFile, plugins: [{ name: "other" }, plugin], root: made.dir })
			await plugin.buildStart()
			expect(tree(made.dir)).toContain('"GET /first"')
			made.write("src/routes.ts", 'export const path = "/second"\n')
			await plugin.buildStart()
			expect(tree(made.dir)).toContain('"GET /second"')
		},
		SLOW,
	)

	it(
		"fails a build start whose child generation fails, naming how it ended",
		async () => {
			const made = fresh({ "vite.config.ts": "export default { plugins: [] }\n" })
			const [plugin] = honey({ app: "src/app.ts" })
			plugin.configResolved({ configFile: join(made.dir, "vite.config.ts"), plugins: [plugin], root: made.dir })
			await expect(plugin.buildStart()).rejects.toThrow("honey generate failed (exit 1)")
		},
		SLOW,
	)
})

describe("honey() on a save in dev (bit 19 h2)", () => {
	// v0: 88cc84efdc
	it(
		"regenerates on a watched save and lets HMR go on, the route tree joining the update",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const plugin = pluginAt({ app: "src/app.ts", watch: ["src/**/*.ts"] }, dir)
			const [routes, edited] = [{ id: ROUTES }, { id: join(dir, "src/app.ts") }]
			const result = await plugin.hotUpdate({ file: join(dir, "src/app.ts"), modules: [edited], server: graph(routes) })
			expect(result).toEqual([edited, routes])
			expect(tree(dir)).toContain('"GET /health"')
			/* already part of the update: left as it is */
			expect(
				await plugin.hotUpdate({ file: join(dir, "src/app.ts"), modules: [routes], server: graph(routes) }),
			).toBeUndefined()
		},
		SLOW,
	)

	// v0: 963c059016
	it(
		"leaves HMR alone when no module imports the virtual route tree",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			const plugin = pluginAt({ app: "src/app.ts", watch: ["src/**/*.ts"] }, dir)
			expect(
				await plugin.hotUpdate({ file: join(dir, "src/app.ts"), modules: [], server: graph(undefined) }),
			).toBeUndefined()
		},
		SLOW,
	)

	// v0: 9d8e902099
	it(
		"generates once per save across environments, reading the environment's own module graph",
		async () => {
			const made = fresh()
			const evaluations = counted(made)
			const plugin = pluginAt({ app: "src/app.ts", watch: ["src/**/*.ts"] }, made.dir)
			const save = { file: join(made.dir, "src/app.ts"), modules: [], server: graph(undefined), timestamp: 42 }
			const environment = graph(null)
			await plugin.hotUpdate.call({ environment }, save)
			await plugin.hotUpdate.call({ environment }, save)
			expect([evaluations(), environment.moduleGraph.getModuleById.mock.calls.length]).toEqual([1, 2])
			await plugin.hotUpdate.call({ environment }, { ...save, timestamp: 43 })
			expect(evaluations()).toBe(2)
		},
		SLOW,
	)
})

describe("honey() on a save in dev (bit 19 h2), continued (2)", () => {
	// v0: 28ce361b76
	// v0: 82f8d40099
	// v0: 1257be6d78
	it(
		"never generates for a generated output, an atomic write's temp file, or a file no glob matches",
		async () => {
			const made = fresh()
			const evaluations = counted(made)
			const plugin = pluginAt(
				{ app: "src/app.ts", codegen: { manifest: "out/manifest.json" }, watch: ["**/*"] },
				made.dir,
			)
			const narrow = pluginAt({ app: "src/app.ts", watch: ["src/routes/**/*.ts"] }, made.dir)
			const unwatched = pluginAt({ app: "src/app.ts" }, made.dir)
			const server = graph(undefined)
			for (const file of ["src/_gen/routes.gen.ts", "out/manifest.json", "src/.4242.ab12cd.tmp"])
				await plugin.hotUpdate({ file: join(made.dir, file), modules: [], server })
			await narrow.hotUpdate({ file: join(made.dir, "src/utils/helper.ts"), modules: [], server })
			await unwatched.hotUpdate({ file: join(made.dir, "src/app.ts"), modules: [], server })
			expect([evaluations(), server.moduleGraph.getModuleById.mock.calls.length]).toEqual([0, 0])
		},
		SLOW,
	)

	it(
		"reports a failed generation on a save and still lets HMR go on",
		async () => {
			const made = fresh({ "src/app.ts": "export const app = 1\n" })
			const plugin = pluginAt({ app: "src/app.ts", watch: ["src/**/*.ts"] }, made.dir)
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
			const result = await plugin.hotUpdate({
				file: join(made.dir, "src/app.ts"),
				modules: [],
				server: graph(undefined),
			})
			expect([result, String(stderr.mock.calls[0]?.[0])]).toEqual([
				undefined,
				`honey: generation failed: Error: Expected a honey app as the app or default export of ${join(made.dir, "src/app.ts")}\n`,
			])
			stderr.mockRestore()
			rmSync(join(made.dir, "src/app.ts"))
		},
		SLOW,
	)
})

describe("honey() under load (bit 19 h2)", () => {
	it(
		"queues one generation behind a running one, every save meanwhile joining it",
		async () => {
			const made = fresh()
			const evaluations = counted(made)
			const plugin = pluginAt({ app: "src/app.ts", watch: ["src/**/*.ts"] }, made.dir)
			const save = (timestamp: number) =>
				plugin.hotUpdate({ file: join(made.dir, "src/app.ts"), modules: [], server: graph(undefined), timestamp })
			await Promise.all([save(1), save(2), save(3)])
			expect(evaluations()).toBe(2)
		},
		SLOW,
	)

	it("forgets all but the last 64 saves, so an old save's key generates again", async () => {
		const made = fresh()
		const evaluations = counted(made)
		const plugin = pluginAt({ app: "src/app.ts", watch: ["src/**/*.ts"] }, made.dir)
		const save = (timestamp: number) =>
			plugin.hotUpdate({ file: join(made.dir, "src/app.ts"), modules: [], server: graph(undefined), timestamp })
		for (let timestamp = 1; timestamp <= 65; timestamp++) await save(timestamp)
		await save(65)
		expect(evaluations()).toBe(65)
		await save(1)
		expect(evaluations()).toBe(66)
	}, 180_000)

	it(
		"passes Vite's mode to its generation child",
		async () => {
			const made = fresh({
				"src/app.ts": appSource(),
				"vite.config.ts":
					'import { honey } from "@lovrozagar/honey/plugin"\nexport default ({ mode }) => ({ plugins: [honey({ app: "src/app.ts", codegen: { manifest: mode === "staging" } })] })\n',
			})
			const [plugin] = honey({ app: "src/app.ts" })
			plugin.configResolved({
				command: "serve",
				configFile: join(made.dir, "vite.config.ts"),
				mode: "staging",
				plugins: [plugin],
				root: made.dir,
			})
			await plugin.buildStart()
			expect(existsSync(join(made.dir, "src/_gen/manifest.gen.json"))).toBe(true)
		},
		SLOW,
	)
})

describe("honey() under load (bit 19 h2), continued (2)", () => {
	it("serves the route tree as TypeScript when Vite or its transform is not there", async () => {
		const code = "const a: number = 1\n"
		const missing = await toJavaScript(code, () => Promise.reject(new Error("no vite")))
		const bare = await toJavaScript(code, async () => ({}))
		expect([missing, bare]).toEqual([
			{ code, moduleType: "ts" },
			{ code, moduleType: "ts" },
		])
	})
})

describe("honey() under load, failing (bit 19 h2)", () => {
	it(
		"runs the generation queued behind a failed one, each failure reported",
		async () => {
			const made = fresh({ "src/app.ts": "export const app = 1\n" })
			const plugin = pluginAt({ app: "src/app.ts", watch: ["src/**/*.ts"] }, made.dir)
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
			const save = (timestamp: number) =>
				plugin.hotUpdate({ file: join(made.dir, "src/app.ts"), modules: [], server: graph(undefined), timestamp })
			await Promise.all([save(1), save(2)])
			const reports = stderr.mock.calls
				.map(([chunk]) => String(chunk))
				.filter((line) => line.startsWith("honey: generation failed"))
			stderr.mockRestore()
			expect(reports).toHaveLength(2)
		},
		SLOW,
	)

	it(
		"takes development as the mode of a dev server that names none",
		async () => {
			const made = fresh({
				"src/app.ts": appSource(),
				"vite.config.ts":
					'import { honey } from "@lovrozagar/honey/plugin"\nexport default ({ mode }) => ({ plugins: [honey({ app: "src/app.ts", codegen: { manifest: mode === "development" } })] })\n',
			})
			const [plugin] = honey({ app: "src/app.ts" })
			plugin.configResolved({
				command: "serve",
				configFile: join(made.dir, "vite.config.ts"),
				plugins: [plugin],
				root: made.dir,
			})
			await plugin.buildStart()
			expect(existsSync(join(made.dir, "src/_gen/manifest.gen.json"))).toBe(true)
		},
		SLOW,
	)
})
