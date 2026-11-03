/**
 * The package metadata nuget.org shows (bit 15): `--csharp-description`, `--csharp-authors`, `--csharp-license`,
 * `--csharp-homepage` and `--csharp-repository` reach the `.csproj` as `<Description>`, `<Authors>`,
 * `<PackageLicenseExpression>`, `<PackageProjectUrl>` and `<RepositoryUrl>` with `<RepositoryType>git`, each left out
 * when not given; a value is escaped for MSBuild (a `$(…)` stays text) and for XML; an invalid value is refused at
 * generate, naming its option. Offline, `dotnet pack` on the pinned SDK writes a nuspec holding every value as given.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { compiledFixture } from "./__fixtures__/compiled.ts"
import { LEAN_BUILD, runDotnet, withDotnet } from "./__fixtures__/csharp-env.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type CSharpSdkOptions, generateCSharpSdk } from "./sdk.ts"

const DOTNET = withDotnet()

const DOCUMENT = { info: { title: "Shop", version: "1" }, openapi: "3.1.0", paths: {} }

/** Text MSBuild would expand or split, and XML would read as markup. */
const METADATA = {
	authors: "Acme Co, O'Brien & Partners",
	description: "Shop's <API> client: $(NoWarn) @(Compile) 100% done; a*b?",
	homepage: "https://shop.example.com/docs",
	license: "Apache-2.0 OR MIT",
	repository: "https://github.com/acme/shop-dotnet",
} as const satisfies CSharpSdkOptions

const csproj = (options: CSharpSdkOptions = {}) => generateCSharpSdk(DOCUMENT, options).files["HoneySdk.csproj"] ?? ""

/** The metadata elements `text` holds, in the manifest's order. */
const elements = (text: string) =>
	["Description", "Authors", "PackageLicenseExpression", "PackageProjectUrl", "RepositoryUrl", "RepositoryType"].filter(
		(element) => text.includes(`<${element}>`),
	)

/** A nuspec element's text with XML's entities read back. */
const unescaped = (text: string | undefined) =>
	text?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&apos;", "'").replaceAll("&amp;", "&")

describe("the .csproj's package metadata", () => {
	it("writes each option given into its element, escaped for MSBuild and XML, and git as the repository type", () => {
		expect(csproj(METADATA)).toContain(`    <Version>0.1.0</Version>
    <Description>Shop%27s &lt;API&gt; client: %24%28NoWarn%29 %40%28Compile%29 100%25 done%3B a%2Ab%3F</Description>
    <Authors>Acme Co, O%27Brien &amp; Partners</Authors>
    <PackageLicenseExpression>Apache-2.0 OR MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://shop.example.com/docs</PackageProjectUrl>
    <RepositoryUrl>https://github.com/acme/shop-dotnet</RepositoryUrl>
    <RepositoryType>git</RepositoryType>
    <Nullable>enable</Nullable>`)
	})

	it("writes only the elements whose option is given", () => {
		expect([
			elements(csproj()),
			elements(csproj({ license: "MIT" })),
			elements(csproj({ repository: METADATA.repository })),
		]).toEqual([[], ["PackageLicenseExpression"], ["RepositoryUrl", "RepositoryType"]])
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
	])("refuses %s %j at generate", (option, value) => {
		expect(() => csproj({ [option]: value })).toThrow(`Invalid ${option}: ${JSON.stringify(value)}`)
	})
})

describe.skipIf(!DOTNET)("dotnet pack on the pinned SDK, offline", () => {
	it("builds with every option given, and packs a nuspec holding each value as given", { timeout: 600_000 }, () => {
		/* a document with an operation: an SDK of none has no JSON context to build */
		const sdk = compiledFixture({ document: FIXTURES.errors.document, options: METADATA })
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
		const nuspecs = readdirSync(join(sdk.dir, "art"), { recursive: true })
			.map(String)
			.filter((name) => name.endsWith(".nuspec"))
		const nuspec = nuspecs.length === 1 ? readFileSync(join(sdk.dir, "art", nuspecs[0] as string), "utf8") : ""
		const tag = (name: string) => new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(nuspec)?.[1]
		expect(
			{
				authors: unescaped(tag("authors")),
				built: [sdk.built, sdk.diagnostics],
				description: unescaped(tag("description")),
				license: tag("license"),
				nuspecs: nuspecs.length,
				projectUrl: tag("projectUrl"),
				repository: /<repository type="git" url="([^"]+)"/.exec(nuspec)?.[1],
				status: packed.status,
			},
			`${packed.stdout}${packed.stderr}`,
		).toEqual({
			authors: METADATA.authors,
			built: [true, []],
			description: METADATA.description,
			license: METADATA.license,
			nuspecs: 1,
			projectUrl: METADATA.homepage,
			repository: METADATA.repository,
			status: 0,
		})
	})
})
