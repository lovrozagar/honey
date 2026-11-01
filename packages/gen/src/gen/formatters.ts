/**
 * How each target's files are formatted (F4): one row per target, the binary each row finds, and what a run
 * says when it cannot find one. The pipeline reads this table and nothing else, so adding a language is a row
 * rather than another branch, and a language with no row is visibly unformatted here instead of unformatted
 * by omission.
 */
import { existsSync, realpathSync, statSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import type { Formatter } from "../emit/shared/format.ts"
import { gofmtFormatter } from "../emit/shared/gofmt.ts"
import { ruffFormatter } from "../emit/shared/ruff.ts"
import { rustfmtFormatter } from "../emit/shared/rustfmt.ts"
import type { Target } from "./args.ts"

/**
 * The binary a caller named through an environment variable, checked here at the edge. An override that
 * points at nothing is a mistake in how the run was configured, so it is a named error: falling back to some
 * other binary would ignore an explicit instruction, and spawning it would surface inside the post-pass,
 * which raises a failure there as though honey had emitted source the formatter could not parse.
 */
function named(variable: string, path: string | undefined): string | undefined {
	if (path === undefined || path === "") return undefined
	if (!existsSync(path)) throw new Error(`${variable}=${path} is not there`)
	return path
}

/** An executable named `name` on PATH, or none. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	return (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((dir) => join(dir, name))
		.find((path) => existsSync(path) && statSync(path).isFile())
}

/**
 * The gofmt the go and cli targets are formatted with: `$GOFMT`, else `$GOROOT/bin/gofmt`, else gofmt on PATH, else
 * the gofmt beside the real `go` on PATH (where every Go install keeps it); none when no Go is installed. Found by
 * looking, never by running Go.
 */
export function findGofmt(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = named("GOFMT", env.GOFMT)
	if (override !== undefined) return override
	const fromRoot = env.GOROOT ? join(env.GOROOT, "bin", "gofmt") : undefined
	if (fromRoot !== undefined && existsSync(fromRoot)) return fromRoot
	const go = onPath("go", env)
	const beside = go === undefined ? undefined : join(dirname(realpathSync(go)), "gofmt")
	return onPath("gofmt", env) ?? (beside !== undefined && existsSync(beside) ? beside : undefined)
}

/**
 * The pinned ruff, or none: `RUFF` names it, else PATH. A named path that is not there counts as none, so a
 * stale override is a skip with its own line rather than a spawn failure deep in the post-pass, which
 * `formatFiles` would raise as though honey had emitted unparseable Python.
 */
export function findRuff(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return named("RUFF", env.RUFF) ?? onPath("ruff", env)
}

/**
 * The pinned rustfmt, or none: `RUSTFMT` names it, else PATH, else the active toolchain's own binary beside
 * rustc. The rustup proxy on PATH would pick a toolchain by cwd, so a sysroot binary is preferred over it.
 */
export function findRustfmt(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = named("RUSTFMT", env.RUSTFMT)
	if (override !== undefined) return override
	const rustc = onPath("rustc", env)
	const beside = rustc === undefined ? undefined : join(dirname(realpathSync(rustc)), "rustfmt")
	return (beside !== undefined && existsSync(beside) ? beside : undefined) ?? onPath("rustfmt", env)
}

/** oxfmt's `format`, the optional peer, when installed; else undefined (TS then goes out as emitted). */
export async function loadOxfmt(specifier = "oxfmt"): Promise<Formatter | undefined> {
	try {
		return ((await import(specifier)) as { format: Formatter }).format
	} catch (error) {
		if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return undefined
		throw error
	}
}

/** What one target's formatting is: the extension the post-pass dispatches on, and what to say about the tool. */
export type FormatPass = {
	readonly extension: string
	readonly install: string
	/**
	 * Say nothing when this one is absent. Only `ts`: oxfmt is honey's own choice of TS formatter and a
	 * declared optional peer, so a consumer is not expected to have it and "TS goes out as emitted" is the
	 * documented rule (Q12, `blueprint/00-rules.md`). ruff, rustfmt and gofmt are the language's own standard
	 * tools, which a developer of that language has — honey simply never called them, and silence there is
	 * what let unformatted Python ship.
	 */
	readonly quiet?: true
	readonly tool: string
}

const GO_PASS: FormatPass = { extension: "go", install: "install Go, or set GOFMT", tool: "gofmt" }

/**
 * Every target that has a formatter, one row each (F4). A target absent from this table has none in this
 * repository and its files go out as the emitter wrote them, which is visible here rather than implied by a
 * missing branch: `csharp` and `java` are absent because `dotnet format` and google-java-format work over a
 * project rather than stdin and need a formatter `formatFiles` does not have yet.
 */
export const FORMATTERS: Partial<Record<Target, FormatPass>> = {
	cli: GO_PASS,
	go: GO_PASS,
	python: { extension: "py", install: "install ruff, or set RUFF", tool: "ruff" },
	rust: { extension: "rs", install: "install rustfmt, or set RUSTFMT", tool: "rustfmt" },
	ts: { extension: "ts", install: "install oxfmt", quiet: true, tool: "oxfmt" },
}

/**
 * The formatter for `target`, or none when its binary is not there. Each factory is named here rather than
 * held in the table's rows: `honey/spawn-timeout` proves which exports reach a spawn by walking named calls
 * (`packages/core/lint/spawners.js`), and a closure in a table is opaque to that walk — which would leave a
 * test calling `generated()` free of the bound it needs, since the spawn is real either way.
 */
export async function formatterFor(
	target: Target,
	where: { env: NodeJS.ProcessEnv; oxfmt?: string | undefined },
): Promise<Formatter | undefined> {
	const { env, oxfmt } = where
	switch (target) {
		case "cli":
		case "go": {
			const gofmt = findGofmt(env)
			return gofmt === undefined ? undefined : gofmtFormatter(gofmt)
		}
		case "python": {
			const ruff = findRuff(env)
			return ruff === undefined ? undefined : ruffFormatter(ruff)
		}
		case "rust": {
			const rustfmt = findRustfmt(env)
			return rustfmt === undefined ? undefined : rustfmtFormatter(rustfmt)
		}
		case "ts":
			return await loadOxfmt(oxfmt)
		default:
			return undefined
	}
}

/**
 * A formatter that is not there: the files go out as emitted and the skip is named, so unformatted output is
 * never silent. A consumer generating a Python SDK should not need ruff to get valid Python.
 *
 * `HONEY_REQUIRE_FORMATTERS=1` makes it fail instead, for a pipeline that would rather stop than ship
 * unformatted code. Deliberately NOT `HONEY_REQUIRE_TOOLCHAINS`, which this repository's CI sets on six jobs
 * to mean "these TESTS need their toolchain, do not skip" — reading it here turned every incidental
 * generation in CI without oxfmt into a hard failure, which is how rc.10's release run died.
 */
export function missingFormatter(
	target: Target,
	pass: FormatPass,
	env: NodeJS.ProcessEnv,
	report: (line: string) => void,
): void {
	const said = `${pass.tool} was not found, so the ${target} output is not formatted (${pass.install})`
	/* an explicit demand is honoured for every target, quiet or not: the caller asked to be stopped */
	if (env.HONEY_REQUIRE_FORMATTERS === "1") throw new Error(said)
	if (pass.quiet !== true) report(`honey-clients: ${said}\n`)
}
