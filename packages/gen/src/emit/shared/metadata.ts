/**
 * The package metadata registries show, taken as options: the grammars every target checks a value against before it
 * reaches a manifest (a goreleaser YAML string, a `.csproj` element, a Groovy string), and the one refusal they share,
 * `Invalid <option>: "<value>"`. Each value is the caller's, never spec text, and is still escaped where it lands.
 */

/** One line of printable text, at most 4000 characters (nuget.org's description and authors limit); no lone surrogate. */
export const TEXT = /^[^\p{Cc}\p{Cs}]{1,4000}$/u
/** An https URL with a host. */
export const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/
/** An SPDX license expression: ids joined by AND, OR or WITH. */
export const SPDX_EXPRESSION = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/
/** One SPDX license list id, which spdx.org has a page for: not an expression, not a `LicenseRef-`. */
export const SPDX_ID = /^(?!LicenseRef-)[A-Za-z0-9][A-Za-z0-9.+-]*$/
/** A version npm and JSR accept: `major.minor.patch`, then an optional prerelease. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** An npm package name: lowercase and URL-safe, `@scope/` optional, at most 214 characters. */
export const NPM_NAME = /^(?=.{1,214}$)(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/
/** A person: `Name <email>`. */
export const PERSON = /^[^<>\p{Cc}]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/u

/** The refusal of an option's value. */
export const refuse = (option: string, value: string): never => {
	throw new Error(`Invalid ${option}: ${JSON.stringify(value)}`)
}

/** `value` when it matches `grammar`, undefined when not given, else a refusal naming `option`. */
export function checked(option: string, value: string | undefined, grammar: RegExp): string | undefined {
	if (value !== undefined && !grammar.test(value)) refuse(option, value)
	return value
}

/** A `Name <email>` that PERSON accepted, split. */
export function personOf(value: string): { readonly name: string; readonly email: string } {
	const open = value.lastIndexOf(" <")
	return { email: value.slice(open + 2, -1), name: value.slice(0, open) }
}

/** One author: a name with no comma, angle bracket or control character, or that name then ` <email>`. */
export const AUTHOR = /^(?=[^\p{Cc}\p{Cs}]{1,4000}$)[^<>,]*[^<>,\s][^<>,]*?(?: <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>)?$/u
/** One keyword: no space, comma or control character, at most 50 characters; a registry may hold it to less. */
export const KEYWORD = /^[^\s,\p{Cc}\p{Cs}]{1,50}$/u

/**
 * The fields of the package metadata block a run gives once (plan 39 8.2), which every target that publishes reads
 * where its registry has a place for it; a target's own option of the same meaning wins. `--metadata-<field>` sets one
 * on the command line, `authors` and `keywords` comma separated.
 */
export const METADATA_FIELDS = [
	"authors",
	"changelog",
	"copyright",
	"description",
	"documentation",
	"homepage",
	"icon",
	"keywords",
	"license",
	"licenseFile",
	"readme",
	"repository",
] as const

/** One of `METADATA_FIELDS`. */
export type MetadataField = (typeof METADATA_FIELDS)[number]

/** The fields that hold a list. */
const LISTS = ["authors", "keywords"] as const satisfies readonly MetadataField[]

/**
 * The package metadata: `description` and `copyright` one line of text; `homepage`, `repository`, `documentation` and
 * `changelog` https URLs; `license` an SPDX expression; `authors` each a name or `Name <email>`; `keywords` single
 * words; `licenseFile`, `readme` and `icon` paths of files to ship in the package.
 */
export type Metadata = {
	readonly [K in MetadataField]?: K extends (typeof LISTS)[number] ? readonly string[] : string
}

const GRAMMARS: { readonly [K in MetadataField]: RegExp } = {
	authors: AUTHOR,
	changelog: HTTPS_URL,
	copyright: TEXT,
	description: TEXT,
	documentation: HTTPS_URL,
	homepage: HTTPS_URL,
	icon: TEXT,
	keywords: KEYWORD,
	license: SPDX_EXPRESSION,
	licenseFile: TEXT,
	readme: TEXT,
	repository: HTTPS_URL,
}

/** Whether `field` holds a list. */
export const isListField = (field: string): boolean => (LISTS as readonly string[]).includes(field)

/** The refusal of a metadata field's value, shown as given. */
const refuseField = (field: string, value: unknown): never => {
	throw new Error(`Invalid metadata.${field}: ${JSON.stringify(value)}`)
}

/**
 * `metadata` with every field checked against its grammar, or a refusal naming `metadata.<field>` and the value: a
 * list field wants a non-empty list, each entry checked on its own. A field outside `METADATA_FIELDS` is refused; one
 * given as `undefined` is left out, as not given.
 */
export function checkedMetadata(metadata: unknown): Metadata {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
		throw new Error("Invalid metadata: want an object of fields")
	const entries = Object.entries(metadata).filter(([, value]) => value !== undefined)
	for (const [field, value] of entries) {
		if (!Object.hasOwn(GRAMMARS, field))
			throw new Error(
				`Invalid metadata: unknown field ${JSON.stringify(field)}, want one of ${METADATA_FIELDS.join(", ")}`,
			)
		const grammar = GRAMMARS[field as MetadataField]
		if (!isListField(field)) {
			if (typeof value !== "string" || !grammar.test(value)) refuseField(field, value)
			continue
		}
		if (!Array.isArray(value) || value.length === 0) refuseField(field, value)
		for (const entry of value as unknown[])
			if (typeof entry !== "string" || !grammar.test(entry)) refuseField(field, entry)
	}
	return Object.fromEntries(entries) as Metadata
}

/** The issue tracker of a repository URL: `<repository>/issues`, as GitHub, GitLab and Codeberg serve it. */
export const issuesUrl = (repository: string): string => `${repository.replace(/\.git$/, "")}/issues`

/** An author's name: what is left of it without ` <email>`. */
export const authorName = (author: string): string => author.replace(/ <[^<>]*>$/, "")
