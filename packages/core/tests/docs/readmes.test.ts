/**
 * The READMEs (bit 22, the owner's ruling): each npm package's README is that package's complete guide, since that
 * page is what npm shows, and the root one is a short repository overview that points at both. This file holds them
 * to it: core's README covers every subpath it exports, every value its root export holds and every `dx/` area;
 * gen's covers every target and every flag its CLI takes; the root one stays an overview and links both. Every link
 * in them, the packaging doc and the exports page resolves, each page's contents matches its headings, and their code
 * blocks compile with the docs' (examples-compile.test.ts). What ships in each tarball is packaging.test.ts's.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { describe, expect, it } from "vitest"
import { blocksOf, READMES, REPO } from "../../../gen/src/emit/shared/__fixtures__/docs-blocks.ts"

const BLOB = "https://github.com/lovrozagar/honey/blob/main/"
/* the pages whose links this file holds to resolving */
const LINKED = [
	"README.md",
	"packages/core/README.md",
	"packages/gen/README.md",
	"packages/core/docs/packaging.md",
	"docs/packages.md",
]
/* the root README is an overview: a guide that grew back into it would show up here first */
const OVERVIEW_LINES = 120

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

/** A heading's GitHub anchor: lower-cased, anything but a word character, hyphen or space dropped, spaces hyphenated. */
export const slugOf = (heading: string): string =>
	heading
		.toLowerCase()
		.replaceAll(/[^\w\- ]+/g, "")
		.trim()
		.replaceAll(" ", "-")

/**
 * Where `markdown`'s table of contents and its headings disagree. The contents is every `- [text](#anchor)` line
 * before the first `##`, which is where it sits; the headings are every `##`/`###` after it. A heading left out, one
 * listed twice, a wrong order or an anchor that is not its heading's slug all show up here.
 */
export function tocDrift(markdown: string): string[] {
	const lines = markdown.split("\n")
	const firstHeading = lines.findIndex((line) => line.startsWith("## "))
	const listed = lines
		.slice(0, firstHeading === -1 ? lines.length : firstHeading)
		.flatMap((line) =>
			[...line.matchAll(/^\s*- \[([^\]]+)\]\(#([^)]+)\)/g)].map(([, text, anchor]) => ({ anchor, text })),
		)
	const headings = lines
		.slice(firstHeading === -1 ? 0 : firstHeading)
		.flatMap((line) => [...line.matchAll(/^(#{2,3}) (.+)$/g)].map(([, , text]) => text as string))
	const out: string[] = []
	for (const [at, heading] of headings.entries()) {
		const entry = listed[at]
		if (entry === undefined) out.push(`not in the contents: ${heading}`)
		else if (entry.text !== heading) out.push(`the contents reads ${entry.text} where the headings read ${heading}`)
		else if (entry.anchor !== slugOf(heading))
			out.push(`${heading}: the anchor is #${entry.anchor}, not #${slugOf(heading)}`)
	}
	for (const extra of listed.slice(headings.length)) out.push(`in the contents, not a heading: ${extra.text}`)
	return out
}

/** Every subpath `manifest` exports, as the specifier a user writes; the root export as `name` itself. */
export function specifiers(manifest: string, name: string): string[] {
	return Object.keys((JSON.parse(manifest) as { exports: Record<string, unknown> }).exports)
		.filter((subpath) => subpath !== "./package.json")
		.map((subpath) => (subpath === "." ? name : `${name}/${subpath.slice(2)}`))
}

/**
 * The values `source` (an index module) exports, type-only exports left out: a page shows a value by calling it, and
 * a type by naming it in a signature, so only the values are a coverage rule a guide can be held to. The type
 * helpers have a table of their own below.
 */
export function valueExports(source: string): string[] {
	return source
		.replaceAll(/export type \{[^}]*\}/g, "")
		.split(/export \{/)
		.slice(1)
		.flatMap((rest) => (rest.split("}")[0] as string).split(","))
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "" && !entry.startsWith("type "))
}

/** The `dx/` areas: one file per public surface area, `README.md` being the index rather than an area. */
const dxAreas = (): string[] =>
	readFileSync(join(REPO, "blueprint/dx/README.md"), "utf8")
		.split("\n")
		.flatMap((line) => [...line.matchAll(/^\| `([a-z-]+)\.md` \|/g)].map(([, area]) => area as string))

/**
 * The generate CLI's flags, read from gen's argument parser rather than listed here: the targets and their
 * `--<target>-<option>` options from its `TARGETS` table, and the global flags from the ones `takeFlag` matches. An
 * option added there and left out of gen's README reds the coverage leg below.
 */
export function generateFlags(source: string): { flags: string[]; targets: string[] } {
	const table = /const TARGETS = \{(.*?)\n\} as const/s.exec(source)?.[1] ?? ""
	const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
	const targets: string[] = []
	const flags = [...table.matchAll(/^\t(\w+): \[(.*)\],$/gm)].flatMap(([, target, options]) => {
		targets.push(target as string)
		return [...(options as string).matchAll(/"(\w+)"/g)].map(([, key]) => `--${target}-${kebab(key as string)}`)
	})
	const global = [...source.matchAll(/flag === "([a-z]+)"/g)].map(([, flag]) => `--${flag as string}`)
	return { flags: [...new Set([...global, ...flags])], targets }
}

describe("the npm READMEs are each their package's guide", () => {
	// v0: df3a620f4a
	/*
	 * Bit 22, the owner's ruling: npm shows the published package's own README, so each package's page is the
	 * complete guide for that package and bit 20's two caps on them are gone — the 120-line limit and the rule that
	 * a reference table lives only in docs/. What a reader must find in the first screen stays, and the coverage the
	 * caps used to stand in for is the compiled-block and coverage legs below.
	 */
	it("core's README is the framework's guide: the tagged install, honey init, serve(app), /docs, curl /health", () => {
		const readme = read("packages/core/README.md")
		const has = (pattern: RegExp) => pattern.test(readme)
		expect([
			has(/npm install @lovrozagar\/honey@next/),
			has(/release candidate/),
			has(/honey init/),
			has(/serve\(app/),
			has(/\/docs/),
			has(/\bcurl\b/),
			has(/\/health/),
			has(new RegExp(`${BLOB}docs/codegen\\.md`)),
		]).toEqual([true, true, true, true, true, true, true, true])
	})

	// v0: d678624171
	it("gen's README is the generator's guide: the tagged install, generate, all eight targets", () => {
		const readme = read("packages/gen/README.md")
		const targets = ["ts", "go", "rust", "python", "csharp", "java", "cli", "mcp"]
		expect([
			/npm install --save-dev @lovrozagar\/honey-clients@next/.test(readme),
			/honey-clients generate/.test(readme),
			targets.filter((target) => !new RegExp(`\`${target}\``).test(readme)),
			readme.includes(`${BLOB}docs/codegen.md`),
		]).toEqual([true, true, [], true])
	})

	// v0: c64d56ae7d
	it("the root README stays an overview: both packages, both installs, develop, and no v0-only form", () => {
		const root = read("README.md")
		const has = (pattern: RegExp) => pattern.test(root)
		/* v0's README taught these, and 1.0 removed each (docs/migration.md) */
		const v0Only = [/app\.serve\(/, /\.ws\(["'/]/, /\.realtime\(/, /_v0\b/, /\/trust\b/].filter(has).map(String)
		expect([
			has(/\]\(packages\/core\/README\.md\)/),
			has(/\]\(packages\/gen\/README\.md\)/),
			has(/npm install @lovrozagar\/honey@next/),
			has(/npm install --save-dev @lovrozagar\/honey-clients@next/),
			has(/^## Develop$/m),
			has(/^## Releases$/m),
			v0Only,
			root.split("\n").length <= OVERVIEW_LINES,
		]).toEqual([true, true, true, true, true, true, [], true])
	})
})

describe("the READMEs' table of contents", () => {
	it("reads a heading left out, a wrong order, a stale anchor and an entry with no heading", () => {
		const page = "- [One](#one)\n- [Two](#two)\n\n## One\n\n## Two\n"
		expect(tocDrift(page)).toEqual([])
		expect(tocDrift(page.replace("- [Two](#two)\n", ""))).toEqual(["not in the contents: Two"])
		expect(tocDrift(page.replace("- [One](#one)\n- [Two](#two)", "- [Two](#two)\n- [One](#one)"))).toEqual([
			"the contents reads Two where the headings read One",
			"the contents reads One where the headings read Two",
		])
		expect(tocDrift(page.replace("(#two)", "(#too)"))).toEqual(["Two: the anchor is #too, not #two"])
		expect(tocDrift(`${page}`.replace("## Two\n", ""))).toEqual(["in the contents, not a heading: Two"])
	})

	it("slugs a heading the way GitHub does", () => {
		expect(["A route, end to end", "What is in the box", "`ctx.res.*`"].map(slugOf)).toEqual([
			"a-route-end-to-end",
			"what-is-in-the-box",
			"ctxres",
		])
	})

	it("holds all three READMEs' contents to their headings", () => {
		for (const page of ["README.md", "packages/core/README.md", "packages/gen/README.md"])
			expect(tocDrift(read(page)), page).toEqual([])
	})
})

describe("the npm READMEs cover their package's surface", () => {
	/*
	 * The rule the owner asked for: a surface a package exports and its README never mentions is a surface nobody
	 * finds, since npm's page is where a reader starts. Each list is read from the package itself, so a new subpath,
	 * a new root value, a new `dx/` area or a new CLI option reds here until the guide names it.
	 */
	it("core's README names every subpath it exports and every value its root export holds", () => {
		const readme = read("packages/core/README.md")
		const subpaths = specifiers(read("packages/core/package.json"), "@lovrozagar/honey")
		const values = valueExports(read("packages/core/src/index.ts"))
		expect([
			subpaths.length > 40,
			subpaths.filter((name) => !readme.includes(name)),
			values.length > 10,
			values.filter((name) => !new RegExp(`\\b${name}\\b`).test(readme)),
		]).toEqual([true, [], true, []])
	})

	it("core's README links the docs page of every dx/ area", () => {
		const readme = read("packages/core/README.md")
		const areas = dxAreas()
		expect([areas.length > 15, areas.filter((area) => !readme.includes(`${BLOB}docs/${area}.md`))]).toEqual([true, []])
	})

	it("gen's README names every target, every flag its parser takes, and both its subpaths", () => {
		const readme = read("packages/gen/README.md")
		const { flags, targets } = generateFlags(read("packages/gen/src/gen/args.ts"))
		const subpaths = specifiers(read("packages/gen/package.json"), "@lovrozagar/honey-clients")
		expect([
			targets.length,
			flags.length > 20,
			targets.filter((target) => !new RegExp(`\`${target}\``).test(readme)),
			flags.filter((flag) => !readme.includes(flag)),
			subpaths.filter((name) => !readme.includes(name)),
			readme.includes("--help"),
		]).toEqual([8, true, [], [], [], true])
	})

	it("reads the surfaces it checks from the packages themselves, not from a list of its own", () => {
		expect(specifiers('{"exports":{".":{},"./ws/bun":{},"./package.json":"x"}}', "pkg")).toEqual(["pkg", "pkg/ws/bun"])
		const index = ['export { honey, type Honey } from "./a.ts"', "export type {\n\tOne,\n} from './b.ts'"].join("\n")
		expect(valueExports(index)).toEqual(["honey"])
		const args = ["const TARGETS = {", '\tts: ["name", "modulePath"],', "} as const satisfies X"].join("\n")
		expect(generateFlags(`${args}\nif (flag === "spec") x()`)).toEqual({
			flags: ["--spec", "--ts-name", "--ts-module-path"],
			targets: ["ts"],
		})
	})
})

describe("the READMEs show working code", () => {
	/*
	 * Not vacuous: each package's README must carry at least one block the docs' tests compile.
	 * `examples-compile.test.ts` type-checks every `ts` block of every page including these, and gen's compiles each
	 * `ts sdk` block against a generated SDK — but a README with no fenced TypeScript at all would pass both by
	 * having nothing to check. This is the leg that notices.
	 */
	it("each package README carries a block the tests compile, and names the pages that do not", () => {
		const compiled = new Set(["ts", "ts run", "ts sdk"])
		const without = READMES.filter(
			(page) => inRepo(page) && !blocksOf(page, read(page)).some((block) => compiled.has(block.info)),
		)
		/*
		 * The two package READMEs carry compiled code. The two below do not, and are pinned rather than excused: the
		 * root README is an overview whose code lives in the package guides, and packaging.md is prose about
		 * tarballs, so when either gains a TypeScript block this leg reds and whoever added it tightens the list.
		 */
		expect(without).toEqual(["README.md", "packages/core/docs/packaging.md"])
		for (const page of ["packages/core/README.md", "packages/gen/README.md"]) {
			const blocks = blocksOf(page, read(page)).filter((block) => compiled.has(block.info))
			expect(blocks.length, page).toBeGreaterThan(0)
		}
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
		const all = [
			...specifiers(read("packages/core/package.json"), "@lovrozagar/honey"),
			...specifiers(read("packages/gen/package.json"), "@lovrozagar/honey-clients"),
		]
		expect(all.filter((name) => !page.includes(`\`${name}\``))).toEqual([])
	})
})
