/**
 * A throwaway TypeScript project for the extract suites: a temp directory holding the app files a
 * case writes, a tsconfig, and `@lovrozagar/honey` mapped to a barrel over core's source. The barrel
 * is a user app's import, written as text; gen itself imports nothing from core (H2).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import * as tsMorph from "ts-morph"
import { type ExtractedProp, type ExtractOptions, extractTypes } from "../extract.ts"

/** What a fixture app imports from honey, by the names the package will export them under. */
function barrel(): string {
	const core = resolve(import.meta.dirname, "../../../../core/src")
	return [
		`export { Honey, honey } from "${core}/routing/app.ts"`,
		`export { createMiddleware } from "${core}/middleware/middleware.ts"`,
		`export type { HoneyContext } from "${core}/context/context.ts"`,
	].join("\n")
}

export const COMPILER_OPTIONS = {
	allowImportingTsExtensions: true,
	customConditions: ["honey-source"],
	lib: ["ES2024", "DOM"],
	module: "ESNext",
	moduleResolution: "Bundler",
	noEmit: true,
	paths: { "@lovrozagar/honey": ["./honey.ts"] },
	strict: true,
	target: "ES2022",
}

export type FixtureProject = {
	readonly root: string
	/** Write `content` at `rel` under the root; returns the absolute path. */
	write: (rel: string, content: string) => string
	dispose: () => void
}

/** A fresh project root with the barrel and a tsconfig (`compilerOptions` merged over the defaults). */
export function fixtureProject(compilerOptions: Record<string, unknown> = {}): FixtureProject {
	const root = mkdtempSync(join(tmpdir(), "honey-extract-"))
	const write = (rel: string, content: string): string => {
		const path = join(root, rel)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, content, "utf8")
		return path
	}
	write("honey.ts", barrel())
	write("tsconfig.json", JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, ...compilerOptions } }))
	return { dispose: () => rmSync(root, { force: true, recursive: true }), root, write }
}

export const lines = (...source: string[]): string => source.join("\n")

/** The caller's route id: the method and the type-level full path, with empty segments dropped. */
export const routeId = (method: string, path: string): string =>
	`${method} /${path.split("/").filter(Boolean).join("/")}`

/** `extractTypes` on the app exported as `app`, with ts-morph, and what it reported. */
export function extract(entryPath: string, options: Partial<ExtractOptions> = {}) {
	const reports: string[] = []
	const types = extractTypes({
		entryPath,
		exportName: "app",
		report: (m) => reports.push(m),
		routeId,
		tsMorph,
		...options,
	})
	return { reports, types: types as NonNullable<typeof types> }
}

/** The props as `name: type` lines, `?` on the optional ones. */
export const shown = (props: readonly ExtractedProp[] | undefined): string[] =>
	(props ?? []).map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)

/* every case loads core's source through the checker: a few seconds each under load */
export const SLOW = 60_000
