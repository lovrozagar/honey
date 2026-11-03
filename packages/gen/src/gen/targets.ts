/**
 * The targets honey-clients generates and each target's options (plan 39 8.1): the table the CLI reads
 * `--<target>-<option>` from, and what a caller holding a run as data (a release manifest) checks it with, so a new
 * target or option reaches that caller with no change of its own. The schemas are Standard Schemas (v1), the kind
 * honey takes everywhere, so any validator that reads one checks a run before it reaches `generated`.
 */

import { authorName, type Metadata } from "../emit/shared/metadata.ts"

/**
 * What `generate` can produce: an SDK per language (`csharp`, `go`, `java`, `python`, `rust`, `ts`), a Go `cli`, or an
 * `mcp` server.
 */
export const TARGETS = ["cli", "csharp", "go", "java", "mcp", "python", "rust", "ts"] as const

/** One of `TARGETS`. */
export type Target = (typeof TARGETS)[number]

/**
 * Each target and the names of its generate function's options, which `--<target>-<option>` carries as strings.
 * `--ts-tanstack-query` is the one switch that takes no value: it turns the TanStack Query adapter on.
 */
export const TARGET_OPTIONS = {
	cli: [
		"aur",
		"baseUrl",
		"binaryName",
		"description",
		"envPrefix",
		"homebrewTap",
		"homepage",
		"installUrl",
		"license",
		"maintainer",
		"modulePath",
		"packages",
		"repo",
		"scoopBucket",
		"wingetFork",
		"wingetPublisher",
	],
	csharp: [
		"authors",
		"clientName",
		"description",
		"homepage",
		"license",
		"packageId",
		"repository",
		"rootNamespace",
		"version",
	],
	go: ["modulePath"],
	java: [
		"artifactId",
		"clientName",
		"description",
		"developer",
		"groupId",
		"homepage",
		"license",
		"packageName",
		"repository",
		"version",
	],
	mcp: ["envPrefix", "name", "version"],
	python: ["packageName", "version"],
	rust: ["crateName", "description", "homepage", "keywords", "license", "repository", "version"],
	ts: ["name", "stem", "tanstackQuery"],
} as const satisfies { readonly [T in Target]: readonly string[] }

/**
 * The target options that take no value, since their name already says what they turn on
 * (`--ts-tanstack-query`, not `--ts-query tanstack`). They stay listed in `TARGET_OPTIONS` above, which is what
 * `packages/core/tests/docs/readmes.test.ts` reads to hold every flag to its README row; this table only
 * says how one is read. Bare is `true` and an inline `true`/`false` is read, exactly as `--watch` is.
 */
const BOOLEAN_OPTIONS = { cli: ["aur"], ts: ["tanstackQuery"] } as const satisfies {
	readonly [T in Target]?: readonly (typeof TARGET_OPTIONS)[T][number][]
}

/** The switches among `T`'s options: the ones `TargetOptions<T>` types as `"true"` or `"false"`. */
type BooleanOption<T extends Target> = T extends keyof typeof BOOLEAN_OPTIONS
	? (typeof BOOLEAN_OPTIONS)[T][number]
	: never

/** One target's options by camelCase name, each a string; a switch (`aur`, `tanstackQuery`) is `"true"` or `"false"`. */
export type TargetOptions<T extends Target> = {
	readonly [K in (typeof TARGET_OPTIONS)[T][number]]?: K extends BooleanOption<T> ? "true" | "false" : string
}

/** Any target's options by name, as the CLI parses and each generator reads them. */
export type Options = Readonly<Record<string, string>>

/** One problem a schema found: what is wrong, and the option it is about. */
export type OptionsIssue = {
	/** What is wrong, naming the target and the option. */
	readonly message: string
	/** The option's name, as the only segment; absent when the value is not an object at all. */
	readonly path?: readonly PropertyKey[]
}

/** What `validate` answers: the options it accepted, or every issue it found. */
export type OptionsResult<T extends Target> =
	| {
			/** The options, as given. */
			readonly value: TargetOptions<T>
			/** Absent: no issue was found. */
			readonly issues?: undefined
	  }
	| {
			/** Each problem found, one per option. */
			readonly issues: readonly OptionsIssue[]
	  }

/** A Standard Schema (standardschema.dev, v1) for one target's options; it validates synchronously. */
export type TargetOptionsSchema<T extends Target> = {
	/** The Standard Schema interface any validator that reads one calls. */
	readonly "~standard": {
		/** The Standard Schema version. */
		readonly version: 1
		/** Who made the schema. */
		readonly vendor: "honey-clients"
		/** Checks `value` as `T`'s options: its option names only, each a non-empty string, a switch true or false. */
		readonly validate: (value: unknown) => OptionsResult<T>
		/** The types the schema reads and answers, for a caller to infer from; never set at runtime. */
		readonly types?: {
			/** What `validate` takes: anything. */
			readonly input: unknown
			/** What `validate` answers when it finds no issue. */
			readonly output: TargetOptions<T>
		}
	}
}

/** Whether `target`'s option `key` takes no value. */
export function isBooleanOption(target: Target, key: string): boolean {
	const keys: readonly string[] = (BOOLEAN_OPTIONS as Partial<Record<Target, readonly string[]>>)[target] ?? []
	return keys.includes(key)
}

/** What is wrong with `target`'s option `key` set to `value`, if anything. */
function issueOf(target: Target, key: string, value: unknown): OptionsIssue | undefined {
	const keys: readonly string[] = TARGET_OPTIONS[target]
	if (!keys.includes(key))
		return { message: `unknown ${target} option ${JSON.stringify(key)}: want one of ${keys.join(", ")}`, path: [key] }
	if (isBooleanOption(target, key))
		return value === "true" || value === "false"
			? undefined
			: { message: `${target} option ${key}: want "true" or "false"`, path: [key] }
	return typeof value === "string" && value !== ""
		? undefined
		: { message: `${target} option ${key}: want a non-empty string`, path: [key] }
}

function schemaOf<T extends Target>(target: T): TargetOptionsSchema<T> {
	return {
		"~standard": {
			validate(value) {
				if (typeof value !== "object" || value === null || Array.isArray(value))
					return { issues: [{ message: `${target} options: want an object of option names to strings` }] }
				/* an option given as undefined is not given: a caller's optional field, never a value */
				const given = Object.entries(value).filter(([, option]) => option !== undefined)
				const issues = given.flatMap(([key, option]) => issueOf(target, key, option) ?? [])
				return issues.length > 0 ? { issues } : { value: Object.fromEntries(given) as TargetOptions<T> }
			},
			vendor: "honey-clients",
			version: 1,
		},
	}
}

/** Each target's options schema: its option names only, each a non-empty string, a switch `"true"` or `"false"`. */
export const targetOptionSchemas: { readonly [T in Target]: TargetOptionsSchema<T> } = /* @__PURE__ */ schemasOf()

function schemasOf(): { readonly [T in Target]: TargetOptionsSchema<T> } {
	return Object.fromEntries(TARGETS.map((target) => [target, schemaOf(target)])) as {
		readonly [T in Target]: TargetOptionsSchema<T>
	}
}

/** `value` as `target`'s options, or an error naming every problem its schema found. */
export function checkedOptions(target: Target, value: unknown): Options {
	const result = targetOptionSchemas[target]["~standard"].validate(value)
	if (result.issues !== undefined) throw new Error(result.issues.map((issue) => issue.message).join("; "))
	return result.value as Options
}

/** Reads one option's value out of the run's metadata. */
type FromMetadata = (metadata: Metadata) => string | undefined

const description: FromMetadata = (metadata) => metadata.description
const homepage: FromMetadata = (metadata) => metadata.homepage
const license: FromMetadata = (metadata) => metadata.license
const repository: FromMetadata = (metadata) => metadata.repository
const firstAuthor: FromMetadata = (metadata) => metadata.authors?.[0]

/**
 * The options each target fills from the run's metadata block (plan 39 8.2), each read from the field of the same
 * meaning: NuGet's authors are names, a POM's developer and the Linux packages' maintainer the first author whole,
 * crates.io's keywords the CLI's comma-separated list. A target's own option wins over its metadata.
 */
const FROM_METADATA: {
	readonly [T in Target]?: { readonly [K in (typeof TARGET_OPTIONS)[T][number]]?: FromMetadata }
} = {
	cli: { description, homepage, license, maintainer: firstAuthor },
	csharp: {
		authors: (metadata) => metadata.authors?.map(authorName).join(", "),
		description,
		homepage,
		license,
		repository,
	},
	java: { description, developer: firstAuthor, homepage, license, repository },
	rust: { description, homepage, keywords: (metadata) => metadata.keywords?.join(","), license, repository },
}

/** `target`'s options: those `metadata` fills, under the ones the run gives the target itself, checked. */
export function optionsFor(target: Target, metadata: Metadata, options: unknown): Options {
	const filled = Object.entries(FROM_METADATA[target] ?? {}).flatMap(([key, read]) => {
		const value = (read as FromMetadata)(metadata)
		return value === undefined ? [] : [[key, value] as const]
	})
	const given = checkedOptions(target, options)
	return { ...Object.fromEntries(filled), ...given }
}
