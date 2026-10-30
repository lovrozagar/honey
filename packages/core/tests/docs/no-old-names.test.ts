/**
 * No docs page or docs example names a v0 name v1 removed (bit 21 i7d): `throwOnError` and each language's
 * `--<lang>-throw-on-error`, the TS client's `TThrow` and its `<true>` argument, `SDKResult`, `SdkResult`,
 * `IsSuccess`, `ClientResult` and `requestSafe`. docs/migration.md is the one exemption: it is the page that tells a
 * reader what each name became, so it must name them. Every other file under docs/ is read, the example programs
 * included, since a removed name compiles nowhere and reads as current in prose.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { DOCS, REPO } from "../../../gen/src/emit/shared/__fixtures__/docs-blocks.ts"

/** The page that may name them: the migration guide, which exists to name them. */
export const EXEMPT = "docs/migration.md"

/**
 * Each removed name as the pattern that finds it, whole tokens only: `<true>` is caught after an identifier (the
 * client generic `Kitchen<true>`), never as the word `true` in prose about a boolean.
 */
export const REMOVED: readonly (readonly [string, RegExp])[] = [
	["throwOnError", /\bthrowOnError\b/],
	["--<lang>-throw-on-error", /--[a-z]+-throw-on-error\b/],
	["TThrow", /\bTThrow\b/],
	["<true>", /\w<\s*true\s*>/],
	["SDKResult", /\bSDKResult\b/],
	["SdkResult", /\bSdkResult\b/],
	["IsSuccess", /\bIsSuccess\b/],
	["ClientResult", /\bClientResult\b/],
	["requestSafe", /\brequestSafe\b/],
]

/**
 * What v0.7.3 shipped, by removed name: the path at the `v0.7.3` tag that holds it, or null for a name that tag
 * never had. migration.md is "0.7 to 1.0", so it may name a removed name only when a 0.7.3 user could have written
 * it; a name absent from the tag belongs to no migration, and the guide must not teach one.
 *
 * Pinned rather than read from the tag at test time: a CI checkout need not carry tags, and the tag is immutable, so
 * a pinned table is the same answer offline. Each path was read with
 * `git grep -l <name> v0.7.3 -- packages/core/src` (bit 21 i7d).
 */
export const SHIPPED_AT_V073: Readonly<Record<string, string | null>> = {
	"--<lang>-throw-on-error": null /* 0.7.3 had no generate CLI: the option was the codegen module's alone */,
	"<true>": "packages/core/src/client/types.ts" /* the argument of TThrow, which that file declares */,
	ClientResult: "packages/core/src/client/types.ts",
	IsSuccess: null /* 0.7.3 shipped no C# SDK */,
	SDKResult: "packages/core/src/client-go/result.go",
	SdkResult: "packages/core/src/client-rust/result.rs",
	TThrow: "packages/core/src/client/types.ts",
	requestSafe: "packages/core/src/client/http.ts",
	throwOnError: "packages/core/src/client/sdk.ts",
}

/** Every file under `dir`, repo-relative and sorted: pages and example programs alike. */
export function filesUnder(dir: string): string[] {
	return readdirSync(dir)
		.flatMap((name) => {
			const path = join(dir, name)
			return statSync(path).isDirectory() ? filesUnder(path) : [relative(REPO, path)]
		})
		.sort()
}

/** `<file>:<line> names <name>` for each removed name `text` holds, in the file's order. */
export function removedNames(file: string, text: string): string[] {
	return text
		.split("\n")
		.flatMap((line, index) =>
			REMOVED.filter(([, pattern]) => pattern.test(line)).map(([name]) => `${file}:${index + 1} names ${name}`),
		)
}

describe("the docs name no removed name (bit 21 i7d)", () => {
	it("reads every file under docs/, the example programs included, migration.md the one exemption", () => {
		const files = filesUnder(DOCS)
		expect({
			examples: files.filter((file) => file.startsWith("docs/examples/")).length,
			exempt: files.includes(EXEMPT),
			pages: files.filter((file) => file.endsWith(".md")).length,
		}).toEqual({ examples: 6, exempt: true, pages: 36 })
	})

	/* one line per removed name, so a name dropped from REMOVED reds here rather than going unread over the docs */
	it("finds every removed name on the line that holds it, and reads `true` in prose as none", () => {
		const page = [
			"a client that always throws",
			"generated with `throwOnError: true`",
			"honey-codegen generate --python-throw-on-error",
			"the client's TThrow parameter",
			"new Kitchen<true>({})",
			"it is true that SDKResult is gone",
			"and SdkResult with it",
			"reading IsSuccess",
			"a ClientResult of its own",
			"calling requestSafe",
		].join("\n")
		expect(removedNames("docs/x.md", page)).toEqual([
			"docs/x.md:2 names throwOnError",
			"docs/x.md:3 names --<lang>-throw-on-error",
			"docs/x.md:4 names TThrow",
			"docs/x.md:5 names <true>",
			"docs/x.md:6 names SDKResult",
			"docs/x.md:7 names SdkResult",
			"docs/x.md:8 names IsSuccess",
			"docs/x.md:9 names ClientResult",
			"docs/x.md:10 names requestSafe",
		])
	})

	it("judges every removed name against v0.7.3, none unjudged", () => {
		expect(Object.keys(SHIPPED_AT_V073).sort()).toEqual(REMOVED.map(([name]) => name).sort())
	})

	/* the guide and this guard in step: the exemption is not a licence to teach a migration nobody can make */
	it("lets migration.md name only the removed names v0.7.3 shipped", () => {
		const named = removedNames(EXEMPT, readFileSync(join(REPO, EXEMPT), "utf8")).map(
			(hit) => hit.split(" names ")[1] as string,
		)
		const unshipped = [...new Set(named)].filter((name) => SHIPPED_AT_V073[name] === null).sort()
		expect(unshipped).toEqual([])
	})

	it("names no removed name on any page or in any example", () => {
		const named = filesUnder(DOCS)
			.filter((file) => file !== EXEMPT)
			.flatMap((file) => removedNames(file, readFileSync(join(REPO, file), "utf8")))
		expect(named).toEqual([])
	})
})
