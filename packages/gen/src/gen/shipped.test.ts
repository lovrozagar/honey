/**
 * The files a package ships beside its code (plan 39 8.7): the README and the license file the metadata block names
 * reach every target's root as `README.md` and `LICENSE`, byte for byte, and each manifest points at the ones it
 * has: pyproject's `readme` and `license-files`, Cargo's `readme` and `include`, the `.csproj`'s `PackageReadmeFile`
 * and packed items, jsr.json's publish list. A path that cannot be read, a file that is not UTF-8 and a README that is
 * not Markdown are refused, naming the field. The registries' own tools read them in each target's package legs, npm's
 * here: `files` names neither, and npm packs both from the package root.
 */
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { hasNpm } from "../emit/mcp/__fixtures__/clients.ts"
import { written } from "../emit/mcp/__fixtures__/written.ts"
import type { GeneratedFiles } from "../cli.ts"
import { generated, type GenerateRun } from "../index.ts"
import { SPAWN_TIMEOUT } from "./__fixtures__/spawn-timeout.ts"
import { TARGETS } from "./targets.ts"

const README = "# Shop\n\nThe Shop API's clients: «every» language.\n"
const LICENSE = "MIT License\n\nCopyright (c) 2026 Acme Inc\n"

const DOCUMENT = {
	info: { title: "Shop", version: "1.2.0" },
	openapi: "3.1.0",
	paths: { "/ping": { get: { operationId: "ping", responses: { 204: { description: "none" } }, "x-mcp": true } } },
	servers: [{ url: "https://shop.example.test" }],
}

/* a 1x1 PNG, and the opening bytes of a JPEG */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4v5nhPwAHGQKyb+i68wAAAABJRU5ErkJggg==",
	"base64",
)
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00)

/** A reader of the files by their paths, as a run's `read` takes them. */
const read = (path: string): Uint8Array => {
	const text = { "docs/README.md": README, "legal/LICENSE.txt": LICENSE }[path]
	const image = { "art/ICON.PNG": PNG, "art/logo.jpeg": JPEG, "art/swapped.png": JPEG }[path]
	if (image !== undefined) return image
	if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
	return new TextEncoder().encode(text)
}

/** The C# package's `.csproj` in `files`. */
const csprojOf = (files: GeneratedFiles) => String(files.csharp?.["HoneySdk.csproj"])

/** Every target's files for `run`, the files read through `reader`. */
const run = (metadata: GenerateRun["metadata"], reader = read) =>
	generated({ metadata, options: { ts: { packageName: "@acme/shop" } }, targets: TARGETS }, DOCUMENT, {
		env: {},
		read: reader,
		report: () => undefined,
	})

const SHIPPED = { licenseFile: "legal/LICENSE.txt", readme: "docs/README.md" }

describe("the README and license file every target ships (plan 39 8.7)", () => {
	it("writes both into every target's root as given, and neither when the block names none", async () => {
		const [shipped, bare] = [await run(SHIPPED), await run({})]
		expect(TARGETS.map((target) => [target, shipped[target]?.["README.md"], shipped[target]?.LICENSE])).toEqual(
			TARGETS.map((target) => [target, README, LICENSE]),
		)
		expect(
			TARGETS.flatMap((target) => ["README.md", "LICENSE"].filter((name) => name in (bare[target] ?? {}))),
		).toEqual([])
	})

	it("points each manifest at the files it ships", async () => {
		const files = await run(SHIPPED)
		const line = (text: string | undefined, key: string) => new RegExp(`^${key} = .*$`, "m").exec(text ?? "")?.[0]
		expect({
			cargo: [line(files.rust?.["Cargo.toml"], "readme"), line(files.rust?.["Cargo.toml"], "include")],
			csproj: [
				"<PackageReadmeFile>README.md</PackageReadmeFile>",
				'<None Include="README.md" Pack="true" PackagePath="\\" />',
				'<None Include="LICENSE" Pack="true" PackagePath="\\" />',
			].filter((element) => !csprojOf(files).includes(element)),
			jsr: (JSON.parse(files.ts?.["jsr.json"] ?? "{}") as { publish: unknown }).publish,
			pyproject: [
				line(files.python?.["pyproject.toml"], "readme"),
				line(files.python?.["pyproject.toml"], "license-files"),
			],
		}).toEqual({
			cargo: ['readme = "README.md"', 'include = ["/src", "/README.md", "/LICENSE"]'],
			csproj: [],
			jsr: { include: ["*.gen.ts", "README.md", "LICENSE"] },
			pyproject: ['readme = "README.md"', 'license-files = ["LICENSE"]'],
		})
	})

	it("points at the README alone when only the README is named", async () => {
		const files = await run({ readme: SHIPPED.readme })
		expect([
			/^include = .*$/m.exec(files.rust?.["Cargo.toml"] ?? "")?.[0],
			csprojOf(files).includes('Include="LICENSE"'),
			files.python?.["pyproject.toml"]?.includes("license-files"),
		]).toEqual(['include = ["/src", "/README.md"]', false, false])
	})
})

describe("the icon the C# package ships (plan 39 8.7)", () => {
	it("ships it into the C# package alone, byte for byte, under icon and its extension in lower case", async () => {
		const [png, jpeg] = [await run({ icon: "art/ICON.PNG" }), await run({ icon: "art/logo.jpeg" })]
		expect({
			csproj: [
				"<PackageIcon>icon.png</PackageIcon>",
				'<None Include="icon.png" Pack="true" PackagePath="\\" />',
			].filter((element) => !csprojOf(png).includes(element)),
			elsewhere: TARGETS.filter((target) => target !== "csharp").flatMap((target) =>
				Object.keys(png[target] ?? {}).filter((path) => path.startsWith("icon.")),
			),
			jpeg: [jpeg.csharp?.["icon.jpeg"], /<PackageIcon>(.*)<\/PackageIcon>/.exec(csprojOf(jpeg))?.[1]],
			png: png.csharp?.["icon.png"],
		}).toEqual({ csproj: [], elsewhere: [], jpeg: [JPEG, "icon.jpeg"], png: PNG })
	})

	it.each<[string, string, string]>([
		["a format NuGet does not show", "art/logo.gif", 'Invalid metadata.icon: "art/logo.gif"'],
		["bytes that are not the image its extension names", "art/swapped.png", "is not the image its extension names"],
		["an image over NuGet's 1 MB", "art/huge.jpg", 'Invalid metadata.icon: "art/huge.jpg" is over NuGet\'s 1 MB'],
		["a missing file", "art/none.png", 'Invalid metadata.icon: "art/none.png" cannot be read (ENOENT)'],
	])("refuses %s, naming the field", async (_, icon, message) => {
		const big = new Uint8Array(1024 * 1024 + 1)
		big.set(JPEG)
		const huge = (path: string) => (path === "art/huge.jpg" ? big : read(path))
		await expect(run({ icon }, huge)).rejects.toThrow(message)
	})
})

describe("what the README and license file refuse (plan 39 8.7)", () => {
	it.each<[string, GenerateRun["metadata"], string]>([
		["a missing file", { readme: "docs/NOPE.md" }, 'Invalid metadata.readme: "docs/NOPE.md" cannot be read (ENOENT)'],
		["a README that is not Markdown", { readme: "README.rst" }, 'Invalid metadata.readme: "README.rst"'],
		[
			"a license file that is not UTF-8",
			{ licenseFile: "legal/LICENSE.txt" },
			'Invalid metadata.licenseFile: "legal/LICENSE.txt" is not UTF-8 text',
		],
	])("refuses %s, naming the field", async (_, metadata, message) => {
		const latin1 = (path: string) => (path === "legal/LICENSE.txt" ? Uint8Array.of(0x43, 0xa9, 0x0a) : read(path))
		await expect(run(metadata, latin1)).rejects.toThrow(message)
	})

	it("names a reader's own refusal when it gives no error code", async () => {
		const refusing = () => {
			throw new Error("no such file in the bundle")
		}
		await expect(run({ readme: "docs/README.md" }, refusing)).rejects.toThrow(
			'Invalid metadata.readme: "docs/README.md" cannot be read (no such file in the bundle)',
		)
	})
})

describe.skipIf(!hasNpm())("the README and license file npm packs (plan 39 8.7)", () => {
	it("packs both into the TS SDK and the MCP server", { timeout: 2 * SPAWN_TIMEOUT }, async () => {
		const files = await run(SHIPPED)
		const packed = (target: "mcp" | "ts") => {
			const args = ["pack", "--dry-run", "--json", "--ignore-scripts"]
			const out = execFileSync("npm", args, { cwd: written(files[target] ?? {}), encoding: "utf8" })
			/* npm 11 answers a list of packs, npm 12 an object of them by name */
			const [listing] = Object.values(JSON.parse(out) as Record<string, { files: { path: string }[] }>)
			return (listing?.files ?? []).map((file) => file.path).filter((path) => !path.includes("/"))
		}
		expect([packed("ts"), packed("mcp")]).toEqual([
			["LICENSE", "README.md", "package.json"],
			["LICENSE", "README.md", "package.json"],
		])
	})
})
