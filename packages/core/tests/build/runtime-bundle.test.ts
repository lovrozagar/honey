/**
 * What an app's bundle carries from the installed package (bit 19 i, ported from v0's runtime-bundle.test.ts): the
 * real core tarball, installed beside honey-clients and every optional peer (ws, oxfmt, ts-morph; jiti is core's own
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
	"@lovrozagar/honey-clients": /honey-clients/,
	jiti: /\bjiti\b|createJiti/,
	oxfmt: /oxfmt/,
	"ts-morph": /ts-morph/,
	ws: /WebSocketServer|ws does not work in the browser/,
}

beforeAll(() => {
	tarballs = pack(files.out)
	full = consumer(
		join(files.out, "full"),
		{ "@lovrozagar/honey": `file:${tarballs.core}`, "@lovrozagar/honey-clients": `file:${tarballs.gen}` },
		["ws", "oxfmt", "ts-morph"],
	)
}, 180_000)
afterAll(() => files.done())

/* the WebSocket route's modules, which an app reaches through ws(app, path) or realtime() alone */
const WS_ROUTE = ["routing/ws-builder", "ws/origin", "ws/session", "ws/shared"]
/* the output-key check runs where an app is documented or its tree generated, never on a request (bit 21 f2) */
const GENERATION_ONLY = ["openapi/output-keys"]

/* what a document built ahead of time never needs: the generator and either docs page */
const GENERATOR = ["openapi/generate", "openapi/collect", "openapi/components", "openapi/yaml"]
const PAGES = ["openapi/scalar", "openapi/swagger"]

/* the MCP mount's modules: mcp(app, path, handler) reaches mount alone (bit 21 e, H24.3), oauth() its resource server
 * by an import of its own, so a mount without it carries none of it (bit 21 f, H23), and uploads() and urlFiles() the
 * same (bit 21 g) */
const MCP_ROUTE = ["mcp/mount", "mcp/oauth", "mcp/uploads", "mcp/url-files"]

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
			 * bun 1.3.11's --minify, the pin then), locked at the next 100; under v0's 26,500 lock (v0's own bundle measures
			 * 26,243 the same way). Bit 19 i2 cut the WebSocket route builder's 1,120 bytes (27,275 before): ws(app, path)
			 * is an import, so routing/ws-builder, ws/origin, ws/session and ws/shared stay out until it is called.
			 * rc.5 added 59 bytes (26,186 to 26,245) so a context reached through a prototype chain or a proxy reads
			 * its original's private state: the SELF field, read once in each of the context's nine accessors.
			 * Locked at 26,300. The generated tree's body gate added 58 bytes (26,237 to 26,295): every leaf
			 * carries its declared body as data, and a delegated leaf checks it. The pin's move to bun 1.4.4 measured
			 * the same tree 25,815 (its --minify, not the code): locked at 25,900. Plan 39, measured on its base of 25,897:
			 * 5.1 added 32 (25,929) so text, html, csv, xml and binary stream a typed body: one ReadableStream branch in the
			 * body helpers. Locked at 26,000. 5.2 added 265 (26,194) so a handler may return its sole declared body and
			 * status keys alone declare JSON: the body wrap, the media type to helper map and the shorthand's
			 * normalization, all reached from RouteBuilder methods. Locked at 26,200. 5.3 took 25 off (26,169): no numeric
			 * status. 5.4 added 267 (26,436) so params take a schema per param onto ctx.params: the per-param validation
			 * with one 400 naming every refused param and an async validator awaited, the registration check that a key is
			 * a param of the path, and the read that places the values. Locked at 26,500. 5.5 took 8 off (26,428). 5.6
			 * added 69 (26,497) so routeTree() returns a new app: the settings copy and the replay of every registered
			 * route onto the tree's graph. 7.1 added 27 (26,496 to 26,523) so honey(preset) starts an app from a preset:
			 * the call through the SEED slot and its symbol; the app's build from the preset lives in preset.ts, out of an
			 * app that defines none. Locked at 26,600. 5.7 added 180 (26,516 to 26,696) so ctx.res.forward() answers a
			 * Response whose status is decided elsewhere: the method and its forwarded marker, the check every .output()
			 * route runs on a forwarded answer (its status a declared key, its media type declared there), and json and
			 * sse taking an encoded stream. Locked at 26,800.
			 */
			const gzipped = gzipSync(js, { level: 9 }).length
			const builtBy = run(BUN as string, ["--version"], full).out.trim()
			expect(
				[
					leaked,
					features,
					routeModules("minimal", entry, [...WS_ROUTE, ...MCP_ROUTE, ...GENERATION_ONLY]),
					gzipped < 26_800,
					builtBy,
				],
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
				'import { createErrorTranslator } from "@lovrozagar/honey/i18n"',
				'import { swagger } from "@lovrozagar/honey/openapi/swagger"',
				'import { proxy } from "@lovrozagar/honey/proxy"',
				'import { realtime } from "@lovrozagar/honey/realtime"',
				"const app = honey()",
				'\t.errorI18n(createErrorTranslator({ errors: {}, resolveLocale: () => "en" }))',
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
			const protectedMount = [
				'import { honey } from "@lovrozagar/honey"',
				'import { mcp } from "@lovrozagar/honey/mcp"',
				'import { oauth } from "@lovrozagar/honey/mcp/oauth"',
				"const app = honey()",
				'const handler = { challenge: "Bearer", fetch: async () => new Response(null), secured: false }',
				'mcp(app, "/mcp", handler, { authenticate: () => true, oauth: oauth({ authorizationServers: ["https://as.example"] }) })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			const filesMount = [
				'import { honey } from "@lovrozagar/honey"',
				'import { mcp } from "@lovrozagar/honey/mcp"',
				'import { memoryUploadStore, uploads } from "@lovrozagar/honey/mcp/uploads"',
				'import { urlFiles } from "@lovrozagar/honey/mcp/url-files"',
				"const app = honey()",
				'const handler = { challenge: "Bearer", fetch: async () => new Response(null), secured: false }',
				"const store = memoryUploadStore()",
				'mcp(app, "/mcp", handler, { uploads: uploads({ secret: "s".repeat(32), store }), urlFiles: urlFiles({ hosts: ["files.example"] }) })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			expect([
				missing,
				wsRouteModules("features", entry),
				wsRouteModules("sockets", sockets),
				routeModules("features", entry, MCP_ROUTE),
				routeModules("mounted", mounted, MCP_ROUTE),
				routeModules("protected", protectedMount, MCP_ROUTE),
				routeModules("files", filesMount, MCP_ROUTE),
			]).toEqual([
				[],
				WS_ROUTE,
				WS_ROUTE,
				[],
				["mcp/mount"],
				["mcp/mount", "mcp/oauth"],
				["mcp/mount", "mcp/uploads", "mcp/url-files"],
			])
		},
		60_000,
	)

	it.skipIf(!BUN)(
		`serveStaticOpenApi carries no generator and no page it was not given (bun ${pinnedBunVersion()})`,
		() => {
			const served = [
				'import { honey } from "@lovrozagar/honey"',
				'import { serveStaticOpenApi } from "@lovrozagar/honey/openapi/static"',
				'const app = serveStaticOpenApi(honey(), { json: { asset: "/openapi.json" } })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			const withPage = [
				'import { honey } from "@lovrozagar/honey"',
				'import { scalar } from "@lovrozagar/honey/openapi/scalar"',
				'import { serveStaticOpenApi } from "@lovrozagar/honey/openapi/static"',
				'const app = serveStaticOpenApi(honey(), { docs: { "/docs": scalar }, json: { asset: "/openapi.json" } })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			const generated = [
				'import { honey } from "@lovrozagar/honey"',
				'import { serveOpenApi } from "@lovrozagar/honey/openapi"',
				'const app = serveOpenApi(honey(), { title: "Doc", version: "1.0.0" })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			/*
			 * what serving a document already written costs: the router, context, responses and telemetry, plus
			 * openapi/served and openapi/static. Measured 27,478 bytes gzipped (level 9, the pinned bun
			 * --minify), locked at the next 100. The minimal bundle is 26,245 of that, so serving a document the
			 * app did not generate costs 1,233 bytes: the two modules, and nothing of the generator or a page.
			 * The generated tree's body gate added its 58 bytes here too (27,480 to 27,538). Plan 38 added 166
			 * (27,538 to 27,704) though this call takes no auth: 63 for refusing auth beside a cacheControl at
			 * runtime, 103 for the docs map's two refusals and the guarded branch in answering and mountAll. The
			 * guard itself is basic()'s, so none of it is here. Locked at 27,800. Plan 39 5.6 added 74 (27,752 to
			 * 27,826): routeTree()'s settings copy and route replay, as in the minimal bundle. Locked at 27,900. 7.1
			 * added 18 (27,823 to 27,841): honey(preset)'s call through the SEED slot. 5.7 added 199 (27,836 to
			 * 28,035): ctx.res.forward() and its check, and json and sse taking a stream, as in the minimal bundle.
			 * Locked at 28,100.
			 */
			const gzipped = gzipSync(bunBundle("static-doc", served), { level: 9 }).length
			expect(
				[
					routeModules("static-doc", served, [...GENERATOR, ...PAGES]),
					routeModules("static-page", withPage, [...GENERATOR, ...PAGES]),
					routeModules("generated-doc", generated, PAGES),
					gzipped < 28_100,
				],
				`${gzipped} bytes gzipped`,
			).toEqual([[], ["openapi/scalar"], [], true])
		},
		60_000,
	)

	it.skipIf(!BUN)(
		`a sender of webhooks alone carries none of honey()'s router (bun ${pinnedBunVersion()})`,
		() => {
			const sender = [
				'import { signWebhook, webhookContract } from "@lovrozagar/honey/webhook"',
				'const schema = { "~standard": { validate: (value: unknown) => ({ value }), vendor: "app", version: 1 } } as const',
				"const events = webhookContract({ ping: schema })",
				"export const send = async (secret: string) => [",
				'\tawait events.sign("ping", {}, { id: "msg_1", occurredAt: new Date(), secrets: [secret] }),',
				'\tawait signWebhook({ body: "{}", id: "msg_2", secrets: [secret], timestamp: 1 }),',
				"]",
				"",
			]
			const router = [
				'import { honey } from "@lovrozagar/honey"',
				'const app = honey().get("/json").handler((ctx) => ctx.res.json("ok", { ok: true }))',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			]
			const routing = (js: string) => js.includes("/dist/routing/")
			const sent = bunBundle("webhook-sender-plain", sender, false)
			const features = Object.entries(OPTIONAL_FEATURES)
				.filter(([, marker]) => sent.includes(marker))
				.map(([name]) => name)
			expect([routing(sent), features, routing(bunBundle("webhook-router-plain", router, false))]).toEqual([
				false,
				[],
				true,
			])
		},
		60_000,
	)

	it.skipIf(!BUN)(
		`basic() and credentialsMatch alone carry none of honey()'s router or the generator (bun ${pinnedBunVersion()})`,
		() => {
			const guard = [
				'import { basic, credentialsMatch } from "@lovrozagar/honey/openapi/auth"',
				"export const auth = basic({",
				'\trealm: "Internal",',
				'\tverify: ({ password, username }) => credentialsMatch({ password, username }, { password: "pw", username: "docs" }),',
				"})",
				"",
			]
			const js = bunBundle("openapi-auth-plain", guard, false)
			expect([js.includes("/dist/routing/"), routeModules("openapi-auth", guard, [...GENERATOR, ...PAGES])]).toEqual([
				false,
				[],
			])
		},
		60_000,
	)

	it("a Worker built by the build plugin carries none of ts-morph, ws, oxfmt, jiti or honey-clients", async () => {
		write(full, {
			"src/worker-app.ts": [
				'import { honey } from "@lovrozagar/honey"',
				'import { serveOpenApi } from "@lovrozagar/honey/openapi"',
				'import { realtime } from "@lovrozagar/honey/realtime"',
				'import { workersWebSocket } from "@lovrozagar/honey/ws/workers"',
				"",
				"export const app = serveOpenApi(",
				'\thoney().wsAdapter(workersWebSocket()).get("/health").handler((ctx) => ctx.res.text("ok", "ok")),',
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
				createBuildPlugin({ minify: false, outDir, target: "workers" }, { entry: "src/worker-app.ts", export: "app" }),
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

	it("a core-only install loads the plugin, and only a generation names the missing honey-clients", () => {
		const dir = consumer(join(files.out, "core-only"), { "@lovrozagar/honey": `file:${tarballs.core}` })
		write(dir, {
			"plugin.mjs": [
				'import { honeyPlugin } from "@lovrozagar/honey/plugin"',
				'console.log([honeyPlugin({ app: "src/app.ts" })].flat().map((plugin) => plugin.name).join())',
				"",
			].join("\n"),
			"src/app.ts":
				'import { honey } from "@lovrozagar/honey"\nexport const app = honey().get("/health").handler((ctx) => ctx.res.text("ok", "ok"))\n',
		})
		const loaded = run("node", ["plugin.mjs"], dir)
		const generated = run("node", ["node_modules/.bin/honey", "generate", "--app", "src/app.ts", "--tree"], dir)
		expect(
			[loaded.out.trim(), generated.code, generated.out.includes("needs @lovrozagar/honey-clients")],
			generated.out,
		).toEqual(["honey", 1, true])
	}, 60_000)
})
