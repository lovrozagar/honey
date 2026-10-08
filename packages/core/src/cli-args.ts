/** Argument parsing for the `honey` CLI. Not a package export. */

export const USAGE = `Usage: honey generate [options]
       honey init [--cf] [--force]

generate options:
  --config <path>          Vite config holding honey() (default: vite.config.{ts,mts,js,mjs,…})
  --plugin <n>             Which honey() plugin in the config, 0-based (when there are several)
  --app <path>             App entry; overrides the config's app, or replaces the config
  --watch                  Regenerate when files next to the app change
  --tree --types --manifest --sdk
                           Turn on an output
  --merge-tree <path>      Route tree source for a gateway
  --cli --cli-out <dir> --cli-binary-name <name> [--cli-config-name <name>]
      [--cli-default-base-url <url>] [--cli-env-prefix <prefix>] [--cli-module-path <path>]
      [--cli-sdk-module-path <path>]
                           Generate the Go CLI
  -h, --help               Show this help`

export class UsageError extends Error {}

export type CliFlags = {
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
	help?: boolean
	manifest?: boolean
	mergeTree?: string
	plugin?: number
	sdk?: boolean
	tree?: boolean
	types?: boolean
	watch?: boolean
}

const BOOLEAN_FLAGS: Record<string, keyof CliFlags> = {
	cli: "cli",
	help: "help",
	manifest: "manifest",
	sdk: "sdk",
	tree: "tree",
	types: "types",
	watch: "watch",
}

const VALUE_FLAGS: Record<string, keyof CliFlags> = {
	app: "app",
	"cli-binary-name": "cliBinaryName",
	"cli-config-name": "cliConfigName",
	"cli-default-base-url": "cliDefaultBaseUrl",
	"cli-env-prefix": "cliEnvPrefix",
	"cli-module-path": "cliModulePath",
	"cli-out": "cliOut",
	"cli-sdk-module-path": "cliSdkModulePath",
	config: "config",
	"merge-tree": "mergeTree",
	plugin: "plugin",
}

/** Strict: unknown flags, stray positionals and missing values are errors. Accepts `--k v` and `--k=v`. */
export function parseGenerateArgs(args: string[]): CliFlags {
	const flags: Record<string, unknown> = {}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		if (arg === "-h") {
			flags.help = true
			continue
		}
		if (!arg.startsWith("--") || arg === "--") throw new UsageError(`unexpected argument: ${arg}`)
		const eq = arg.indexOf("=")
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
		const inline = eq === -1 ? undefined : arg.slice(eq + 1)

		const bool = BOOLEAN_FLAGS[name]
		if (bool) {
			if (inline === undefined || inline === "true") flags[bool] = true
			else if (inline === "false") flags[bool] = false
			else throw new UsageError(`--${name} takes no value (got "${inline}")`)
			continue
		}

		const key = VALUE_FLAGS[name]
		if (!key) throw new UsageError(`unknown option: --${name}`)
		let value = inline
		if (value === undefined) {
			const next = args[i + 1]
			if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} requires a value`)
			value = next
			i++
		}
		if (value === "") throw new UsageError(`--${name} requires a value`)
		if (key === "plugin") {
			if (!/^\d+$/.test(value)) throw new UsageError(`--plugin takes a non-negative integer (got "${value}")`)
			flags.plugin = Number(value)
		} else {
			flags[key] = value
		}
	}
	return flags as CliFlags
}

/** `honey init` flags. `--cloudflare` is an alias of `--cf`. */
export type InitFlags = {
	cf: boolean
	force: boolean
}

export function parseInitFlags(args: string[]): InitFlags {
	const flags: InitFlags = { cf: false, force: false }
	for (const arg of args) {
		if (arg === "--cf" || arg === "--cloudflare") flags.cf = true
		else if (arg === "--force") flags.force = true
		else throw new UsageError(arg.startsWith("-") ? `unknown option: ${arg}` : `unexpected argument: ${arg}`)
	}
	return flags
}
