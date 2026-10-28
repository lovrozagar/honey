/**
 * What ships (bit 19 i): the real tarballs of `@lovrozagar/honey` and `@lovrozagar/honey-codegen`, packed by npm and
 * installed into a consumer outside the repo. The install carries every export's files, type-checks against every
 * core subpath under maximal strictness, runs both bins from dist/, and generates an app's artifacts through the
 * tarball's own `build/artifacts` (generate.ts `artifactsFor`). A bin picks dist/ in an install and the source in a
 * checkout; `ws`, core's optional peer, fails with an install hint until it is installed, then works in that process.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CORE, consumer, pack, REPO, run, scratch, type Tarballs, write } from "./fixture/packed.ts"

const TSC = join(REPO, "node_modules/typescript/bin/tsc")
const files = scratch("packaging")
let tarballs: Tarballs
let app = ""

const APP = [
	'import { createMiddleware, defineErrors, honey } from "@lovrozagar/honey"',
	'import { cors } from "@lovrozagar/honey/cors"',
	'import { serveOpenApi } from "@lovrozagar/honey/openapi"',
	'import { requestId } from "@lovrozagar/honey/request-id"',
	'import * as z from "zod"',
	"",
	'const errors = defineErrors({ item_not_found: "not_found" })',
	"",
	"export const app = serveOpenApi(",
	"\thoney<{}>()",
	"\t\t.errorFactory(errors)",
	"\t\t.use(requestId())",
	'\t\t.use(cors({ origin: "http://app.test" }))',
	'\t\t.use(createMiddleware((_ctx, next) => next({ userId: "u-1" })))',
	'\t\t.get("/health")',
	'\t\t.handler((ctx) => ctx.res.text("ok", "ok"))',
	'\t\t.post("/items")',
	"\t\t.input({ json: z.object({ name: z.string() }) })",
	'\t\t.output({ "application/json": { created: z.object({ name: z.string(), userId: z.string() }) } })',
	'\t\t.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name, userId: ctx.userId })),',
	'\t{ title: "Consumer", version: "1.0.0" },',
	")",
	"",
].join("\n")

/* the generated selectors narrow `RouteSelectorOf` through the root entry's re-export, or the expect-error is unused */
const SELECTORS = [
	'import type { RouteSelectorOf } from "@lovrozagar/honey"',
	"",
	'export const health: RouteSelectorOf = "GET /health"',
	"// @ts-expect-error a route the app does not have",
	'export const missing: RouteSelectorOf = "GET /missing"',
	"",
].join("\n")

const STRICT = {
	allowUnreachableCode: false,
	allowUnusedLabels: false,
	exactOptionalPropertyTypes: true,
	isolatedModules: true,
	noEmit: true,
	noFallthroughCasesInSwitch: true,
	noImplicitOverride: true,
	noImplicitReturns: true,
	noPropertyAccessFromIndexSignature: true,
	noUncheckedIndexedAccess: true,
	noUncheckedSideEffectImports: true,
	noUnusedLocals: true,
	noUnusedParameters: true,
	/* the package's own declarations are checked under these flags too */
	skipLibCheck: false,
	strict: true,
	target: "ESNext",
	types: ["node"],
	verbatimModuleSyntax: true,
}

type Exports = Record<string, Record<string, string> | string>
const manifest = (pkg: string, dir = app): { exports: Exports } =>
	JSON.parse(readFileSync(join(dir, "node_modules", pkg, "package.json"), "utf8")) as { exports: Exports }

/* every core subpath re-exported from `dir`'s src, type-checked under STRICT: the subpath count, tsc's code and output */
function strictCheck(dir: string, resolution: string, module: string): [number, number, string] {
	const subpaths = Object.keys(manifest("@lovrozagar/honey", dir).exports).filter((s) => s !== "./package.json")
	const lines = subpaths.map((s, i) => `export * as s${i} from "@lovrozagar/honey${s.slice(1)}"`)
	const config = { compilerOptions: { ...STRICT, module, moduleResolution: resolution }, include: ["src/**/*.ts"] }
	write(dir, { "src/subpaths.ts": `${lines.join("\n")}\n`, "tsconfig.json": `${JSON.stringify(config, null, 2)}\n` })
	const checked = run("node", [TSC, "-p", "tsconfig.json"], dir)
	return [subpaths.length, checked.code, checked.out]
}

beforeAll(() => {
	tarballs = pack(files.out)
	app = consumer(
		join(files.out, "app"),
		{ "@lovrozagar/honey": `file:${tarballs.core}`, "@lovrozagar/honey-codegen": `file:${tarballs.gen}` },
		["zod", "@types/node", "vite"],
	)
	write(app, { "src/app.ts": APP, "src/selectors.ts": SELECTORS })
}, 180_000)
afterAll(() => files.done())

describe.sequential("the tarballs, installed (bit 19 i)", () => {
	it("publish manifests with no workspace: or catalog: specifier, each dev pin at its repo version", () => {
		const published = Object.values(tarballs).map((tarball) => {
			const manifest = run("tar", ["-xOzf", tarball, "package/package.json"], files.out)
			return JSON.parse(manifest.out) as { devDependencies: Record<string, string>; name: string }
		})
		const unresolved = published.flatMap(
			({ name, ...fields }) =>
				JSON.stringify(fields)
					.match(/"(?:workspace|catalog):[^"]*"/g)
					?.map((spec) => `${name} ${spec}`) ?? [],
		)
		const [core] = published
		expect([unresolved, core?.devDependencies["@lovrozagar/honey-codegen"], core?.devDependencies.typescript]).toEqual([
			[],
			"1.0.0",
			"7.0.2",
		])
	})

	it("carry bin/, dist/, the README and the license but no source, and every export's files", () => {
		const missing: string[] = []
		for (const pkg of ["@lovrozagar/honey", "@lovrozagar/honey-codegen"]) {
			const root = join(app, "node_modules", pkg)
			for (const [subpath, target] of Object.entries(manifest(pkg).exports)) {
				/* every condition an install resolves; honey-source is the checkout's */
				const conditions = typeof target === "string" ? { default: target } : target
				for (const [condition, file] of Object.entries(conditions))
					if (condition !== "honey-source" && !existsSync(join(root, file))) missing.push(`${subpath} ${file}`)
			}
		}
		expect([readdirSync(join(app, "node_modules/@lovrozagar/honey")).sort(), missing]).toEqual([
			["LICENSE", "README.md", "bin", "dist", "package.json"],
			[],
		])
		expect(readdirSync(join(app, "node_modules/@lovrozagar/honey-codegen")).sort()).toEqual([
			"LICENSE",
			"README.md",
			"bin",
			"dist",
			"package.json",
		])
	})

	it("honey generate in the install writes the app's artifacts through the tarball's dist/build/artifacts", () => {
		const generated = run(
			"node",
			["node_modules/.bin/honey", "generate", "--app", "src/app.ts", "--tree", "--types"],
			app,
		)
		const tree = join(app, "src/_gen/routes.gen.ts")
		expect([generated.code, existsSync(tree), existsSync(join(app, "src/_gen/types.gen.d.ts"))], generated.out).toEqual(
			[0, true, true],
		)
		expect(readFileSync(tree, "utf8")).toContain('"health"')
	}, 60_000)

	/* Vite's own Node chunk makes follow-redirects' errors with a non-Error captureStackTrace at load: on Bun, once jiti's
	 * Babel has hooked Error.prepareStackTrace, that throws "First argument must be an Error object" (bit 20 k-fix) */
	it("honey generate on Bun in the install, a cold jiti cache, reads a config importing vite, a throwing one once", () => {
		const cold = join(files.out, "cold-tmp")
		mkdirSync(cold)
		const generate = () =>
			run("bun", ["node_modules/.bin/honey", "generate"], app, { HONEY_NO_BUN_HANDOFF: "1", TMPDIR: cold })
		const log = join(app, "evaluations.log")
		try {
			write(app, {
				"vite.config.ts":
					'import { defaultClientConditions } from "vite"\nimport { honey } from "@lovrozagar/honey/plugin"\nexport default { resolve: { conditions: [...defaultClientConditions] }, plugins: [honey({ app: "src/app.ts" })] }\n',
			})
			const read = generate()
			write(app, {
				"vite.config.ts": `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, "x")\nthrow new Error("boom at load")\n`,
			})
			const thrown = generate()
			expect([
				read.code,
				read.out.split("\n")[0],
				thrown.code,
				thrown.out.split("\n")[0],
				readFileSync(log, "utf8"),
			]).toEqual([0, "honey: generated", 1, "honey: generation failed: boom at load", "x"])
		} finally {
			rmSync(join(app, "vite.config.ts"), { force: true })
			rmSync(log, { force: true })
		}
	}, 60_000)

	it.each([
		["Bundler", "ESNext"],
		["NodeNext", "NodeNext"],
	])(
		"type-checks against every core subpath, the generated types included, with %s resolution and every strict flag",
		(resolution, module) => {
			expect(strictCheck(app, resolution, module)).toEqual([44, 0, ""])
		},
		60_000,
	)

	it("type-checks against every core subpath with honey-codegen, an optional peer, not installed", () => {
		const dir = consumer(join(files.out, "core-only"), { "@lovrozagar/honey": `file:${tarballs.core}` }, [
			"@types/node",
		])
		expect(strictCheck(dir, "Bundler", "ESNext")).toEqual([44, 0, ""])
	}, 60_000)

	it("honey-codegen in the install generates a TypeScript SDK from the app, its runtime files read from dist/", () => {
		const generated = run(
			"node",
			["node_modules/.bin/honey-codegen", "generate", "--app", "src/app.ts", "--target", "ts", "--out", "sdk"],
			app,
		)
		expect([generated.code, existsSync(join(app, "sdk/ts/.honey-generated.json"))], generated.out).toEqual([0, true])
	}, 60_000)
})

/* the bin's own file in a package laid out as an install (no tsconfig.json) or a checkout, each entry marked */
let layouts = 0
function binLayout(bin: string, entry: string, checkout: boolean): string {
	const dir = join(files.out, `bin-${bin}-${checkout ? "checkout" : "install"}-${++layouts}`)
	const main = (from: string) => `export function main() {\n\tconsole.log(${JSON.stringify(from)})\n\treturn 0\n}\n`
	const pkg = bin === "honey" ? CORE : join(CORE, "../gen")
	write(dir, {
		[`bin/${bin}.js`]: readFileSync(join(pkg, `bin/${bin}.js`), "utf8"),
		[`dist/${entry}.js`]: main("dist"),
		"node_modules/@lovrozagar/honey-codegen/package.json": '{ "exports": { "./package.json": "./package.json" } }\n',
		"package.json": '{ "type": "module" }\n',
		[`src/${entry}.ts`]: main("source").replace("main()", "main(): number"),
		...(checkout ? { "tsconfig.json": "{}\n" } : {}),
	})
	mkdirSync(join(dir, "node_modules"), { recursive: true })
	symlinkSync(join(REPO, "node_modules/jiti"), join(dir, "node_modules/jiti"), "dir")
	return dir
}

/* as a user starts it: not a child of `bun run`, which would hand over to Bun */
function runBin(runtime: string, dir: string, bin: string): string {
	return run(runtime, [join(dir, `bin/${bin}.js`)], dir, { npm_config_user_agent: "", npm_execpath: "" }).out.trim()
}

describe("each shipped bin picks what it runs (bit 19 i)", () => {
	const BINS = [
		["honey", "build/cli"],
		["honey-codegen", "cli"],
	] as const

	// v0: 4982f5f697
	it.each(BINS)("%s on Node in a repository checkout runs the source, never a possibly stale dist/", (bin, entry) => {
		expect(runBin("node", binLayout(bin, entry, true), bin)).toBe("source")
	})

	// v0: 13cea3f296
	it.each(BINS)("%s on Node in an installed package (no tsconfig.json) runs the compiled dist/", (bin, entry) => {
		expect(runBin("node", binLayout(bin, entry, false), bin)).toBe("dist")
	})

	it.each(BINS)("%s on Bun in an installed package runs dist/ too: the tarball ships no source", (bin, entry) => {
		expect(runBin("bun", binLayout(bin, entry, false), bin)).toBe("dist")
	})
})

describe("ws, core's optional peer, in a real install (bit 19 i)", () => {
	/* one process: the upgrade fails naming the package, `npm install ws` runs, and the next upgrade works */
	const SERVER = [
		'import { execFileSync } from "node:child_process"',
		'import { honey } from "@lovrozagar/honey"',
		'import { serve } from "@lovrozagar/honey/serve"',
		'import { ws } from "@lovrozagar/honey/ws"',
		"const app = honey()",
		'ws(app, "/live").handler({ onMessage: (_ctx, ws, data) => ws.send(data) })',
		'const server = await serve(app, { hostname: "127.0.0.1", port: 0 })',
		"const echo = () => new Promise((done) => {",
		"\tconst client = new WebSocket(`ws://127.0.0.1:${server.port}/live`)",
		'\tclient.onopen = () => client.send("hi")',
		"\tclient.onmessage = (e) => { done(`echo ${e.data}`); client.close() }",
		'\tclient.onerror = () => done("refused")',
		"})",
		"const before = await echo()",
		'execFileSync("npm", ["install", "ws@8.21.0", "--no-audit", "--no-fund", "--prefer-offline", "--silent"])',
		"const after = await echo()",
		"console.log(`result ${JSON.stringify({ after, before })}`)",
		"await server.close(100)",
		"",
	].join("\n")

	// v0: ddd820848a
	it("fails the upgrade with an install hint without ws, and works once ws is installed (not cached)", () => {
		const dir = consumer(join(files.out, "ws"), { "@lovrozagar/honey": `file:${tarballs.core}` })
		writeFileSync(join(dir, "server.mjs"), SERVER)
		/* a served app's environment: NODE_ENV=test, which this runner sets, silences the default logger */
		const ran = run("node", ["server.mjs"], dir, { NODE_ENV: "production" })
		const line = ran.out.split("\n").find((l) => l.startsWith("result ")) ?? "result {}"
		const hinted = ran.out.split("result ")[0]?.includes("npm install ws")
		expect([JSON.parse(line.slice(7)), hinted], ran.out).toEqual([{ after: "echo hi", before: "refused" }, true])
	}, 90_000)
})
