/**
 * The honey-codegen generate CLI (bit 17 phase h): `honey-codegen generate --spec <openapi.json> --target <name>...
 * --out <dir>` writes each target's generated files under `<out>/<target>`. A target's options are its generate
 * function's, spelled `--<target>-<option>` and passed through untouched: each generator validates its own. The go and
 * cli targets' whole trees go through gofmt (the post-pass), so a missing gofmt is a refusal, never unformatted Go.
 * `--watch` regenerates in a fresh child on each change of the spec. Parsing is strict: an unknown flag, a missing
 * value, a stray argument or an option for a target not asked for is a usage error. Each target is written through
 * write.ts: only changed files, a hashed manifest, a removed operation's unedited files deleted (bit 19 h1). `--app`
 * generates from a honey app module instead of a spec, its document made by the app's own core (ir/load.ts, bit 19 h2).
 */
import { existsSync, readFileSync, realpathSync, statSync, watch } from "node:fs"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { generateGoCli } from "./emit/cli/module.ts"
import { generateCSharpSdk } from "./emit/csharp/sdk.ts"
import { generateGoSdk } from "./emit/go/sdk.ts"
import { generateJavaSdk } from "./emit/java/sdk.ts"
import { generateMcpServer } from "./emit/mcp/server.ts"
import { generatePythonSdk } from "./emit/python/sdk.ts"
import { generateRustSdk } from "./emit/rust/sdk.ts"
import { formatFiles } from "./emit/shared/format.ts"
import { gofmtFormatter } from "./emit/shared/gofmt.ts"
import { generateSdk } from "./emit/ts/sdk.ts"
import { type Generate, type Options, parseGenerate, type Target, usage, UsageError } from "./gen/args.ts"
import { runCli } from "./gen/process.ts"
import { appRef, loadAppDocument } from "./ir/load.ts"
import { writeTarget } from "./gen/write.ts"

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
	if (env.GOFMT) return env.GOFMT
	const fromRoot = env.GOROOT ? join(env.GOROOT, "bin", "gofmt") : undefined
	if (fromRoot !== undefined && existsSync(fromRoot)) return fromRoot
	const go = onPath("go", env)
	const beside = go === undefined ? undefined : join(dirname(realpathSync(go)), "gofmt")
	return onPath("gofmt", env) ?? (beside !== undefined && existsSync(beside) ? beside : undefined)
}

/** One target's files for `document`, by their path under the target's directory; what it leaves out to `report`. */
function filesOf(
	target: Target,
	document: Record<string, unknown>,
	options: Options,
	report: (line: string) => void,
): Readonly<Record<string, string>> {
	switch (target) {
		case "ts":
			return generateSdk(document, { name: "SDK", ...options } as Parameters<typeof generateSdk>[1]).files
		case "go":
			return generateGoSdk(document, options).files
		case "rust":
			return generateRustSdk(document, options).files
		case "python":
			return generatePythonSdk(document, options).files
		case "csharp":
			return generateCSharpSdk(document, options).files
		case "java":
			return generateJavaSdk(document, options).files
		case "cli":
			return generateGoCli(document, options).files
		case "mcp": {
			const server = generateMcpServer(document, options)
			for (const op of server.skipped) report(`honey-codegen: mcp: no tool serves ${op} yet: skipped\n`)
			return server.files
		}
	}
}

/** Every file a run writes, by target and its path under the target's directory, Go's through gofmt; skips to `report`. */
export async function generated(
	run: Pick<Generate, "options" | "targets">,
	document: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
	report: (line: string) => void,
) {
	const out: Partial<Record<Target, Readonly<Record<string, string>>>> = {}
	for (const target of run.targets) {
		let files = filesOf(target, document, run.options[target], report)
		if (target === "go" || target === "cli") {
			const gofmt = findGofmt(env)
			if (gofmt === undefined)
				throw new Error("gofmt is required for the go and cli targets (install Go, or set GOFMT)")
			files = await formatFiles(files, { go: gofmtFormatter(gofmt) })
		}
		out[target] = files
	}
	return out
}

/** The spec at `path`, parsed. */
function readSpec(path: string): Record<string, unknown> {
	const text = readFileSync(path, "utf8")
	try {
		return JSON.parse(text) as Record<string, unknown>
	} catch (error) {
		throw new Error(`${path}: not a JSON document (${(error as Error).message})`, { cause: error })
	}
}

/** Where the CLI writes: standard output and standard error, by default the process's. */
export type Io = { readonly out: (text: string) => void; readonly err: (text: string) => void }

const PROCESS_IO: Io = {
	err: (text) => void process.stderr.write(text),
	out: (text) => void process.stdout.write(text),
}

/** `document`'s targets generated and written under `<out>/<target>`, stale files deleted (core's plugin calls it too). */
export async function writeGenerated(
	run: Pick<Generate, "options" | "out" | "targets">,
	document: Record<string, unknown>,
	io: Io,
	env: NodeJS.ProcessEnv,
): Promise<number> {
	let count = 0
	for (const [target, files] of Object.entries(await generated(run, document, env, io.err))) {
		for (const rel of writeTarget(join(run.out, target), files).kept)
			io.err(
				`honey-codegen: ${join(target, rel)} is stale but edited since it was generated, or not its to delete: kept\n`,
			)
		count += Object.keys(files).length
	}
	io.out(`honey-codegen: generated ${count} files into ${run.out}\n`)
	return 0
}

/** One generation: the spec read, or the app's document made (the module resolved from `cwd`), then written. */
async function generateOnce(run: Generate, io: Io, env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
	const document = run.app === "" ? readSpec(resolve(cwd, run.spec)) : await loadAppDocument(run.app, cwd)
	return writeGenerated({ ...run, out: resolve(cwd, run.out) }, document, io, env)
}

/** What a run takes beside its arguments: the environment, the directory paths resolve from, a watch's stop signal. */
export type RunOptions = { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal }

/**
 * Generates now and on each change of the spec, each run a fresh child after the one before it (a change during a run
 * is one more run, never two at once); `signal` stops the watch, which then ends 0 once the last run is done. A
 * generation child (HONEY_CODEGEN_CHILD) never watches: were `--watch` ever passed down, each child would start another.
 */
function watchSpec(
	run: Generate,
	argv: readonly string[],
	io: Io,
	options: RunOptions & { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<number> {
	if (options.env.HONEY_CODEGEN_CHILD === "1") throw new Error("--watch is not allowed in a generation child")
	const args = ["generate", ...argv.filter((arg) => arg !== "--watch" && !arg.startsWith("--watch="))]
	const spec = resolve(options.cwd, run.app === "" ? run.spec : appRef(run.app).module)
	let queue = Promise.resolve()
	const generate = () => {
		queue = queue.then(() =>
			runCli(args, { cwd: options.cwd, env: options.env }).catch((error: Error) =>
				io.err(`honey-codegen: ${error.message}\n`),
			),
		)
	}
	let timer: NodeJS.Timeout | undefined
	const watcher = watch(dirname(spec), (_event, name) => {
		if (name !== basename(spec)) return
		clearTimeout(timer)
		timer = setTimeout(generate, 100)
	})
	io.out(`honey-codegen: watching ${spec}\n`)
	generate()
	return new Promise((settle) =>
		options.signal?.addEventListener(
			"abort",
			() => {
				watcher.close()
				clearTimeout(timer)
				void queue.then(() => settle(0))
			},
			{ once: true },
		),
	)
}

/** Runs `honey-codegen <argv>`: the exit code it ends with (a watch ends only by `options.signal`). */
export async function main(argv: readonly string[], io: Io = PROCESS_IO, options: RunOptions = {}): Promise<number> {
	try {
		if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv.includes("--help")) {
			io.out(`${usage()}\n`)
			return argv.length === 0 ? 1 : 0
		}
		if (argv[0] !== "generate") throw new UsageError(`unknown command ${JSON.stringify(argv[0])}`)
		const run = parseGenerate(argv.slice(1))
		const [env, cwd] = [options.env ?? process.env, options.cwd ?? process.cwd()]
		return run.watch
			? await watchSpec(run, argv.slice(1), io, { cwd, env, signal: options.signal })
			: await generateOnce(run, io, env, cwd)
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(`honey-codegen: ${error.message}\n\n${usage()}\n`)
			return 1
		}
		io.err(`honey-codegen: ${(error as Error).message}\n`)
		return 1
	}
}
