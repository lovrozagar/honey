#!/usr/bin/env bun
import { existsSync, statSync, watch } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseInitFlags, runInit } from "./init.ts"
import type { HoneyGoCliConfig, HoneyVitePluginConfig } from "./plugin.ts"
import { generateAndWrite, type getLastHoneyConfig, resolveHoneyConfig } from "./plugin.ts"

const USAGE =
	"Usage: honey generate [--watch] [--config <path>] [--app <path>] [flags]\n" +
	"       honey init [--cf] [--force]"

type CliFlags = {
	app?: string
	cli?: boolean
	cliBinaryName?: string
	cliConfigName?: string
	cliDefaultBaseUrl?: string
	cliEnvPrefix?: string
	cliModulePath?: string
	cliOut?: string
	cliSdkModulePath?: string
	config?: string
	manifest?: boolean
	mergeTree?: string
	sdk?: boolean
	tree?: boolean
	types?: boolean
	watch?: boolean
}

const BOOLEAN_FLAGS = new Set(["cli", "manifest", "sdk", "tree", "types", "watch"])

function parseArgs(args: string[]): CliFlags {
	const parsed: Record<string, string> = {}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith("--")) continue
		const key = arg.slice(2)
		if (BOOLEAN_FLAGS.has(key)) {
			parsed[key] = "true"
		} else if (i + 1 < args.length) {
			parsed[key] = args[i + 1]
			i++
		}
	}

	return {
		app: parsed.app,
		cli: parsed.cli !== undefined,
		cliBinaryName: parsed["cli-binary-name"],
		cliConfigName: parsed["cli-config-name"],
		cliDefaultBaseUrl: parsed["cli-default-base-url"],
		cliEnvPrefix: parsed["cli-env-prefix"],
		cliModulePath: parsed["cli-module-path"],
		cliOut: parsed["cli-out"],
		cliSdkModulePath: parsed["cli-sdk-module-path"],
		config: parsed.config,
		manifest: parsed.manifest !== undefined,
		mergeTree: parsed["merge-tree"],
		sdk: parsed.sdk !== undefined,
		tree: parsed.tree !== undefined,
		types: parsed.types !== undefined,
		watch: parsed.watch !== undefined,
	}
}

async function loadConfigFromVite(configPath: string): Promise<HoneyVitePluginConfig | undefined> {
	if (!existsSync(configPath)) return undefined

	const { createJiti } = await import("jiti")
	const jiti = createJiti(configPath, { fsCache: false, interopDefault: true, moduleCache: false })

	/* importing the config executes honey() which stashes config */
	await jiti.import(configPath)

	/* read stashed config from the same module graph */
	const pluginMod = (await jiti.import("@lovrozagar/honey/plugin")) as Record<string, unknown>
	const getter = pluginMod.getLastHoneyConfig as typeof getLastHoneyConfig | undefined
	return getter?.()
}

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

function mergeCliOverrides(base: HoneyVitePluginConfig, flags: CliFlags): HoneyVitePluginConfig {
	const merged = { ...base }
	if (flags.app) merged.app = flags.app
	applyCodegenFlags(merged, flags)
	return merged
}

function buildCliConfigFromFlags(flags: CliFlags): HoneyGoCliConfig | undefined {
	if (!flags.cli && !flags.cliOut && !flags.cliBinaryName) return undefined
	if (!flags.cliOut || !flags.cliBinaryName) {
		throw new Error("--cli requires --cli-out and --cli-binary-name")
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

function configFromFlags(flags: CliFlags): HoneyVitePluginConfig | undefined {
	if (!flags.app) return undefined
	const config: HoneyVitePluginConfig = { app: flags.app }
	applyCodegenFlags(config, flags)
	return config
}

const GEN_IGNORE_RE = /(_gen[/\\]|\.gen\.(tsx?|json|d\.ts)$)/

async function main() {
	const args = process.argv.slice(2)
	const command = args[0]

	if (command === "init") {
		runInit(process.cwd(), parseInitFlags(args.slice(1)))
		return
	}

	if (command !== "generate") {
		console.error(USAGE)
		process.exit(1)
	}

	const flags = parseArgs(args.slice(1))
	const cwd = process.cwd()

	/* resolve config: vite.config.ts → CLI flags fallback */
	const configPath = resolve(cwd, flags.config ?? "vite.config.ts")
	let rawConfig: HoneyVitePluginConfig | undefined

	const viteConfig = await loadConfigFromVite(configPath)
	if (viteConfig) {
		rawConfig = mergeCliOverrides(viteConfig, flags)
	} else {
		rawConfig = configFromFlags(flags)
	}

	if (!rawConfig) {
		console.error("No config found. Provide a vite.config.ts with honey() or use --app flag.")
		process.exit(1)
	}

	const resolved = resolveHoneyConfig(rawConfig)

	async function generate(): Promise<void> {
		try {
			await generateAndWrite(resolved, cwd)
			console.log("honey: generated")
		} catch (err) {
			console.error("honey: generation failed", err)
			if (!flags.watch) process.exit(1)
		}
	}

	await generate()

	if (flags.watch) {
		if (!resolved.app) throw new Error("watch mode requires --app or a vite honey() config")
		const appAbs = resolve(cwd, resolved.app)
		const srcDir = dirname(appAbs)
		let debounceTimer: ReturnType<typeof setTimeout> | undefined
		let lastMtime = existsSync(appAbs) ? statSync(appAbs).mtimeMs : 0

		const schedule = (): void => {
			clearTimeout(debounceTimer)
			debounceTimer = setTimeout(() => generate(), 100)
		}

		console.log(`honey: watching ${srcDir}`)
		watch(srcDir, { recursive: true }, (_event, filename) => {
			if (!filename || GEN_IGNORE_RE.test(String(filename))) return
			schedule()
		})
		watch(appAbs, schedule)
		setInterval(() => {
			if (!existsSync(appAbs)) return
			const mtime = statSync(appAbs).mtimeMs
			if (mtime === lastMtime) return
			lastMtime = mtime
			schedule()
		}, 250)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
