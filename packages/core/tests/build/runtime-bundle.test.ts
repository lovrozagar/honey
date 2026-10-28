/**
 * What an app's bundle carries from the installed package (bit 19 i, ported from v0's runtime-bundle.test.ts): the
 * real core tarball, installed beside honey-codegen and every optional peer (ws, oxfmt, ts-morph; jiti is core's own
 * dependency), so a leak would be bundled rather than fail to resolve. A bundle of `honey()` leaves out the tooling
 * and every optional feature until its subpath is imported; a Worker built by the build plugin carries none of the
 * build-time packages; and a core-only install loads the plugin, failing by name only when it is asked to generate.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { pinnedBunVersion, withPinnedBun } from "../../../gen/src/gen/__fixtures__/pinned-bun.ts"
import { consumer, pack, run, scratch, type Tarballs, write } from "./fixture/packed.ts"

/* a bundle's bytes are the Bun's that builds it: the pinned one CI runs, never PATH's (skipped without it, required
 * under HONEY_REQUIRE_TOOLCHAINS) */
const BUN = withPinnedBun()

const files = scratch("runtime-bundle")
let tarballs: Tarballs
let full = ""

/* a marker per optional runtime feature: present only when the feature is bundled */
const OPTIONAL_FEATURES: Readonly<Record<string, string>> = {
	"i18n (ICU plural rules)": "PluralRules",
	"openapi docs (swagger)": "swagger-ui",
	"proxy()": "proxy-authenticate",
	"realtime()": "realtime limits.",
}

/*
 * what a build-time or Node-only package leaves in a bundle, by its own text rather than a region path (a linked
 * package is inlined without one); under a Worker's conditions ws resolves to its browser stub, which throws
 */
const BUILD_TIME: Readonly<Record<string, RegExp>> = {
	"@lovrozagar/honey-codegen": /honey-codegen/,
	jiti: /\bjiti\b|createJiti/,
	oxfmt: /oxfmt/,
	"ts-morph": /ts-morph/,
	ws: /WebSocketServer|ws does not work in the browser/,
}

beforeAll(() => {
	tarballs = pack(files.out)
	full = consumer(
		join(files.out, "full"),
		{ "@lovrozagar/honey": `file:${tarballs.core}`, "@lovrozagar/honey-codegen": `file:${tarballs.gen}` },
		["ws", "oxfmt", "ts-morph"],
	)
}, 180_000)
afterAll(() => files.done())

/* the WebSocket route's modules, which an app reaches through ws(app, path) or realtime() alone */
const WS_ROUTE = ["routing/ws-builder", "ws/origin", "ws/session", "ws/shared"]

/* the MCP mount's module, which an app reaches through mcp(app, path, handler) alone (bit 21 e, H24.3) */
const MCP_ROUTE = ["mcp/mount"]

function bunBundle(name: string, lines: readonly string[], minify = true): string {
	write(full, { [`${name}.ts`]: lines.join("\n") })
	const flags = minify ? ["--minify"] : []
	const built = run(
		BUN as string,
		["build", `${name}.ts`, "--outfile", `${name}.js`, ...flags, "--target", "bun"],
		full,
	)
	expect(built.code, built.out).toBe(0)
	return readFileSync(join(full, `${name}.js`), "utf8")
}

/** The WebSocket route modules an unminified build carries, by their region comments (minifying inlines ws/shared's constant). */
function wsRouteModules(name: string, lines: readonly string[]): string[] {
	return routeModules(name, lines, WS_ROUTE)
}

/** Which of `modules` an unminified build of `lines` carries, by their region comments. */
function routeModules(name: string, lines: readonly string[], modules: readonly string[]): string[] {
	const js = bunBundle(`${name}-plain`, lines, false)
	return modules.filter((path) => js.includes(`/dist/${path}.js\n`))
}

describe("the runtime bundle of an installed core (bit 19 i)", () => {
	// v0: 9b6d30d576
	it.skipIf(!BUN)(
		`bun ${pinnedBunVersion()} build of honey() leaves out tooling and every optional runtime feature`,
		() => {
			const entry = [
				'import { honey } from "@lovrozagar/honey"',
				'const app = honey().get("/json").handler((ctx) => ctx.res.json("ok", { ok: true }))',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			const js = bunBundle("minimal", entry)
			const leaked = Object.entries({ ...BUILD_TIME, effect: /\beffect\b/, "node:http": /createServer/ })
				.filter(([, marker]) => marker.test(js))
				.map(([name]) => name)
			const features = Object.entries(OPTIONAL_FEATURES)
				.filter(([, marker]) => js.includes(marker))
				.map(([name]) => name)
			/*
			 * what the wire carries: the router, context, responses and telemetry, measured 26,155 bytes gzipped (level 9,
			 * the pinned bun 1.3.11 --minify), locked at the next 100; under v0's 26,500 lock (v0's own bundle measures
			 * 26,243 the same way). Bit 19 i2 cut the WebSocket route builder's 1,120 bytes (27,275 before): ws(app, path)
			 * is an import, so routing/ws-builder, ws/origin, ws/session and ws/shared stay out until it is called.
			 */
			const gzipped = gzipSync(js, { level: 9 }).length
			const builtBy = run(BUN as string, ["--version"], full).out.trim()
			expect(
				[leaked, features, routeModules("minimal", entry, [...WS_ROUTE, ...MCP_ROUTE]), gzipped < 26_200, builtBy],
				`${gzipped} bytes gzipped`,
			).toEqual([[], [], [], true, pinnedBunVersion()])
		},
		60_000,
	)

	// v0: 97adf5131b
	it.skipIf(!BUN)(
		`a feature is bundled once its entry is imported (bun ${pinnedBunVersion()})`,
		() => {
			const entry = [
				'import { honey } from "@lovrozagar/honey"',
				'import { errorI18n } from "@lovrozagar/honey/i18n"',
				'import { swagger } from "@lovrozagar/honey/openapi"',
				'import { proxy } from "@lovrozagar/honey/proxy"',
				'import { realtime } from "@lovrozagar/honey/realtime"',
				"const app = honey()",
				'\t.errorI18n(errorI18n({ errors: {}, resolveLocale: () => "en" }))',
				'\t.get("/docs").handler(swagger({ url: "/openapi.json" }))',
				'\t.all("/up/*rest").handler(proxy({ destination: (_c, url, init) => fetch(`http://upstream${url}`, init) }))',
				'realtime(app, "/rt", { handler: () => {} })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			const js = bunBundle("features", entry)
			const missing = Object.entries(OPTIONAL_FEATURES)
				.filter(([, marker]) => !js.includes(marker))
				.map(([name]) => name)
			const sockets = [
				'import { honey } from "@lovrozagar/honey"',
				'import { ws } from "@lovrozagar/honey/ws"',
				"const app = honey()",
				'ws(app, "/live").handler({})',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			const mounted = [
				'import { honey } from "@lovrozagar/honey"',
				'import { mcp } from "@lovrozagar/honey/mcp"',
				"const app = honey()",
				'mcp(app, "/mcp", { challenge: "Bearer", fetch: async () => new Response(null), secured: false })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			expect([
				missing,
				wsRouteModules("features", entry),
				wsRouteModules("sockets", sockets),
				routeModules("features", entry, MCP_ROUTE),
				routeModules("mounted", mounted, MCP_ROUTE),
			]).toEqual([[], WS_ROUTE, WS_ROUTE, [], MCP_ROUTE])
		},
		60_000,
	)

	it("a Worker built by the build plugin carries none of ts-morph, ws, oxfmt, jiti or honey-codegen", async () => {
		write(full, {
			"src/worker-app.ts": [
				'import { honey } from "@lovrozagar/honey"',
				'import { serveOpenApi } from "@lovrozagar/honey/openapi"',
				'import { realtime } from "@lovrozagar/honey/realtime"',
				'import { cfWebSocket } from "@lovrozagar/honey/ws/cloudflare"',
				"",
				"export const app = serveOpenApi(",
				'\thoney().wsAdapter(cfWebSocket()).get("/health").handler((ctx) => ctx.res.text("ok", "ok")),',
				'\t{ title: "Worker", version: "1.0.0" },',
				")",
				'realtime(app, "/live", { handler: () => {} })',
				"",
			].join("\n"),
		})
		const outDir = join(full, "worker")
		const { createBuildPlugin } = (await import(
			join(full, "node_modules/@lovrozagar/honey/dist/build/index.js")
		)) as typeof import("../../src/build/index.ts")
		const { build } = await import("vite")
		await build({
			configFile: false,
			logLevel: "error",
			plugins: [
				createBuildPlugin(
					{ minify: false, outDir, target: "cloudflare" },
					{ entry: "src/worker-app.ts", export: "app" },
				),
			],
			root: full,
		})
		const bundled = readdirSync(outDir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
			.join("\n")
		const leaked = Object.entries(BUILD_TIME)
			.filter(([, marker]) => marker.test(bundled))
			.map(([name]) => name)
		/* the app is in it: the bundle is the one built, not an empty one */
		expect([leaked, bundled.includes("realtime limits.")]).toEqual([[], true])
	}, 90_000)

	it("a core-only install loads the plugin, and only a generation names the missing honey-codegen", () => {
		const dir = consumer(join(files.out, "core-only"), { "@lovrozagar/honey": `file:${tarballs.core}` })
		write(dir, {
			"plugin.mjs": [
				'import { honey } from "@lovrozagar/honey/plugin"',
				'console.log([honey({ app: "src/app.ts" })].flat().map((plugin) => plugin.name).join())',
				"",
			].join("\n"),
			"src/app.ts":
				'import { honey } from "@lovrozagar/honey"\nexport const app = honey().get("/health").handler((ctx) => ctx.res.text("ok", "ok"))\n',
		})
		const loaded = run("node", ["plugin.mjs"], dir)
		const generated = run("node", ["node_modules/.bin/honey", "generate", "--app", "src/app.ts", "--tree"], dir)
		expect(
			[loaded.out.trim(), generated.code, generated.out.includes("needs @lovrozagar/honey-codegen")],
			generated.out,
		).toEqual(["honey", 1, true])
	}, 60_000)
})
