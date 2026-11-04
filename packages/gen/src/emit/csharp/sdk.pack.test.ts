/**
 * The package metadata nuget.org shows (bit 15): `--csharp-description`, `--csharp-authors`, `--csharp-license`,
 * `--csharp-homepage` and `--csharp-repository` reach the `.csproj` as `<Description>`, `<Authors>`,
 * `<PackageLicenseExpression>`, `<PackageProjectUrl>` and `<RepositoryUrl>` with `<RepositoryType>git`, each left out
 * when not given; a value is escaped for MSBuild (a `$(…)` stays text) and for XML; an invalid value is refused at
 * generate, naming its option. Offline, `dotnet pack` on the pinned SDK writes a nuspec holding every value as given.
 * Plan 39 8.6: `--csharp-copyright` and `--csharp-tags` reach `<Copyright>` and `<PackageTags>` (each tag escaped on
 * its own, a `;` between them), and every pack writes the symbols beside the package as a `.snupkg`. Plan 39 8.7: the
 * README and the license file a run ships are packed at the package's root, the README the one nuget.org shows.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { LEAN_BUILD, runDotnet, withDotnet } from "./__fixtures__/csharp-env.ts"
import { PACKAGE_METADATA as METADATA, PACKAGE_SHIPPED } from "./__fixtures__/documents.ts"
import { type CSharpSdkOptions, generateCSharpSdk } from "./sdk.ts"

const DOTNET = withDotnet()

const DOCUMENT = { info: { title: "Shop", version: "1" }, openapi: "3.1.0", paths: {} }

const csproj = (options: CSharpSdkOptions = {}) => generateCSharpSdk(DOCUMENT, options).files["HoneySdk.csproj"] ?? ""

/** The metadata elements `text` holds, in the manifest's order. */
const elements = (text: string) =>
	[
		"Description",
		"Authors",
		"Copyright",
		"PackageLicenseExpression",
		"PackageProjectUrl",
		"RepositoryUrl",
		"RepositoryType",
		"PackageTags",
	].filter((element) => text.includes(`<${element}>`))

/** The entry names of the zip at `path`, read from its central directory: a `.nupkg` is a zip. */
function zipEntries(path: string): string[] {
	const zip = readFileSync(path)
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
	const names: string[] = []
	for (let at = zip.readUInt32LE(end + 16), left = zip.readUInt16LE(end + 10); left > 0; left--) {
		const length = zip.readUInt16LE(at + 28)
		names.push(zip.toString("utf8", at + 46, at + 46 + length))
		at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
	}
	return names
}

/** A nuspec element's text with XML's entities read back. */
const unescaped = (text: string | undefined) =>
	text?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&apos;", "'").replaceAll("&amp;", "&")

describe("the .csproj's package metadata", () => {
	it("writes each option given into its element, escaped for MSBuild and XML, and git as the repository type", () => {
		expect(csproj(METADATA)).toContain(`    <Version>0.1.0</Version>
    <Description>Shop%27s &lt;API&gt; client: %24%28NoWarn%29 %40%28Compile%29 100%25 done%3B a%2Ab%3F</Description>
    <Authors>Acme Co, O%27Brien &amp; Partners</Authors>
    <Copyright>© 2026 Acme Co &amp; %24%28Partners%29%3B all rights reserved</Copyright>
    <PackageLicenseExpression>Apache-2.0 OR MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://shop.example.com/docs</PackageProjectUrl>
    <RepositoryUrl>https://github.com/acme/shop-dotnet</RepositoryUrl>
    <RepositoryType>git</RepositoryType>
    <PackageTags>shop;api;c#;%24%28NoWarn%29</PackageTags>
    <Nullable>enable</Nullable>`)
	})

	it("writes only the elements whose option is given", () => {
		expect([
			elements(csproj()),
			elements(csproj({ license: "MIT" })),
			elements(csproj({ repository: METADATA.repository })),
			elements(csproj({ tags: "shop" })),
		]).toEqual([[], ["PackageLicenseExpression"], ["RepositoryUrl", "RepositoryType"], ["PackageTags"]])
	})

	it.each<[keyof typeof METADATA, string]>([
		["description", ""],
		["description", "two\nlines"],
		["description", "x".repeat(4001)],
		["authors", ""],
		["authors", "Acme,"],
		["authors", "Acme, ,Shop"],
		["authors", "Acme\tCo"],
		["license", "MIT or Apache-2.0"],
		["license", "MIT;rm"],
		["license", "(MIT)"],
		["homepage", "http://shop.example.com"],
		["homepage", "https://"],
		["homepage", "https://shop.example.com/a b"],
		["repository", "git@github.com:acme/shop.git"],
		["repository", "https://github.com/acme/<shop>"],
		["copyright", "two\nlines"],
		["tags", ""],
		["tags", "shop api"],
		["tags", "shop;api"],
		["tags", "shop,,api"],
		["tags", "x".repeat(51)],
	])("refuses %s %j at generate", (option, value) => {
		expect(() => csproj({ [option]: value })).toThrow(`Invalid ${option}: ${JSON.stringify(value)}`)
	})
})

/** The files the run ships that each package (not symbols) nupkg under `dir` holds, by name. */
const shippedIn = (dir: string, art: readonly string[]) =>
	art
		.filter((name) => name.endsWith(".0.1.0.nupkg"))
		.map((name) =>
			zipEntries(join(dir, name))
				.filter((entry) => entry in PACKAGE_SHIPPED)
				.sort(),
		)

describe.skipIf(!DOTNET)("dotnet pack on the pinned SDK, offline", () => {
	it("builds with every option given, and packs a nuspec holding each value as given", { timeout: 600_000 }, () => {
		/* the registry's `pack`: the errors document with every metadata option */
		const sdk = compiledCSharp("pack")
		const packed = runDotnet(
			[
				"pack",
				"src/HoneySdk.csproj",
				"-c",
				"Release",
				"--no-build",
				"--artifacts-path",
				join(sdk.dir, "art"),
				...LEAN_BUILD,
			],
			{ cwd: sdk.dir },
		)
		const art = readdirSync(join(sdk.dir, "art"), { recursive: true }).map(String)
		/* the package's own nuspec: the symbols package has one of its own beside it */
		const nuspecs = art.filter((name) => name.endsWith(".nuspec") && !name.endsWith(".symbols.nuspec"))
		const nuspec = nuspecs.length === 1 ? readFileSync(join(sdk.dir, "art", nuspecs[0] as string), "utf8") : ""
		const tag = (name: string) => new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(nuspec)?.[1]
		expect(
			{
				authors: unescaped(tag("authors")),
				built: [sdk.built, sdk.diagnostics],
				copyright: unescaped(tag("copyright")),
				description: unescaped(tag("description")),
				license: tag("license"),
				nuspecs: nuspecs.length,
				projectUrl: tag("projectUrl"),
				repository: /<repository type="git" url="([^"]+)"/.exec(nuspec)?.[1],
				status: packed.status,
				readme: tag("readme"),
				shipped: shippedIn(join(sdk.dir, "art"), art),
				symbols: art.filter((name) => name.endsWith(".snupkg")).map((name) => name.split("/").at(-1)),
				tags: unescaped(tag("tags")),
			},
			`${packed.stdout}${packed.stderr}`,
		).toEqual({
			authors: METADATA.authors,
			built: [true, []],
			copyright: METADATA.copyright,
			description: METADATA.description,
			license: METADATA.license,
			nuspecs: 1,
			projectUrl: METADATA.homepage,
			readme: "README.md",
			repository: METADATA.repository,
			shipped: [["LICENSE", "README.md"]],
			status: 0,
			symbols: ["HoneySdk.0.1.0.snupkg"],
			tags: "shop api c# $(NoWarn)",
		})
	})
})
