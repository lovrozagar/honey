/**
 * Anyrow's gateway, in shape (bit 19 h2, §9 item 10 and its conditions, the gateway contract as re-ruled): three
 * services merged by `mergeTree`; a served gateway app with its own routes and errors that loads its own generated
 * tree, stale in one service's leaves as on a new downstream route; and its Vite config's three OpenAPI outputs
 * (internal: every route and scheme; contract: a filterRoutes subset reading `route.meta`, two schemes; public: the
 * API-key routes, sanitized of the internal schemes, the jwt requirements and every x- key). `honey generate` writes
 * the tree (the services' routes plus the gateway's) and the documents from the served gateway; each document's
 * operations, schemes and keys are its own; and `honey-codegen generate --spec` builds an SDK from a filtered one.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { main as codegen } from "../../../gen/src/cli.ts"
import { project, type Project } from "../../src/build/__fixtures__/project.ts"
import { main } from "../../src/build/cli.ts"

const quiet = { err: () => {}, out: () => {} }
const projects: Project[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.done()
})

/** A service: its routes, each with its security and the meta the gateway's filters read. */
const service = (name: string, routes: readonly (readonly [string, string | string[], string])[]) =>
	[
		'import { honey } from "@lovrozagar/honey"',
		`export const ${name} = honey()`,
		...routes.map(
			([path, security, kind]) =>
				`\t.get(${JSON.stringify(path)}).meta({ kind: ${JSON.stringify(kind)}, security: ${JSON.stringify(security)} } as never).handler((c) => c.res.text("ok", "ok"))`,
		),
		"",
	].join("\n")

const SCHEMES = `{
	apiKey: { in: "header", name: "Authorization", type: "apiKey" },
	iaActor: { in: "header", name: "x-ia-actor", type: "apiKey" },
	iaKey: { in: "header", name: "x-ia-key", type: "apiKey" },
	jwt: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
}`

const MERGE = (names: readonly string[]) =>
	`mergeTree(${names.map((name) => `[${name}.toRouteTree(), { worker: "${name}" }]`).join(", ")})`

const FILES = {
	"src/extract.ts": service("extract", [
		["/extract/jobs", ["apiKey", "jwt"], "public"],
		["/extract/admin", "iaKey", "internal"],
	]),
	/* anyrow.gateway.app.ts: its own routes and errors, and the catch-all its services' routes delegate to */
	"src/gateway.ts": [
		'import { defineErrors, honey } from "@lovrozagar/honey"',
		"export function createGateway(tree?: unknown) {",
		'\tconst app = honey().errorFactory(defineErrors({ maintenance: "service_unavailable" }))',
		"\tif (tree !== undefined) app.routeTree(tree as never)",
		'\tapp.metaSpec({ meta: { kind: "x-kind", worker: false } } as never)',
		'\tapp.get("/health").errors("maintenance").handler((c) => c.res.text("ok", "up"))',
		'\tapp.get("/robots.txt").handler((c) => c.res.text("ok", "User-agent: *"))',
		'\tapp.all("/*").handler((c) => c.res.text("ok", "forwarded"))',
		"\treturn app",
		"}",
		"",
	].join("\n"),
	/* anyrow.gateway.app.ts:22,87: the served gateway loads its own generated tree */
	"src/gateway.app.ts":
		'import { routeTree } from "./_gen/routes.gen.ts"\nimport { createGateway } from "./gateway.ts"\nexport const app = createGateway(routeTree)\n',
	"src/growth.ts": service("growth", [
		["/growth/contracts", "jwt", "contract"],
		["/growth/actors", "iaActor", "internal"],
	]),
	"src/route-tree.ts": [
		'import { mergeTree } from "@lovrozagar/honey"',
		'import { extract } from "./extract.ts"',
		'import { growth } from "./growth.ts"',
		'import { saas } from "./saas.ts"',
		`export const tree = ${MERGE(["extract", "growth", "saas"])}`,
		"",
	].join("\n"),
	"src/saas.ts": service("saas", [
		["/saas/projects", "apiKey", "public"],
		["/saas/billing", "jwt", "contract"],
	]),
	/* the tree as it stood before saas joined, with the gateway built without its tree: seeds the served one's */
	"src/seed.ts": [
		'import { mergeTree } from "@lovrozagar/honey"',
		'import { extract } from "./extract.ts"',
		'import { createGateway } from "./gateway.ts"',
		'import { growth } from "./growth.ts"',
		`export const tree = ${MERGE(["extract", "growth"])}`,
		"export const app = createGateway()",
		"",
	].join("\n"),
	"vite.config.ts": `import { honey } from "@lovrozagar/honey/plugin"

const isContractRoute = (meta) => meta.kind === "contract"
const hasApiKey = (meta) => [meta.security].flat().includes("apiKey")

export default {
	plugins: [
		honey({
			app: "src/gateway.app.ts",
			codegen: {
				mergeTree: "src/route-tree.ts",
				openApi: [
					{ path: "src/_gen/openapi.gen.json", securitySchemes: ${SCHEMES}, title: "Anyrow API (internal)", version: "1.0.0" },
					{
						filterRoutes: (route) => isContractRoute(route.meta),
						path: "src/_gen/openapi.contract.gen.json",
						securitySchemes: { apiKey: { in: "header", name: "Authorization", type: "apiKey" }, jwt: { bearerFormat: "JWT", scheme: "bearer", type: "http" } },
						title: "Anyrow API (contract)",
						version: "1.0.0",
					},
					{
						filterRoutes: (route) => hasApiKey(route.meta),
						path: "src/_gen/openapi.public.gen.json",
						sanitize: { stripSecurityRequirements: ["jwt"], stripSecuritySchemes: ["iaKey", "iaActor"], stripXExtensions: true },
						securitySchemes: ${SCHEMES},
						title: "Anyrow API",
						version: "1.0.0",
					},
				],
			},
			watch: ["src/**/*.ts"],
		}),
	],
}
`,
}

type Operation = Record<string, unknown> & { responses?: Record<string, unknown> }
type Document = {
	components?: { securitySchemes?: Record<string, unknown> }
	info: { title: string }
	paths: Record<string, { get: Operation }>
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8")
const documentAt = (dir: string, name: string) => JSON.parse(read(dir, `src/_gen/${name}`)) as Document
/** Each operation's path, security and whether it carries any x- key, by path (a document lists them in tree order). */
const operations = (document: Document) =>
	Object.entries(document.paths)
		.map(
			([path, item]) => [path, item.get.security, Object.keys(item.get).some((key) => key.startsWith("x-"))] as const,
		)
		.sort(([a], [b]) => (a < b ? -1 : 1))
const schemes = (document: Document) => Object.keys(document.components?.securitySchemes ?? {})

/** The project with its served gateway's tree seeded, stale in saas's leaves alone (Anyrow's state on a new route). */
async function seeded(): Promise<Project> {
	const made = project(FILES)
	projects.push(made)
	let seedErr = ""
	expect([
		await main(
			["generate", "--merge-tree", "src/seed.ts"],
			{ err: (t) => void (seedErr += t), out: () => {} },
			{ cwd: made.dir, env: {} },
		),
		seedErr,
	]).toEqual([0, ""])
	expect(read(made.dir, "src/_gen/routes.gen.ts")).not.toContain("/saas/")
	return made
}

describe("an Anyrow-shaped gateway (bit 19 h2)", () => {
	it("writes its tree and three documents from the served gateway, each with only its own routes, schemes and sanitizing", async () => {
		const made = await seeded()
		let err = ""
		const status = await main(
			["generate"],
			{ err: (text) => void (err += text), out: () => {} },
			{ cwd: made.dir, env: {} },
		)
		expect([status, err]).toEqual([0, ""])
		/* the tree: every service's routes, saas's new ones included, and the gateway's own */
		expect(read(made.dir, "src/_gen/routes.gen.ts")).toMatch(
			/"GET \/saas\/billing"[\s\S]*"GET \/health"[\s\S]*"GET \/robots\.txt"/,
		)
		const [internal, contract, published] = [
			"openapi.gen.json",
			"openapi.contract.gen.json",
			"openapi.public.gen.json",
		].map((name) => documentAt(made.dir, name)) as [Document, Document, Document]
		expect(operations(internal)).toEqual([
			["/extract/admin", [{ iaKey: [] }], true],
			["/extract/jobs", [{ apiKey: [] }, { jwt: [] }], true],
			["/growth/actors", [{ iaActor: [] }], true],
			["/growth/contracts", [{ jwt: [] }], true],
			["/health", undefined, true],
			["/robots.txt", undefined, true],
			["/saas/billing", [{ jwt: [] }], true],
			["/saas/projects", [{ apiKey: [] }], true],
		])
		/* the gateway's own errors and its own metaSpec, which only the served gateway carries */
		expect(Object.keys(internal.paths["/health"]?.get.responses ?? {})).toEqual(["503"])
		expect([internal.paths["/extract/jobs"]?.get["x-kind"], contract.paths["/saas/billing"]?.get["x-kind"]]).toEqual([
			"public",
			"contract",
		])
		expect(operations(contract)).toEqual([
			["/growth/contracts", [{ jwt: [] }], true],
			["/saas/billing", [{ jwt: [] }], true],
		])
		expect(operations(published)).toEqual([
			["/extract/jobs", [{ apiKey: [] }], false],
			["/saas/projects", [{ apiKey: [] }], false],
		])
		expect([internal, contract, published].map(schemes)).toEqual([
			["apiKey", "iaActor", "iaKey", "jwt"],
			["apiKey", "jwt"],
			["apiKey", "jwt"],
		])
		expect([internal, contract, published].map((document) => document.info.title)).toEqual([
			"Anyrow API (internal)",
			"Anyrow API (contract)",
			"Anyrow API",
		])
	}, 60_000)

	it("feeds a filtered document to honey-codegen generate --spec, its SDK holding only that document's operations", async () => {
		const made = await seeded()
		expect(await main(["generate"], quiet, { cwd: made.dir, env: {} })).toBe(0)
		const args = ["generate", "--spec", "src/_gen/openapi.contract.gen.json", "--target", "ts", "--out", "sdk"]
		expect(await codegen(args, quiet, { cwd: made.dir })).toBe(0)
		const sdk = readdirSync(join(made.dir, "sdk/ts"), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
			.join("\n")
		const paths = ["/growth/contracts", "/saas/billing", "/extract/jobs", "/growth/actors", "/health"]
		expect(paths.map((path) => sdk.includes(`"${path}"`))).toEqual([true, true, false, false, false])
	}, 60_000)
})
