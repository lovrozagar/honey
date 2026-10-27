/**
 * The `honey` CLI (bit 19 h2): `honey generate [--watch]` writes the app's artifacts as the plugin does, from the
 * `honey()` config in the Vite config (else `--app` alone), and `honey init` scaffolds a project. A generation runs
 * once and the bin then exits, whatever the app left running; `--watch` runs each generation in a fresh child, after
 * the one before it, on each edit next to the app. The SDKs, the CLI and MCP are honey-codegen's (Q1).
 */
import { existsSync, statSync, watch } from "node:fs"
import { dirname, resolve } from "node:path"
import { type CliFlags, parseGenerateArgs, parseInitFlags, USAGE, UsageError } from "./cli-args.ts"
import {
	generatedOutputs,
	type HoneyVitePluginConfig,
	isGeneratedOutput,
	type ResolvedHoneyConfig,
	resolveHoneyConfig,
} from "./config.ts"
import { generateAndWrite } from "./generate.ts"
import { WATCH_IGNORE_RE } from "./glob.ts"
import { runInit } from "./init.ts"
import { createModuleLoader, findViteConfig, loadPluginConfigs, type ModuleLoader } from "./loaders.ts"
import { runGenerate, serialized } from "./plugin.ts"

export type Io = { readonly err: (text: string) => void; readonly out: (text: string) => void }
export type RunOptions = { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal }

/** One honey() config: `--plugin` by index, else the only one, else the one whose app is `--app`. */
function pick(configs: HoneyVitePluginConfig[], flags: CliFlags, path: string, cwd: string) {
	if (flags.plugin !== undefined) {
		const picked = configs[flags.plugin]
		if (picked === undefined)
			throw new UsageError(`--plugin ${flags.plugin}: ${path} has ${configs.length} honey() plugin(s)`)
		return picked
	}
	if (configs.length <= 1) return configs[0]
	const app = flags.app === undefined ? undefined : resolve(cwd, flags.app)
	const byApp = configs.filter((config) => config.app !== undefined && resolve(cwd, config.app) === app)
	if (byApp.length === 1) return byApp[0]
	const apps = configs.map((config, index) => `  ${index}: ${config.app ?? "(no app)"}`).join("\n")
	throw new UsageError(`${path} has ${configs.length} honey() plugins; pick one with --plugin <n>:\n${apps}`)
}

/** The honey() configs of the Vite config at `path`; none is an error unless `--app` stands in for them. */
async function configsIn(path: string, flags: CliFlags, env: NodeJS.ProcessEnv, load: ModuleLoader) {
	const command = env.HONEY_VITE_COMMAND === "serve" ? "serve" : "build"
	const mode = env.HONEY_VITE_MODE ?? (command === "serve" ? "development" : "production")
	const configs = await loadPluginConfigs<HoneyVitePluginConfig>(path, load, { command, mode })
	if (configs.length === 0 && (flags.config !== undefined || flags.plugin !== undefined || flags.app === undefined))
		throw new UsageError(`no honey() plugin found in ${path}; add honey() to it or pass --app`)
	return configs
}

/** The config a run generates by: the Vite config's honey(), with the flags over it. */
async function configOf(cwd: string, flags: CliFlags, env: NodeJS.ProcessEnv, load: ModuleLoader) {
	const path = flags.config === undefined ? findViteConfig(cwd) : resolve(cwd, flags.config)
	if (flags.config !== undefined && !existsSync(path as string))
		throw new UsageError(`config file not found: ${flags.config}`)
	const raw = path === undefined ? undefined : pick(await configsIn(path, flags, env, load), flags, path, cwd)
	if (raw === undefined && flags.app === undefined)
		throw new UsageError("no config found: add honey() to a vite.config.ts, or pass --app")
	return resolveHoneyConfig(withFlags(raw ?? {}, flags))
}

/** `raw` with the flags over it: `--app` replaces its app, and each output flag turns that output on. */
function withFlags(raw: HoneyVitePluginConfig, flags: CliFlags): HoneyVitePluginConfig {
	const on = Object.fromEntries(
		(["manifest", "tree", "types"] as const).filter((key) => flags[key]).map((key) => [key, true]),
	)
	const mergeTree = flags.mergeTree === undefined ? {} : { mergeTree: flags.mergeTree }
	return { ...raw, app: flags.app ?? raw.app, codegen: { ...raw.codegen, ...mergeTree, ...on } }
}

const mtimeOf = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : 0)

/** Each generation a child after the one before it, on each edit beside the entry; ends 0 once `signal` aborts. */
function watchApp(
	config: ResolvedHoneyConfig,
	argv: readonly string[],
	io: Io,
	options: { cwd: string; signal?: AbortSignal },
) {
	const { cwd, signal } = options
	const entryRel = config.codegen.mergeTree ?? config.app
	if (entryRel === undefined) throw new UsageError("--watch requires --app or a honey() config with app")
	const args = argv.filter((arg) => arg !== "--watch" && !arg.startsWith("--watch="))
	const outputs = generatedOutputs(config, cwd)
	const regenerate = serialized(() =>
		/* the child printed why on the inherited stderr; the watch goes on to the next edit */
		runGenerate(args, { cwd, env: { HONEY_WATCH_CHILD: "1" } }).catch(() => undefined),
	)
	let latest: Promise<unknown> = Promise.resolve()
	const generate = () => {
		latest = regenerate()
	}
	let timer: NodeJS.Timeout | undefined
	const schedule = () => {
		clearTimeout(timer)
		timer = setTimeout(generate, 100)
	}
	/* armed before the first generation: an edit made while it runs queues one more */
	const entry = resolve(cwd, entryRel)
	const dir = dirname(entry)
	const watcher = watch(dir, { recursive: true }, (_event, name) => {
		const file = resolve(dir, String(name))
		if (!WATCH_IGNORE_RE.test(file) && !isGeneratedOutput(file, outputs) && !outputs.dirs.includes(file)) schedule()
	})
	/* a recursive watch can miss a save that renames over the file: the entry is polled too */
	let seen = mtimeOf(entry)
	const poll = setInterval(() => {
		if (mtimeOf(entry) === seen) return
		seen = mtimeOf(entry)
		schedule()
	}, 250)
	io.out(`honey: watching ${dir}\n`)
	generate()
	return new Promise<number>((settle) =>
		signal?.addEventListener(
			"abort",
			() => {
				watcher.close()
				clearInterval(poll)
				clearTimeout(timer)
				void latest.then(() => settle(0))
			},
			{ once: true },
		),
	)
}

/** Runs `honey <argv>`: the exit code it ends with (a watch ends only by `options.signal`). */
export async function main(argv: readonly string[], io: Io, options: RunOptions = {}): Promise<number> {
	const [cwd, env] = [options.cwd ?? process.cwd(), options.env ?? process.env]
	try {
		if (argv[0] === "-h" || argv[0] === "--help") {
			io.out(`${USAGE}\n`)
			return 0
		}
		if (argv[0] === "init") {
			runInit(cwd, parseInitFlags(argv.slice(1)), (line) => io.out(`${line}\n`))
			return 0
		}
		if (argv[0] !== "generate")
			throw new UsageError(argv[0] === undefined ? "missing command" : `unknown command: ${argv[0]}`)
		const flags = parseGenerateArgs(argv.slice(1))
		if (flags.help === true) {
			io.out(`${USAGE}\n`)
			return 0
		}
		const load = await createModuleLoader({ fresh: true, from: resolve(cwd, "index.ts") })
		const config = await configOf(cwd, flags, env, load)
		if (flags.watch === true) {
			if (env.HONEY_WATCH_CHILD === "1") throw new UsageError("--watch is not allowed in a generation child")
			return await watchApp(config, argv.slice(1), io, { cwd, signal: options.signal })
		}
		await generateAndWrite(config, cwd, { load, report: (message) => io.err(`honey: ${message}\n`) })
		io.out("honey: generated\n")
		return 0
	} catch (error) {
		/* reported on the CLI's stderr, and the exit code says it failed */
		io.err(
			error instanceof UsageError
				? `honey: ${error.message}\n\n${USAGE}\n`
				: `honey: generation failed: ${(error as Error).message}\n${framesOf(error)}`,
		)
		return 1
	}
}

/** The stack frames of `error`, a line each after the message, so a failure names where it was thrown. */
function framesOf(error: unknown): string {
	/* only frame lines survive: a missing stack's "undefined" and the stack's own message line are dropped */
	return String((error as Error).stack)
		.split("\n")
		.filter((line) => /^\s+at /.test(line))
		.map((line) => `${line}\n`)
		.join("")
}
