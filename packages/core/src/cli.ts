#!/usr/bin/env node
import { existsSync, statSync, watch } from "node:fs"
import { dirname, resolve } from "node:path"
import { createModuleLoader, findViteConfig, loadHoneyPluginConfigs, type ModuleLoader } from "./codegen-load.ts"
import { runCli } from "./gen-process.ts"
import { type CliFlags, parseGenerateArgs, parseInitFlags, USAGE, UsageError } from "./cli-args.ts"
import { runInit } from "./init.ts"
import type { HoneyGoCliConfig, HoneyVitePluginConfig, ResolvedHoneyConfig } from "./plugin.ts"
import { generateAndWrite, generatedOutputs, isGeneratedOutput, resolveHoneyConfig } from "./plugin.ts"
import { WATCH_IGNORE_RE } from "./glob.ts"
import { setCodegenProcess } from "./serve-slot.ts"

function applyCodegenFlags(target: HoneyVitePluginConfig, flags: CliFlags): void {
	if (!target.codegen) target.codegen = {}
	const cg = target.codegen
	if (flags.mergeTree) cg.mergeTree = flags.mergeTree
	if (flags.manifest) cg.manifest = true
	if (flags.sdk) cg.sdk = true
	if (flags.tree) cg.tree = true
	if (flags.types) cg.types = true
	const cliOverride = buildCliConfigFromFlags(flags)
	if (cliOverride) cg.cli = cliOverride
}

function buildCliConfigFromFlags(flags: CliFlags): HoneyGoCliConfig | undefined {
	if (!flags.cli && !flags.cliOut && !flags.cliBinaryName) return undefined
	if (!flags.cliOut || !flags.cliBinaryName) {
		throw new UsageError("--cli requires --cli-out and --cli-binary-name")
	}
	return {
		binaryName: flags.cliBinaryName,
		configName: flags.cliConfigName,
		defaultBaseURL: flags.cliDefaultBaseUrl,
		envPrefix: flags.cliEnvPrefix,
		modulePath: flags.cliModulePath,
		out: flags.cliOut,
		sdkModulePath: flags.cliSdkModulePath,
	}
}

/** Picks one honey() config: `--plugin` by index, else the only one, else the one whose app is `--app`. */
function selectPluginConfig(
	configs: HoneyVitePluginConfig[],
	flags: CliFlags,
	configPath: string,
): HoneyVitePluginConfig | undefined {
	if (flags.plugin !== undefined) {
		const picked = configs[flags.plugin]
		if (!picked) {
			throw new UsageError(`--plugin ${flags.plugin}: ${configPath} has ${configs.length} honey() plugin(s)`)
		}
		return picked
	}
	if (configs.length <= 1) return configs[0]
	const byApp = flags.app ? configs.filter((c) => c.app && resolve(c.app) === resolve(flags.app as string)) : []
	if (byApp.length === 1) return byApp[0]
	const apps = configs.map((c, i) => `  ${i}: ${c.app ?? "(no app)"}`).join("\n")
	throw new UsageError(`${configPath} has ${configs.length} honey() plugins; pick one with --plugin <n>:\n${apps}`)
}

async function resolveConfig(cwd: string, flags: CliFlags, load: ModuleLoader): Promise<ResolvedHoneyConfig> {
	const configPath = flags.config ? resolve(cwd, flags.config) : findViteConfig(cwd)
	if (flags.config && !existsSync(configPath as string)) {
		throw new UsageError(`config file not found: ${flags.config}`)
	}

	let raw: HoneyVitePluginConfig | undefined
	if (configPath) {
		const command = process.env.HONEY_VITE_COMMAND === "serve" ? "serve" : "build"
		const mode = process.env.HONEY_VITE_MODE ?? (command === "serve" ? "development" : "production")
		const configs = await loadHoneyPluginConfigs(configPath, load, { command, mode })
		if (configs.length === 0 && (flags.config || flags.plugin !== undefined || !flags.app)) {
			throw new UsageError(`no honey() plugin found in ${configPath}; add honey() to it or pass --app`)
		}
		const picked = selectPluginConfig(configs, flags, configPath)
		if (picked) raw = { ...picked, codegen: { ...picked.codegen } }
	}

	if (raw) {
		if (flags.app) raw.app = flags.app
	} else if (flags.app) {
		raw = { app: flags.app }
	} else {
		throw new UsageError("No config found. Provide a vite.config.ts with honey() or use --app.")
	}
	applyCodegenFlags(raw, flags)
	return resolveHoneyConfig(raw)
}

/** One generation in this process, then exit: whatever the app left running must not keep it alive. */
async function generateOnce(cwd: string, flags: CliFlags): Promise<never> {
	setCodegenProcess(true)
	const load = await createModuleLoader({ fresh: false, from: resolve(cwd, "index.ts") })
	const resolved = await resolveConfig(cwd, flags, load)
	try {
		await generateAndWrite(resolved, cwd, { load })
	} catch (err) {
		console.error("honey: generation failed", err)
		process.exit(1)
	}
	console.log("honey: generated")
	process.exit(0)
}

/** Watch mode: every generation runs in a fresh child process, so edits to any imported file are seen. */
async function watchAndGenerate(cwd: string, flags: CliFlags, args: string[]): Promise<void> {
	setCodegenProcess(true)
	const load = await createModuleLoader({ fresh: true, from: resolve(cwd, "index.ts") })
	const resolved = await resolveConfig(cwd, flags, load)
	if (!resolved.app) throw new UsageError("--watch requires --app or a honey() config with app")
	setCodegenProcess(false)

	const childArgs = ["generate", ...args.filter((a) => a !== "--watch" && a !== "--watch=true")]
	const outputs = generatedOutputs(resolved, cwd)

	let running = false
	let pending = false
	const generate = async (): Promise<void> => {
		if (running) {
			pending = true
			return
		}
		running = true
		try {
			await runCli(childArgs, { cwd })
		} catch {
			/* the child already printed why */
		} finally {
			running = false
		}
		if (pending) {
			pending = false
			await generate()
		}
	}

	let debounce: ReturnType<typeof setTimeout> | undefined
	const schedule = (): void => {
		clearTimeout(debounce)
		debounce = setTimeout(() => void generate(), 100)
	}

	await generate()

	const appAbs = resolve(cwd, resolved.app)
	const srcDir = dirname(appAbs)
	console.log(`honey: watching ${srcDir}`)
	watch(srcDir, { recursive: true }, (_event, filename) => {
		if (!filename) return
		const abs = resolve(srcDir, String(filename))
		if (WATCH_IGNORE_RE.test(abs) || isGeneratedOutput(abs, outputs)) return
		schedule()
	})
	/* recursive fs.watch misses replace-by-rename saves on some platforms; poll the entry too */
	let lastMtime = mtimeOf(appAbs)
	setInterval(() => {
		const mtime = mtimeOf(appAbs)
		if (mtime === lastMtime) return
		lastMtime = mtime
		schedule()
	}, 250)
}

function mtimeOf(path: string): number {
	return existsSync(path) ? statSync(path).mtimeMs : 0
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const command = args[0]

	if (command === "-h" || command === "--help") {
		console.log(USAGE)
		return
	}

	if (command === "init") {
		runInit(process.cwd(), parseInitFlags(args.slice(1)))
		return
	}

	if (command !== "generate") {
		throw new UsageError(command ? `unknown command: ${command}` : "missing command")
	}

	const rest = args.slice(1)
	const flags = parseGenerateArgs(rest)
	if (flags.help) {
		console.log(USAGE)
		return
	}
	const cwd = process.cwd()
	if (flags.watch) await watchAndGenerate(cwd, flags, rest)
	else await generateOnce(cwd, flags)
}

main().catch((err: unknown) => {
	if (err instanceof UsageError) {
		console.error(`honey: ${err.message}\n\n${USAGE}`)
	} else {
		console.error(err)
	}
	process.exit(1)
})
