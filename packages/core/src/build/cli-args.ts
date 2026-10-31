/**
 * The `honey` CLI's arguments: `generate` (the app-side artifacts, Q1) and `init`. Strict, with honey-clients's
 * rules and wording (gen src/gen/args.ts; tests/integration/cli-args-parity.test.ts holds them alike): `--k v` and
 * `--k=v`; a value is never the next flag; a boolean is bare, `true` or `false`; an unknown flag or a stray argument
 * is a usage error. Not a package export.
 */

export const USAGE = `usage: honey generate [options]
       honey init [--cf] [--force]

generate options:
  --config <path>      the Vite config holding honey() (default: vite.config.{ts,mts,js,mjs})
  --plugin <n>         which honey() plugin in the config, 0-based, when there are several
  --app <path>         the app entry; overrides the config's app, or replaces the config
  --watch              generate again when files next to the app change
  --tree --types --manifest
                       turn an output on
  --merge-tree <path>  the route tree source of a gateway
  -h, --help           this text

The SDKs, the CLI and the MCP server are honey-clients's: honey-clients generate --app <path>.`

/** A mistake in how the CLI was called: printed with the usage text. */
export class UsageError extends Error {}

export type CliFlags = {
	app?: string
	config?: string
	help?: boolean
	manifest?: boolean
	mergeTree?: string
	plugin?: number
	tree?: boolean
	types?: boolean
	watch?: boolean
}

const BOOLEAN_FLAGS: Readonly<Record<string, keyof CliFlags>> = {
	help: "help",
	manifest: "manifest",
	tree: "tree",
	types: "types",
	watch: "watch",
}

const VALUE_FLAGS: Readonly<Record<string, keyof CliFlags>> = {
	app: "app",
	config: "config",
	"merge-tree": "mergeTree",
	plugin: "plugin",
}

/** A flag's value: inline after `=`, else the next argument, which may not be another flag. */
function valueOf(flag: string, inline: string | undefined, rest: string[]): string {
	const value = inline ?? rest.shift()
	if (value === undefined || value === "" || (inline === undefined && value.startsWith("--")))
		throw new UsageError(`--${flag} requires a value`)
	return value
}

/** A boolean flag's value: bare is true; inline `true` or `false`, else a usage error. */
function booleanOf(flag: string, inline: string | undefined): boolean {
	if (inline === undefined || inline === "true") return true
	if (inline === "false") return false
	throw new UsageError(`--${flag} takes true or false, not ${JSON.stringify(inline)}`)
}

/** One flag of `generate` into `flags`. */
function takeFlag(arg: string, rest: string[], flags: Record<string, unknown>): void {
	const [flag, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
	const bool = Object.hasOwn(BOOLEAN_FLAGS, flag) ? BOOLEAN_FLAGS[flag] : undefined
	if (bool !== undefined) {
		flags[bool] = booleanOf(flag, inline)
		return
	}
	const key = Object.hasOwn(VALUE_FLAGS, flag) ? VALUE_FLAGS[flag] : undefined
	if (key === undefined) throw new UsageError(`unknown option --${flag}`)
	const value = valueOf(flag, inline, rest)
	if (key === "plugin" && !/^\d+$/.test(value))
		throw new UsageError(`--plugin takes a non-negative integer, not ${JSON.stringify(value)}`)
	flags[key] = key === "plugin" ? Number(value) : value
}

/** `argv` after `generate` as its flags, or a usage error. */
export function parseGenerateArgs(argv: readonly string[]): CliFlags {
	const rest = [...argv]
	const flags: Record<string, unknown> = {}
	while (rest.length > 0) {
		const arg = rest.shift() as string
		if (arg === "-h") flags.help = true
		else if (!arg.startsWith("--") || arg === "--") throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`)
		else takeFlag(arg, rest, flags)
	}
	return flags as CliFlags
}

/** `honey init`'s flags: `--cloudflare` is `--cf`. */
export type InitFlags = { cf: boolean; force: boolean }

/** `argv` after `init` as its flags, or a usage error. */
export function parseInitFlags(argv: readonly string[]): InitFlags {
	const flags: InitFlags = { cf: false, force: false }
	for (const arg of argv) {
		if (arg === "--cf" || arg === "--cloudflare") flags.cf = true
		else if (arg === "--force") flags.force = true
		else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`)
		else throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`)
	}
	return flags
}
