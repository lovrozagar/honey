/**
 * The package each target makes, as each registry it publishes to lists it (plan 39 8.7): `generated` hands back every
 * target's `packages` beside its files, each a `registry`, a `name` and a `version`, and the manifest each target's
 * directory keeps records them, so a release reads its names and versions there instead of parsing each registry's
 * manifest. Every value is the one the target's own files carry: its options', or its defaults.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { generated, type GenerateRun, MANIFEST, TARGETS, writeGenerated, writeTarget } from "../index.ts"

const DOCUMENT = {
	info: { title: "Shop", version: "1.2.0" },
	openapi: "3.1.0",
	paths: { "/ping": { get: { operationId: "ping", responses: { 204: { description: "none" } }, "x-mcp": true } } },
	servers: [{ url: "https://shop.example.test" }],
}

/** Every target's packages for `run`. */
async function packagesOf(run: GenerateRun) {
	const out = await generated(run, DOCUMENT, { env: {}, report: () => undefined })
	return Object.fromEntries(Object.entries(out).map(([target, { packages }]) => [target, packages]))
}

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe("the package each target makes (plan 39 8.7)", () => {
	it("names it on each registry it publishes to, at the version its files carry", async () => {
		const packages = await packagesOf({
			options: {
				cli: { binaryName: "shop", modulePath: "github.com/acme/shop-cli", version: "3.0.1" },
				csharp: { packageId: "Acme.Shop", version: "1.4.0" },
				go: { modulePath: "github.com/acme/shop-go", version: "2.1.0" },
				java: { artifactId: "shop", groupId: "dev.acme", version: "1.5.0" },
				mcp: { mcpName: "io.github.acme/shop", packageName: "@acme/shop-mcp", version: "0.3.0" },
				python: { packageName: "acme_shop", version: "1.6.0" },
				rust: { crateName: "acme-shop", version: "1.7.0" },
				ts: { packageName: "@acme/shop", version: "1.8.0" },
			},
			targets: TARGETS,
		})
		expect(packages).toEqual({
			cli: [{ name: "github.com/acme/shop-cli/v3", registry: "go", version: "3.0.1" }],
			csharp: [{ name: "Acme.Shop", registry: "nuget", version: "1.4.0" }],
			go: [{ name: "github.com/acme/shop-go/v2", registry: "go", version: "2.1.0" }],
			java: [{ name: "dev.acme:shop", registry: "maven-central", version: "1.5.0" }],
			mcp: [
				{ name: "@acme/shop-mcp", registry: "npm", version: "0.3.0" },
				{ name: "io.github.acme/shop", registry: "mcp-registry", version: "0.3.0" },
			],
			python: [{ name: "acme-shop", registry: "pypi", version: "1.6.0" }],
			rust: [{ name: "acme-shop", registry: "crates.io", version: "1.7.0" }],
			ts: [
				{ name: "@acme/shop", registry: "npm", version: "1.8.0" },
				{ name: "@acme/shop", registry: "jsr", version: "1.8.0" },
			],
		})
	})

	it("names the defaults each target's files carry, a Go module given no version with none", async () => {
		const packages = await packagesOf({ targets: ["go", "mcp", "ts"] })
		expect(packages).toEqual({
			go: [{ name: "example.com/sdk", registry: "go" }],
			mcp: [{ name: "shop-mcp", registry: "npm", version: "1.2.0" }],
			ts: [{ name: "sdk", registry: "npm", version: "1.2.0" }],
		})
	})

	it("is each manifest's own record: the name and version its package.json and Cargo.toml carry", async () => {
		const run: GenerateRun = {
			options: { rust: { version: "0.9.0" }, ts: { version: "4.0.0" } },
			targets: ["rust", "ts"],
		}
		const out = await generated(run, DOCUMENT, { env: {}, report: () => undefined })
		const npm = JSON.parse(out.ts?.files["package.json"] ?? "{}") as { name: string; version: string }
		const cargo = out.rust?.files["Cargo.toml"] ?? ""
		const crate = [/^name = "(.*)"$/m.exec(cargo)?.[1], /^version = "(.*)"$/m.exec(cargo)?.[1]]
		expect([[npm.name, npm.version], crate]).toEqual([
			[out.ts?.packages[0]?.name, out.ts?.packages[0]?.version],
			[out.rust?.packages[0]?.name, out.rust?.packages[0]?.version],
		])
	})
})

describe("the manifest's record of the package (plan 39 8.7)", () => {
	it("records each target's packages before its files, where writeGenerated writes them", async () => {
		const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gen-packages-"))
		dirs.push(out)
		const run = {
			options: { python: { packageName: "acme_shop", version: "2.0.0" } },
			out,
			targets: ["python"] as const,
		}
		await writeGenerated(run, DOCUMENT, { err: () => undefined, out: () => undefined }, {})
		const manifest = JSON.parse(readFileSync(join(out, "python", MANIFEST), "utf8")) as Record<string, unknown>
		expect([Object.keys(manifest), manifest.packages]).toEqual([
			["packages", "files"],
			[{ name: "acme-shop", registry: "pypi", version: "2.0.0" }],
		])
	})

	it("records none when the caller names none", () => {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gen-packages-"))
		dirs.push(dir)
		writeTarget(dir, { "a.txt": "a\n" })
		expect(Object.keys(JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as object)).toEqual(["files"])
	})
})
