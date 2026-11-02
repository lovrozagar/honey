/**
 * The honey-clients generate CLI (bit 17 phase h): `honey-clients generate --spec <openapi.json> --target <name>...
 * --out <dir>` writes each target's generated files under `<out>/<target>`. A target's options are its generate
 * function's, spelled `--<target>-<option>` and passed through untouched: each generator validates its own. The go and
 * cli targets' whole trees go through gofmt (the post-pass), so a missing gofmt is a refusal, never unformatted Go; the
 * ts target's files go through oxfmt, the optional peer, imported lazily, and go out as emitted without it (00-rules).
 * `--watch` regenerates in a fresh child on each change of the spec. Parsing is strict: an unknown flag, a missing
 * value, a stray argument or an option for a target not asked for is a usage error. Each target is written through
 * write.ts: only changed files, a hashed manifest, a removed operation's unedited files deleted (bit 19 h1). `--app`
 * generates from a honey app module instead of a spec, its document made by the app's own core (ir/load.ts, bit 19 h2).
 */
import { readFileSync, watch } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { generateGoCli } from "./emit/cli/module.ts"
import { generateCSharpSdk } from "./emit/csharp/sdk.ts"
import { generateGoSdk } from "./emit/go/sdk.ts"
import { generateJavaSdk } from "./emit/java/sdk.ts"
import { generateMcpServer } from "./emit/mcp/server.ts"
import { generatePythonSdk } from "./emit/python/sdk.ts"
import { generateRustSdk } from "./emit/rust/sdk.ts"
import { formatFiles } from "./emit/shared/format.ts"
import { generateSdk } from "./emit/ts/sdk.ts"
import { type Generate, type Options, parseGenerate, type Target, usage, UsageError } from "./gen/args.ts"
import { FORMATTERS, formatterFor, missingFormatter } from "./gen/formatters.ts"
import { runCli } from "./gen/process.ts"
import { appRef, loadAppDocument } from "./ir/load.ts"
import { writeTarget } from "./gen/write.ts"

/** One SDK target's generation: its files and what it reports (a name it renamed). */
function sdkOf(target: Exclude<Target, "cli" | "mcp">, document: Record<string, unknown>, options: Options) {
	switch (target) {
		case "ts":
			/* mapped key by key, never spread: `options` holds strings, and `tanstackQuery` is a boolean —
			   a spread under a cast would make "false" as truthy as "true" */
			return generateSdk(document, {
				name: options.name ?? "SDK",
				...(options.stem === undefined ? {} : { stem: options.stem }),
				tanstackQuery: options.tanstackQuery === "true",
			})
		case "go":
			return generateGoSdk(document, options)
		case "rust":
			return generateRustSdk(document, options)
		case "python":
			return generatePythonSdk(document, options)
		case "csharp":
			return generateCSharpSdk(document, options)
		case "java":
			return generateJavaSdk(document, options)
	}
}

/** One target's files for `document`, by their path under the target's directory; what it leaves out to `report`. */
function filesOf(
	target: Target,
	document: Record<string, unknown>,
	options: Options,
	report: (line: string) => void,
): Readonly<Record<string, string>> {
	if (target === "cli") return generateGoCli(document, options).files
	if (target === "mcp") {
		const server = generateMcpServer(document, options)
		for (const op of server.skipped) report(`honey-clients: mcp: no tool serves ${op} yet: skipped\n`)
		return server.files
	}
	const sdk = sdkOf(target, document, options)
	for (const notice of sdk.notices) report(`honey-clients: ${notice}\n`)
	return sdk.files
}

/**
 * What one run generates: its targets, and each target's options by name (a target whose options are left out
 * takes its generator's defaults). The CLI parses `generate` into one of these; a consumer writes one by hand.
 */
export type GenerateRun = {
	/** Each target's options by name, as `--<target>-<option>` carries them; a target left out takes its defaults. */
	readonly options?: Readonly<Partial<Record<Target, Options>>>
	/** The targets to generate, in the order given. */
	readonly targets: readonly Target[]
}

/** What a generation reads beside its run: the environment, where skips are reported, the oxfmt module to load. */
export type GenerateContext = {
	/**
	 * Where formatters are looked up (`PATH`, `GOROOT`, `GOFMT`, `RUFF`, `RUSTFMT`); `HONEY_REQUIRE_FORMATTERS=1` makes
	 * a missing one throw.
	 */
	readonly env: NodeJS.ProcessEnv
	/**
	 * Receives each notice as one newline-terminated line: a name an SDK renamed, an operation no MCP tool serves, a
	 * missing formatter.
	 */
	readonly report: (line: string) => void
	/**
	 * The module specifier oxfmt is imported from, "oxfmt" by default; when it is not installed, TS goes out as
	 * emitted, unreported.
	 */
	readonly oxfmt?: string
}

/** A run's files: each generated target's files by path under that target's directory. */
export type GeneratedFiles = Partial<Record<Target, Readonly<Record<string, string>>>>

/**
 * Every file a run writes, by target and its path under the target's directory. Go goes through gofmt, Python through
 * ruff, Rust through rustfmt and TS through oxfmt; C# and Java go out as emitted, as does a target whose formatter is
 * missing, unless `HONEY_REQUIRE_FORMATTERS=1` makes that throw.
 */
export async function generated(
	run: GenerateRun,
	document: Record<string, unknown>,
	{ env, oxfmt, report }: GenerateContext,
): Promise<GeneratedFiles> {
	const out: GeneratedFiles = {}
	for (const target of run.targets) {
		let files = filesOf(target, document, run.options?.[target] ?? {}, report)
		const pass = FORMATTERS[target]
		if (pass !== undefined) {
			const formatter = await formatterFor(target, { env, oxfmt })
			if (formatter === undefined) missingFormatter(target, pass, env, report)
			else files = await formatFiles(files, { [pass.extension]: formatter })
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
export type Io = {
	/** Receives the CLI's standard output, whole lines ending in a newline: the usage text and each run's summary. */
	readonly out: (text: string) => void
	/**
	 * Receives the CLI's standard error, ending in a newline: failures, usage errors, notices and stale files it kept.
	 */
	readonly err: (text: string) => void
}

const PROCESS_IO: Io = {
	err: (text) => void process.stderr.write(text),
	out: (text) => void process.stdout.write(text),
}

/**
 * `document`'s targets generated and written under `<out>/<target>`, stale files deleted unless edited since (those are
 * kept and named on `io.err`).
 */
export async function writeGenerated(
	run: GenerateRun & {
		/** The directory each target's directory is written under. */
		readonly out: string
	},
	document: Record<string, unknown>,
	io: Io,
	env: NodeJS.ProcessEnv,
): Promise<number> {
	let count = 0
	for (const [target, files] of Object.entries(await generated(run, document, { env, report: io.err }))) {
		for (const rel of writeTarget(join(run.out, target), files).kept)
			io.err(
				`honey-clients: ${join(target, rel)} is stale but edited since it was generated, or not its to delete: kept\n`,
			)
		count += Object.keys(files).length
	}
	io.out(`honey-clients: generated ${count} files into ${run.out}\n`)
	return 0
}

/** One generation: the spec read, or the app's document made (the module resolved from `cwd`), then written. */
async function generateOnce(run: Generate, io: Io, env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
	const document = run.app === "" ? readSpec(resolve(cwd, run.spec)) : await loadAppDocument(run.app, cwd)
	return writeGenerated({ ...run, out: resolve(cwd, run.out) }, document, io, env)
}

/** What a run takes beside its arguments: the environment, the directory paths resolve from, a watch's stop signal. */
export type RunOptions = {
	/** The directory the spec, the app module and `--out` resolve from. Defaults to the process's. */
	readonly cwd?: string
	/**
	 * The environment formatters are looked up in, laid over the process's for each `--watch` child. Defaults to the
	 * process's.
	 */
	readonly env?: NodeJS.ProcessEnv
	/**
	 * Stops a `--watch` run, which ends with 0 once the generation in progress finishes. Without it a watch never
	 * returns.
	 */
	readonly signal?: AbortSignal
}

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
				io.err(`honey-clients: ${error.message}\n`),
			),
		)
	}
	let timer: NodeJS.Timeout | undefined
	const watcher = watch(dirname(spec), (_event, name) => {
		if (name !== basename(spec)) return
		clearTimeout(timer)
		timer = setTimeout(generate, 100)
	})
	io.out(`honey-clients: watching ${spec}\n`)
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

/** Runs `honey-clients <argv>`: the exit code it ends with (a watch ends only by `options.signal`). */
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
			io.err(`honey-clients: ${error.message}\n\n${usage()}\n`)
			return 1
		}
		io.err(`honey-clients: ${(error as Error).message}\n`)
		return 1
	}
}
