/**
 * Extract the types a generated file needs from the app's source: its env, what its middleware
 * added (the app's own, and each route's beyond them), and its taps. Written inline, so the
 * generated file imports nothing from the app but the named types it references by `import()`,
 * each through a specifier the output can resolve. ts-morph is the caller's, passed in.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import type { ts } from "ts-morph"
import { addedProps, type ExtractedProp, frameworkClass, routeAdditions } from "./chain.ts"
import { Serializer } from "./serialize.ts"
import { type EntryOptions, loadEntry, registrations, type TsMorph } from "./walk.ts"

export type { ExtractedProp } from "./chain.ts"

export type ExtractOptions = EntryOptions & {
	/** where the generated file goes: `import()` specifiers are written relative to it */
	outputDir?: string
	/** what extraction skipped or could not do, said once each */
	report: (message: string) => void
	/** the router's id for a method and a full path (core's `routeId`); throws on a pattern it refuses */
	routeId: (method: string, path: string) => string
	tsMorph: TsMorph | undefined
}

export type ExtractedTypes = {
	env: string
	/** what the app's middleware and context values added */
	middleware: ExtractedProp[]
	/** per route id, what the route's middleware added beyond `middleware`; a route that added nothing has none */
	routes: Record<string, ExtractedProp[]>
	/** the declared tap payloads, or null when none are */
	taps: string | null
}

/* the type-only members every honey app carries */
const APP_MEMBERS = ["$ctx", "$env", "$taps"]

type PackageInfo = { dir: string; json: Record<string, unknown> }
type Packages = Map<string, PackageInfo | null>

/** The nearest named package.json above `file` (one without a name only marks a module type). */
function nearestPackage(file: string, cache: Packages): PackageInfo | null {
	const visited: string[] = []
	let found: PackageInfo | null = null
	for (let dir = dirname(file), prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
		const cached = cache.get(dir)
		if (cached !== undefined) {
			found = cached
			break
		}
		visited.push(dir)
		const json = readPackage(join(dir, "package.json"))
		if (typeof json?.name === "string") {
			found = { dir, json }
			break
		}
	}
	for (const dir of visited) cache.set(dir, found)
	return found
}

function readPackage(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	} catch {
		return null
	}
}

/** Every file an `exports` value can point at, under any condition, with the subpath that names it. */
function exportTargets(exports: unknown): { subpath: string; target: string }[] {
	const out: { subpath: string; target: string }[] = []
	const collect = (subpath: string, value: unknown): void => {
		if (typeof value === "string") out.push({ subpath, target: value })
		else if (value !== null && typeof value === "object") for (const v of Object.values(value)) collect(subpath, v)
	}
	const entries =
		exports !== null && typeof exports === "object" && !Array.isArray(exports) ? Object.entries(exports) : []
	if (entries.some(([key]) => key.startsWith("."))) for (const [key, value] of entries) collect(key, value)
	else collect(".", exports)
	return out
}

const stripExtension = (path: string): string => path.replace(/\.d\.[mc]?ts$|\.[mc]?tsx?$|\.[mc]?js$/, "")

/** `@types/foo` types `foo`; `@types/scope__name` types `@scope/name`. */
function typedPackage(name: string): string {
	if (!name.startsWith("@types/")) return name
	const bare = name.slice("@types/".length)
	return bare.includes("__") ? `@${bare.replace("__", "/")}` : bare
}

/** How the package `pkg` names its file `rel` (`./dist/x.d.ts`): an exports subpath, its types entry, or its path; null if it does not. */
function packageSpecifier(pkg: PackageInfo, rel: string): string | null {
	const name = typedPackage(String(pkg.json.name))
	const same = (target: string) => stripExtension(`./${target.replace(/^\.\//, "")}`) === stripExtension(rel)
	if (pkg.json.exports !== undefined) {
		const match = exportTargets(pkg.json.exports).find(({ target }) => same(target))
		if (match === undefined) return null
		return match.subpath === "." ? name : `${name}/${match.subpath.replace(/^\.\//, "")}`
	}
	const types = pkg.json.types ?? pkg.json.typings
	if (typeof types === "string" && same(types)) return name
	const sub = stripExtension(rel.slice(2)).replace(/\/index$/, "")
	return sub === "index" ? name : `${name}/${sub}`
}

/**
 * The specifier the output uses to import `file`: through its package when it is another
 * package's (a file the package does not export is reached relatively), else a relative path.
 */
function moduleSpecifier(file: string, outputDir: string | undefined, cache: Packages): string {
	const pkg = nearestPackage(file, cache)
	const own = outputDir === undefined ? null : nearestPackage(join(outputDir, "_"), cache)
	const external = pkg !== null && pkg.dir !== own?.dir
	const viaPackage = external ? packageSpecifier(pkg, `./${relative(pkg.dir, file).split(sep).join("/")}`) : null
	if (viaPackage !== null || outputDir === undefined) return viaPackage ?? file
	const rel = relative(outputDir, file).split(sep).join("/")
	return rel.startsWith(".") ? rel : `./${rel}`
}

/** `import("/abs/file.ts").X` → a specifier the output resolves (lib types are never referenced: they are global). */
function resolvable(text: string, outputDir: string | undefined, cache: Packages): string {
	return text.replace(
		/import\("([^"]+)"\)\./g,
		(_, file: string) => `import("${moduleSpecifier(file, outputDir, cache)}").`,
	)
}

/** The app's extracted types, or null (said once through `report`) without ts-morph. */
export function extractTypes(options: ExtractOptions): ExtractedTypes | null {
	const { exportName, report, routeId, tsMorph } = options
	if (tsMorph === undefined) {
		report("ts-morph is not installed: middleware and env types are not extracted (install ts-morph to type ctx)")
		return null
	}
	const entry = loadEntry(tsMorph, options)
	const { appType, checker, compiler } = entry
	const ser = new Serializer(checker, compiler)
	const members = APP_MEMBERS.map((name) => {
		const sym = appType.getProperty(name)
		return sym === undefined ? undefined : checker.getTypeOfSymbol(sym)
	})
	if (members.includes(undefined)) throw new Error(`Export "${exportName}" is not a honey app`)
	const [ctx, env, tapsType] = members as ts.Type[]
	const owner = frameworkClass(ctx as ts.Type, compiler)
	const middleware = addedProps(ctx as ts.Type, owner, ser)
	const base = new Set(middleware.map((p) => p.name))
	const routes = routeAdditions(registrations(entry), ser, { base, owner, report, routeId })
	const taps = ser.serialize(tapsType as ts.Type)

	const cache: Packages = new Map()
	const text = (t: string) => resolvable(t, options.outputDir, cache)
	const props = (list: readonly ExtractedProp[]) => list.map((p) => ({ ...p, type: text(p.type) }))
	return {
		env: text(ser.serialize(env as ts.Type)),
		middleware: props(middleware),
		routes: Object.fromEntries(Object.entries(routes).map(([id, list]) => [id, props(list)])),
		taps: taps === "{}" ? null : text(taps),
	}
}
