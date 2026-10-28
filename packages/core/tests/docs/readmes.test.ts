/**
 * The READMEs (bit 20 d): the npm READMEs are a start, not the reference; the root README starts the same way and keeps
 * a develop section; every link in them, the packaging doc and the exports page resolves (a GitHub `blob/main` URL to
 * the repository file it names, a relative one from its own file); and every subpath either package exports is on the
 * exports page. Their code blocks compile with the docs' (examples-compile.test.ts). What ships in each tarball is
 * packaging.test.ts's.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { describe, expect, it } from "vitest"
import { REPO } from "../../../gen/src/emit/shared/__fixtures__/docs-blocks.ts"

const BLOB = "https://github.com/lovrozagar/honey/blob/main/"
/* the pages whose links this file holds to resolving */
const LINKED = [
	"README.md",
	"packages/core/README.md",
	"packages/gen/README.md",
	"packages/core/docs/packaging.md",
	"docs/packages.md",
]

const read = (path: string) => readFileSync(join(REPO, path), "utf8")

/** Each link in `markdown` (at `page`) that names no file: `page target`; a site other than this repository's blob is skipped. */
export function brokenLinks(page: string, markdown: string, exists: (path: string) => boolean): string[] {
	return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
		.map(([, target]) => target as string)
		.filter((target) => !target.startsWith("#"))
		.flatMap((target) => {
			const bare = target.split("#")[0] as string
			if (bare.startsWith(BLOB)) return [[target, bare.slice(BLOB.length)] as const]
			if (/^[a-z]+:/.test(bare)) return []
			return [[target, normalize(join(dirname(page), bare))] as const]
		})
		.filter(([, path]) => !exists(path))
		.map(([target]) => `${page} ${target}`)
}

const inRepo = (path: string) => existsSync(join(REPO, path))

describe("the READMEs' face", () => {
	// v0: df3a620f4a
	it("core's npm README is a start: install, honey init, serve(app), /docs, curl /health, and links, not the reference", () => {
		const readme = read("packages/core/README.md")
		const has = (pattern: RegExp) => pattern.test(readme)
		expect([
			has(/npm install @lovrozagar\/honey/),
			has(/honey init/),
			has(/serve\(app/),
			has(/\/docs/),
			has(/\bcurl\b/),
			has(/\/health/),
			has(/docs\/codegen\.md/),
			/* the reference lives in docs/, not here */
			has(/\| Value/),
			readme.split("\n").length < 120,
		]).toEqual([true, true, true, true, true, true, true, false, true])
	})

	// v0: d678624171
	it("the SDK targets live in the docs: codegen.md names all eight, and gen's README links it", () => {
		const page = read("docs/codegen.md")
		const targets = ["ts", "go", "rust", "python", "csharp", "java", "cli", "mcp"]
		expect([
			targets.filter((target) => !new RegExp(`\\b${target}\\b`).test(page)),
			read("packages/gen/README.md").includes(`${BLOB}docs/codegen.md`),
		]).toEqual([[], true])
	})

	// v0: c64d56ae7d
	it("the root README starts the same way, keeps a develop section, and shows no v0-only form", () => {
		const root = read("README.md")
		const has = (pattern: RegExp) => pattern.test(root)
		/* v0's README taught these, and 1.0 removed each (docs/migration.md) */
		const v0Only = [/app\.serve\(/, /\.ws\(["'/]/, /\.realtime\(/, /_v0\b/, /\/trust\b/].filter(has).map(String)
		expect([
			has(/honey init/),
			has(/serve\(app/),
			has(/\/docs/),
			has(/\bcurl\b/),
			has(/\/health/),
			has(/^## Develop$/m),
			v0Only,
		]).toEqual([true, true, true, true, true, true, []])
	})
})

describe("the READMEs' links", () => {
	it("resolve, in the READMEs, the packaging doc and the exports page", () => {
		expect(LINKED.flatMap((page) => brokenLinks(page, read(page), inRepo))).toEqual([])
	})

	it("report a broken one by page and target, relative or a blob URL", () => {
		const page = [
			"[ok](docs/README.md)",
			`[gone](${BLOB}docs/nowhere.md)`,
			"[also gone](missing.md#a)",
			"[site](https://npmjs.com)",
		]
		expect(brokenLinks("README.md", page.join("\n"), inRepo)).toEqual([
			`README.md ${BLOB}docs/nowhere.md`,
			"README.md missing.md#a",
		])
	})
})

describe("the exports page", () => {
	it("lists every subpath either package exports", () => {
		const page = read("docs/packages.md")
		const subpaths = (pkg: string, name: string) =>
			Object.keys((JSON.parse(read(`${pkg}/package.json`)) as { exports: Record<string, unknown> }).exports)
				.filter((subpath) => subpath !== "./package.json")
				.map((subpath) => (subpath === "." ? name : `${name}/${subpath.slice(2)}`))
		const all = [
			...subpaths("packages/core", "@lovrozagar/honey"),
			...subpaths("packages/gen", "@lovrozagar/honey-codegen"),
		]
		expect(all.filter((name) => !page.includes(`\`${name}\``))).toEqual([])
	})
})
