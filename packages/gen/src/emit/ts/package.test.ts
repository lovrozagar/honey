/**
 * The TypeScript SDK as a package (plan 39 8.3). node refuses to strip types under node_modules, so the package an npm
 * consumer installs points its exports at compiled JavaScript and declarations; JSR takes the TypeScript sources
 * through jsr.json. Packed by npm and installed offline into a fresh consumer, it imports under node and bun, and a
 * consumer type-checks against its declarations, library checks on, under every strictness flag and both resolutions.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import { hasNpm } from "../mcp/__fixtures__/clients.ts"
import { scratchDir, written } from "../mcp/__fixtures__/written.ts"
import { DOCUMENT, REPO, tsFiles, withPeer } from "./__fixtures__/package-run.ts"
import { compiled } from "./package.ts"

const TSC = join(REPO, "node_modules/typescript/bin/tsc")
const SLOW = { timeout: 4 * SPAWN_TIMEOUT }

/** A file of `files` parsed as JSON. */
const json = (files: Readonly<Record<string, string>>, path: string): unknown => JSON.parse(files[path] ?? "null")

describe("the package files the TS target writes (plan 39 8.3)", () => {
	it("writes a package.json whose exports reach compiled JavaScript and declarations, filled from the run", async () => {
		const files = await tsFiles()
		expect(json(files, "package.json")).toEqual({
			author: "Acme Inc <oss@acme.dev>",
			bugs: "https://github.com/acme/shop-ts/issues",
			description: "The Shop API's client",
			engines: { node: ">=22" },
			exports: {
				".": { default: "./dist/shop.index.gen.js", types: "./dist/shop.index.gen.d.ts" },
				"./tanstack-query": {
					default: "./dist/shop.tanstack-query.gen.js",
					types: "./dist/shop.tanstack-query.gen.d.ts",
				},
				"./webhook": { default: "./dist/shop.webhook.gen.js", types: "./dist/shop.webhook.gen.d.ts" },
			},
			files: ["dist"],
			homepage: "https://acme.dev",
			keywords: ["shop", "api"],
			license: "MIT",
			name: "@acme/shop",
			peerDependencies: { "@tanstack/query-core": "^5.0.0" },
			peerDependenciesMeta: { "@tanstack/query-core": { optional: true } },
			repository: { type: "git", url: "git+https://github.com/acme/shop-ts.git" },
			sideEffects: false,
			type: "module",
			version: "1.2.0",
		})
		const sources = Object.keys(files).filter((path) => /^shop\.[\w-]+\.gen\.ts$/.test(path))
		expect(
			sources
				.flatMap((path) => [
					path.replace(/^/, "dist/").replace(/\.ts$/, ".js"),
					path.replace(/^/, "dist/").replace(/\.ts$/, ".d.ts"),
				])
				.filter((path) => files[path] === undefined),
		).toEqual([])
	})
})

describe("the jsr.json the TS target writes (plan 39 8.3)", () => {
	it("writes a jsr.json over the TypeScript sources for a scoped name, and none without a scope", async () => {
		expect(json(await tsFiles(), "jsr.json")).toEqual({
			exports: {
				".": "./shop.index.gen.ts",
				"./tanstack-query": "./shop.tanstack-query.gen.ts",
				"./webhook": "./shop.webhook.gen.ts",
			},
			compilerOptions: { lib: ["esnext", "dom", "dom.iterable"] },
			imports: { "@tanstack/query-core": "npm:@tanstack/query-core@^5.0.0" },
			license: "MIT",
			name: "@acme/shop",
			publish: { include: ["*.gen.ts"] },
			unstable: ["sloppy-imports"],
			version: "1.2.0",
		})
		const scoped = await tsFiles({ options: { ts: { name: "Shop", packageName: "@acme/bare" } }, targets: ["ts"] })
		expect(Object.keys(json(scoped, "jsr.json") as object)).toEqual([
			"name",
			"version",
			"exports",
			"compilerOptions",
			"unstable",
			"publish",
		])
		const bare = await tsFiles({ options: { ts: { name: "Shop" } }, targets: ["ts"] })
		expect([bare["jsr.json"], json(bare, "package.json")]).toMatchObject([
			undefined,
			{ name: "shop", version: "1.2.0" },
		])
	})
})

describe("what the TS target's package refuses or defaults (plan 39 8.3)", () => {
	it("refuses a package name or version npm would refuse, before generating anything", async () => {
		for (const [option, value] of [
			["packageName", "@Acme/Shop"],
			["packageName", "shop sdk"],
			["version", "1.2"],
		] as const)
			await expect(tsFiles({ options: { ts: { [option]: value } }, targets: ["ts"] })).rejects.toThrow(
				`Invalid ${option}: ${JSON.stringify(value)}`,
			)
	})

	it("takes 0.0.0 when the document's version is not one npm accepts and no version is given", async () => {
		const files = await tsFiles({ targets: ["ts"] }, { ...DOCUMENT, info: { title: "Shop", version: "v1" } })
		expect(json(files, "package.json")).toMatchObject({ name: "sdk", version: "0.0.0" })
	})

	it("refuses a source that does not declare its exported types, naming the file", () => {
		expect(() => compiled("shop.extra.gen.ts", "export const made = [1].map(String)\n", true)).toThrow(
			"shop.extra.gen.ts does not compile: TS9010",
		)
	})
})

/** The package packed by npm and installed offline into a fresh consumer: the consumer's directory. */
function consumer(files: Readonly<Record<string, string>>): string {
	const source = written(files)
	const packs = scratchDir("ts-pack")
	execFileSync("npm", ["pack", "--silent", "--pack-destination", packs], { cwd: source, encoding: "utf8" })
	const tarball = join(packs, readdirSync(packs).find((name) => name.endsWith(".tgz")) as string)
	const dir = scratchDir("ts-consumer")
	writeFileSync(join(dir, "package.json"), '{ "private": true, "type": "module" }\n')
	execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", tarball], { cwd: dir, encoding: "utf8" })
	return withPeer(dir)
}

const IMPORTS = `const sdk = await import("@acme/shop")
const hooks = await import("@acme/shop/webhook")
await import("@acme/shop/tanstack-query")
const shop = new sdk.Shop({ baseURL: "https://shop.example.test" })
console.log(JSON.stringify([shop instanceof sdk.Shop, typeof sdk.isClientError, typeof hooks.verifyWebhook]))`

const CONSUMER = `import { Shop, isClientError, type ShopConfig } from "@acme/shop"
import { verifyWebhook, type WebhookEvent } from "@acme/shop/webhook"
import { createQueryHelpers } from "@acme/shop/tanstack-query"

const config: ShopConfig = { baseURL: "https://shop.example.test" }
const shop = new Shop(config)
export const listed: Promise<unknown> = shop.items.list()
export const failed: (error: unknown) => boolean = isClientError
export const verify: typeof verifyWebhook = verifyWebhook
export type Event = WebhookEvent
export const helpers: typeof createQueryHelpers = createQueryHelpers
`

/** tsc's errors on the consumer under `resolution`, every strictness flag on and library checks on. */
function consumerErrors(dir: string, resolution: "bundler" | "nodenext"): string[] {
	writeFileSync(join(dir, "consumer.ts"), CONSUMER)
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				exactOptionalPropertyTypes: true,
				isolatedModules: true,
				lib: ["ES2023", "DOM", "DOM.Iterable"],
				module: resolution === "bundler" ? "preserve" : "nodenext",
				moduleResolution: resolution,
				noEmit: true,
				noImplicitOverride: true,
				noPropertyAccessFromIndexSignature: true,
				noUncheckedIndexedAccess: true,
				skipLibCheck: false,
				strict: true,
				target: "ES2023",
				types: [],
				verbatimModuleSyntax: true,
			},
			files: ["consumer.ts"],
		}),
	)
	const run = spawnSync(TSC, ["-p", dir], { encoding: "utf8" })
	return `${run.stdout}${run.stderr}`.split("\n").filter((line) => / error TS\d+/.test(line))
}

describe.skipIf(!hasNpm())("the TS SDK installed as a package (plan 39 8.3)", SLOW, () => {
	it("imports under node and bun from its compiled JavaScript, and type-checks under both resolutions", async () => {
		const dir = consumer(await tsFiles())
		const ran = (command: string, args: string[]) =>
			spawnSync(command, args, { cwd: dir, encoding: "utf8", timeout: SPAWN_TIMEOUT })
		const node = ran(process.execPath, ["--input-type=module", "-e", IMPORTS])
		const bun = ran("bun", ["-e", IMPORTS])
		expect([node.stderr, node.stdout, bun.stderr, bun.stdout]).toEqual([
			"",
			'[true,"function","function"]\n',
			"",
			'[true,"function","function"]\n',
		])
		expect([consumerErrors(dir, "nodenext"), consumerErrors(dir, "bundler")]).toEqual([[], []])
	})
})
