/**
 * The package metadata registries show, taken as options: the grammars every target checks a value against before it
 * reaches a manifest (a goreleaser YAML string, a `.csproj` element, a Groovy string), and the one refusal they share,
 * `Invalid <option>: "<value>"`. Each value is the caller's, never spec text, and is still escaped where it lands.
 */

/** One line of printable text, at most 4000 characters (nuget.org's description and authors limit). */
export const TEXT = /^\P{Cc}{1,4000}$/u
/** An https URL with a host. */
export const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/
/** An SPDX license expression: ids joined by AND, OR or WITH. */
export const SPDX_EXPRESSION = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/
/** One SPDX license list id, which spdx.org has a page for: not an expression, not a `LicenseRef-`. */
export const SPDX_ID = /^(?!LicenseRef-)[A-Za-z0-9][A-Za-z0-9.+-]*$/
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
