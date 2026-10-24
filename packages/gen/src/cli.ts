/**
 * The honey-codegen generate CLI (bit 17 phase h): `honey-codegen generate --spec <openapi.json> --target <name>...
 * --out <dir>` writes each target's generated files under `<out>/<target>`. A target's options are its generate
 * function's, spelled `--<target>-<option>` and passed through untouched: each generator validates its own. The go and
 * cli targets' whole trees go through gofmt (the post-pass), so a missing gofmt is a refusal, never unformatted Go.
 * `--watch` regenerates in a fresh child on each change of the spec. Parsing is strict: an unknown flag, a missing
 * value, a stray argument or an option for a target not asked for is a usage error. Loading an app (`--app`) waits for
 * bit 19, beside core's loaders; so does deleting the files a removed operation left.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { generateGoCli } from "./emit/cli/module.ts"
import { generateCSharpSdk } from "./emit/csharp/sdk.ts"
import { generateGoSdk } from "./emit/go/sdk.ts"
import { generateJavaSdk } from "./emit/java/sdk.ts"
import { generatePythonSdk } from "./emit/python/sdk.ts"
import { generateRustSdk } from "./emit/rust/sdk.ts"
import { formatFiles } from "./emit/shared/format.ts"
import { gofmtFormatter } from "./emit/shared/gofmt.ts"
import { generateSdk } from "./emit/ts/sdk.ts"
import { type Generate, type Options, parseGenerate, type Target, usage, UsageError } from "./gen/args.ts"
import { runCli } from "./gen/process.ts"

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

/** One target's files for `document`, by their path under the target's directory. */
function filesOf(
	target: Target,
	document: Record<string, unknown>,
	options: Options,
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
	}
}

/** Every file a run writes, by its path under `out`: each target's under its name, Go's through gofmt. */
export async function generated(run: Generate, document: Record<string, unknown>, env = process.env) {
	const out: Record<string, string> = {}
	for (const target of run.targets) {
		let files = filesOf(target, document, run.options[target])
		if (target === "go" || target === "cli") {
			const gofmt = findGofmt(env)
			if (gofmt === undefined)
				throw new Error("gofmt is required for the go and cli targets (install Go, or set GOFMT)")
			files = await formatFiles(files, { go: gofmtFormatter(gofmt) })
		}
		for (const [name, text] of Object.entries(files)) out[join(target, name)] = text
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

/** One generation: the spec read, every target generated, each file written under `out`. */
async function generateOnce(run: Generate, io: Io, env: NodeJS.ProcessEnv): Promise<number> {
	const files = await generated(run, readSpec(run.spec), env)
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(run.out, name)), { recursive: true })
		writeFileSync(join(run.out, name), text)
	}
	io.out(`honey-codegen: generated ${Object.keys(files).length} files into ${run.out}\n`)
	return 0
}

/** What a run takes beside its arguments: the environment, and a signal that stops a watch. */
export type RunOptions = { readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal }

/**
 * Generates now and on each change of the spec, each run a fresh child after the one before it (a change during a run
 * is one more run, never two at once); `signal` stops the watch, which then ends 0 once the last run is done. A
 * generation child (HONEY_CODEGEN_CHILD) never watches: were `--watch` ever passed down, each child would start another.
 */
function watchSpec(
	run: Generate,
	argv: readonly string[],
	io: Io,
	options: RunOptions & { readonly env: NodeJS.ProcessEnv },
): Promise<number> {
	if (options.env.HONEY_CODEGEN_CHILD === "1") throw new Error("--watch is not allowed in a generation child")
	const args = ["generate", ...argv.filter((arg) => arg !== "--watch" && !arg.startsWith("--watch="))]
	const spec = resolve(run.spec)
	let queue = Promise.resolve()
	const generate = () => {
		queue = queue.then(() =>
			runCli(args, { cwd: process.cwd(), env: options.env }).catch((error: Error) =>
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
		const env = options.env ?? process.env
		return run.watch
			? await watchSpec(run, argv.slice(1), io, { env, signal: options.signal })
			: await generateOnce(run, io, env)
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(`honey-codegen: ${error.message}\n\n${usage()}\n`)
			return 1
		}
		io.err(`honey-codegen: ${(error as Error).message}\n`)
		return 1
	}
}
