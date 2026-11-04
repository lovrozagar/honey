/**
 * The TypeScript SDK as a package (plan 39 8.3). Its sources stay where a workspace imports them, and the files each
 * registry takes go beside them. npm gets `dist/`: each source compiled to ES module JavaScript plus its declarations,
 * since node refuses to strip types under node_modules. JSR takes the sources themselves through `jsr.json`, written
 * when the name is scoped, as JSR names are. The sources import each other as `.js`, which every TypeScript
 * resolution and bundler maps to the `.ts` file and a consumer compiles under any flags; JSR is told to map them the
 * same way (sloppy imports). oxc's transform compiles both in one in-process pass that is the same
 * whichever runtime generates; no type checker runs, since the sources declare every exported type (isolated
 * declarations). The MCP server's `dist/` goes through the same pass.
 */
import { transformSync } from "oxc-transform"
import { checked, issuesUrl, type Metadata, NPM_NAME, SEMVER } from "../shared/metadata.ts"
import { type GeneratedSdk, generateSdk, type SdkOptions } from "./sdk.ts"

/** The SDK's options and the package's own. */
export type SdkPackageOptions = SdkOptions & {
	/** the npm name, and the JSR name when scoped; the stem by default */
	readonly packageName?: string
	/** the version both registries carry; the document's by default, `0.0.0` when that is not one npm accepts */
	readonly version?: string
}

/* the optional peer the TanStack adapter's types import, as npm and JSR range it */
const QUERY_CORE = "@tanstack/query-core"
const QUERY_CORE_RANGE = "^5.0.0"

/* each importable file's kind and the subpath it is exported at; the others are reached through the index */
const SUBPATHS: Readonly<Record<string, string>> = {
	index: ".",
	"tanstack-query": "./tanstack-query",
	webhook: "./webhook",
}

/**
 * `source` compiled by oxc: ES module JavaScript, and with `declaration` its isolated declarations, `@internal` members
 * left out ("" without). What does not compile is refused, naming `path`.
 */
export function compiled(path: string, source: string, declaration: boolean): { code: string; declaration: string } {
	const result = transformSync(path, source, {
		sourceType: "module",
		...(declaration ? { typescript: { declaration: { stripInternal: true } } } : {}),
	})
	if (result.errors.length > 0)
		throw new Error(`${path} does not compile: ${result.errors.map((error) => error.message).join("; ")}`)
	return { code: result.code, declaration: result.declaration ?? "" }
}

/** The subpaths `files` exports, each to what `target` makes of its source. */
function exportsOf(files: Readonly<Record<string, string>>, stem: string, target: (path: string) => unknown) {
	const kinds = Object.entries(SUBPATHS).filter(([kind]) => files[`${stem}.${kind}.gen.ts`] !== undefined)
	return Object.fromEntries(kinds.map(([kind, subpath]) => [subpath, target(`${stem}.${kind}.gen`)]))
}

/** The package.json fields the metadata fills, each only when given. */
function described(metadata: Metadata) {
	const { authors, description, homepage, keywords, license, repository } = metadata
	return {
		...(description === undefined ? {} : { description }),
		...(keywords === undefined ? {} : { keywords }),
		...(homepage === undefined ? {} : { homepage }),
		...(repository === undefined ? {} : { bugs: issuesUrl(repository) }),
		...(license === undefined ? {} : { license }),
		...(authors === undefined ? {} : { author: authors[0] }),
		...(repository === undefined
			? {}
			: { repository: { type: "git", url: `git+${repository.replace(/\.git$/, "")}.git` } }),
	}
}

/** The package.json npm installs: its exports the compiled JavaScript and declarations, nothing else shipped. */
function packageJson(sdk: GeneratedSdk, name: string, version: string, metadata: Metadata): string {
	const tanstack = sdk.files[`${sdk.stem}.tanstack-query.gen.ts`] !== undefined
	const manifest = {
		name,
		version,
		...described(metadata),
		type: "module",
		exports: exportsOf(sdk.files, sdk.stem, (file) => ({ types: `./dist/${file}.d.ts`, default: `./dist/${file}.js` })),
		files: ["dist"],
		sideEffects: false,
		engines: { node: ">=22" },
		...(tanstack
			? {
					peerDependencies: { [QUERY_CORE]: QUERY_CORE_RANGE },
					peerDependenciesMeta: { [QUERY_CORE]: { optional: true } },
				}
			: {}),
	}
	return `${JSON.stringify(manifest, null, "\t")}\n`
}

/** The jsr.json JSR publishes the sources by, for a scoped name. */
function jsrJson(sdk: GeneratedSdk, name: string, version: string, metadata: Metadata): string {
	const tanstack = sdk.files[`${sdk.stem}.tanstack-query.gen.ts`] !== undefined
	const config = {
		name,
		version,
		...(metadata.license === undefined ? {} : { license: metadata.license }),
		exports: exportsOf(sdk.files, sdk.stem, (file) => `./${file}.ts`),
		...(tanstack ? { imports: { [QUERY_CORE]: `npm:${QUERY_CORE}@${QUERY_CORE_RANGE}` } } : {}),
		/* the runtime reads browser globals (FileList, WebSocket) where they exist: JSR checks it with them declared */
		compilerOptions: { lib: ["esnext", "dom", "dom.iterable"] },
		/* the sources' `.js` imports name their `.ts` files */
		unstable: ["sloppy-imports"],
		publish: { include: ["*.gen.ts"] },
	}
	return `${JSON.stringify(config, null, "\t")}\n`
}

/** The SDK for `document` with its package files: the sources, `dist/`, package.json, and jsr.json when scoped. */
export function generateSdkPackage(
	document: Record<string, unknown>,
	options: SdkPackageOptions,
	metadata: Metadata,
): GeneratedSdk {
	checked("version", options.version, SEMVER)
	const sdk = generateSdk(document, options)
	const name = checked("packageName", options.packageName ?? sdk.stem.toLowerCase(), NPM_NAME) as string
	const stated = sdk.version !== undefined && SEMVER.test(sdk.version) ? sdk.version : "0.0.0"
	const version = options.version ?? stated
	const dist = Object.entries(sdk.files).flatMap(([path, source]) => {
		const { code, declaration } = compiled(path, source, true)
		const stem = `dist/${path.replace(/\.ts$/, "")}`
		return [
			[`${stem}.d.ts`, declaration],
			[`${stem}.js`, code],
		]
	})
	const files: Record<string, string> = {
		...sdk.files,
		...Object.fromEntries(dist),
		"package.json": packageJson(sdk, name, version, metadata),
	}
	if (name.startsWith("@")) files["jsr.json"] = jsrJson(sdk, name, version, metadata)
	return { ...sdk, files }
}
