/**
 * The C# package's manifest and format rules (contract 45 §4.3): a net10.0 `.csproj` with nullable on, warnings as
 * errors, the AOT and trim analyzers, and the XML doc file with only CS1591 off (Fb4); a root `.editorconfig`, so
 * no parent file reaches the emitted sources (R6). Every name the manifest and the sources spell comes from a
 * validated option, never from spec text (Fb3). The metadata nuget.org shows (the description, the authors, the SPDX
 * license expression, the project and repository URLs, the copyright and the tags) is written when its option is
 * given, each value validated and then escaped twice: for MSBuild, which would expand a `$(…)` or `@(…)` in it, and
 * for XML. `dotnet pack` writes the symbols beside the package as a `.snupkg`, which nuget.org serves to debuggers
 * (plan 39 8.6).
 */
import { isCsReserved } from "../shared/lang.ts"
import { checked, HTTPS_URL, LICENSE, README, type Shipped, SPDX_EXPRESSION, TEXT } from "../shared/metadata.ts"
import { BCL, RUNTIME_BCL } from "./types-names.ts"

/** The one target framework: the pinned SDK's major (R1). */
export const TARGET_FRAMEWORK = "net10.0"

/** What nuget.org shows about the package, each part the caller gave, validated. */
export type CSharpMetadata = {
	readonly description?: string
	readonly authors?: string
	readonly license?: string
	readonly homepage?: string
	readonly repository?: string
	readonly copyright?: string
	/** comma separated, as the CLI gives it */
	readonly tags?: string
}

/** The package's identity, each part validated, its metadata, and the files it ships beside the code. */
export type CSharpPackage = {
	readonly packageId: string
	readonly rootNamespace: string
	readonly version: string
	readonly metadata?: CSharpMetadata
	readonly shipped?: Shipped | undefined
}

/* authors: names joined by commas, each with a character other than a space, none with a control character */
const AUTHORS = /^(?=[^\p{Cc}]{1,4000}$)[^,]*[^,\s][^,]*(?:,[^,]*[^,\s][^,]*)*$/u
/* tags: words joined by commas, none holding a space or a `;`, which NuGet splits PackageTags on */
const TAGS = /^(?=.{1,4000}$)[^\s,;\p{Cc}\p{Cs}]{1,50}(?:,[^\s,;\p{Cc}\p{Cs}]{1,50})*$/u

/** The metadata options, each validated: the description and authors as text, the license as SPDX, the URLs https. */
export function packageMetadata(options: CSharpMetadata): CSharpMetadata {
	return {
		authors: checked("authors", options.authors, AUTHORS),
		copyright: checked("copyright", options.copyright, TEXT),
		description: checked("description", options.description, TEXT),
		homepage: checked("homepage", options.homepage, HTTPS_URL),
		license: checked("license", options.license, SPDX_EXPRESSION),
		repository: checked("repository", options.repository, HTTPS_URL),
		tags: checked("tags", options.tags, TAGS),
	}
}

/* the characters MSBuild expands or splits on in a property, written as its own %XX escapes, which it reads back */
const MSBUILD_SPECIAL = /[%*?@$();']/g

/** `text` as a `.csproj` property value: MSBuild's escapes first, then XML's. */
const propertyText = (text: string) =>
	text
		.replace(MSBUILD_SPECIAL, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")

/** The metadata's property lines, in the order the options name them; none for an option not given. */
function metadataLines(metadata: CSharpMetadata | undefined): string {
	const entries: readonly (readonly [element: string, value: string | undefined])[] = [
		["Description", metadata?.description],
		["Authors", metadata?.authors],
		["Copyright", metadata?.copyright],
		["PackageLicenseExpression", metadata?.license],
		["PackageProjectUrl", metadata?.homepage],
		["RepositoryUrl", metadata?.repository],
	]
	const lines = entries.flatMap(([element, value]) =>
		value === undefined ? [] : [`    <${element}>${propertyText(value)}</${element}>\n`],
	)
	if (metadata?.repository !== undefined) lines.push("    <RepositoryType>git</RepositoryType>\n")
	/* each tag escaped on its own: the `;` between them is the list's, which MSBuild hands to NuGet as written */
	const tags = metadata?.tags?.split(",").map(propertyText).join(";")
	if (tags !== undefined) lines.push(`    <PackageTags>${tags}</PackageTags>\n`)
	return lines.join("")
}

/* NuGet's id rule; a namespace segment is an identifier; a client is a PascalCase type */
const PACKAGE_ID = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*$/
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CLIENT_NAME = /^[A-Z][A-Za-z0-9_]*$/
/* SemVer 2 (semver.org's recommended pattern), as Rust's sdk-cargo.ts takes it */
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const refuse = (option: string, value: string): never => {
	throw new Error(`Invalid ${option}: ${JSON.stringify(value)}`)
}

/** A NuGet package id: dot- or dash-separated words, at most 100 characters. */
export const validatePackageId = (value: string): string =>
	PACKAGE_ID.test(value) && value.length <= 100 ? value : refuse("packageId", value)

/** A namespace: dot-separated identifiers, none a keyword or a BCL type the sources spell, not under `System`. */
export function validateRootNamespace(value: string): string {
	const segments = value.split(".")
	/* a segment naming a BCL type the sources spell unqualified turns that spelling into the namespace (CS0118) */
	const bcl = new Set([...Object.values(BCL).flat(), ...RUNTIME_BCL])
	const valid = segments.every((s) => SEGMENT.test(s) && !isCsReserved(s) && !bcl.has(s))
	return valid && segments[0] !== "System" ? value : refuse("rootNamespace", value)
}

/** A client class name: PascalCase. */
export const validateClientName = (value: string): string =>
	CLIENT_NAME.test(value) ? value : refuse("clientName", value)

/* MSBuild derives the assembly version from major.minor.patch, each part at most 65534 (CS7034 past it) */
const ASSEMBLY_PART_MAX = 65534

/** A SemVer 2 version whose major, minor and patch each fit an assembly version part. */
export function validateVersion(value: string): string {
	const parts = SEMVER.exec(value)?.slice(1, 4)
	return parts?.every((part) => Number(part) <= ASSEMBLY_PART_MAX) === true ? value : refuse("version", value)
}

/** The README and the icon nuget.org shows, then the items that pack each shipped file at the package's root. */
function shippedLines(shipped: Shipped | undefined): { readonly property: string; readonly items: string } {
	const icon = shipped?.icon
	const packed = [
		...(shipped?.readme ? [README] : []),
		...(shipped?.licenseFile ? [LICENSE] : []),
		...(icon === undefined ? [] : [icon]),
	]
	const properties = [
		...(shipped?.readme ? [`    <PackageReadmeFile>${README}</PackageReadmeFile>\n`] : []),
		...(icon === undefined ? [] : [`    <PackageIcon>${icon}</PackageIcon>\n`]),
	]
	return {
		items:
			packed.length === 0
				? ""
				: `  <ItemGroup>\n${packed.map((file) => `    <None Include="${file}" Pack="true" PackagePath="\\" />\n`).join("")}  </ItemGroup>\n`,
		property: properties.join(""),
	}
}

/** The `.csproj`: the package id as the assembly name, the metadata given, no package reference (H11). */
export const csproj = ({
	metadata,
	packageId,
	rootNamespace,
	shipped,
	version,
}: CSharpPackage): string => `<!-- @generated by honey. DO NOT EDIT. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${TARGET_FRAMEWORK}</TargetFramework>
    <AssemblyName>${packageId}</AssemblyName>
    <RootNamespace>${rootNamespace}</RootNamespace>
    <PackageId>${packageId}</PackageId>
    <Version>${version}</Version>
${metadataLines(metadata)}${shippedLines(shipped).property}    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <IsAotCompatible>true</IsAotCompatible>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <NoWarn>$(NoWarn);CS1591</NoWarn>
    <IncludeSymbols>true</IncludeSymbols>
    <SymbolPackageFormat>snupkg</SymbolPackageFormat>
  </PropertyGroup>
${shippedLines(shipped).items}</Project>
`

/** The root `.editorconfig` the emitted layout is written to and the format gate holds it to (Fb8). */
export const EDITORCONFIG = `# @generated by honey. DO NOT EDIT.
root = true

[*.cs]
charset = utf-8
end_of_line = lf
indent_size = 4
indent_style = space
insert_final_newline = true
`
