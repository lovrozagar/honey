/**
 * The generate CLI's arguments (bit 17 phase h): `generate --spec <file>|--app <module>[#export] --target <name>...
 * --out <dir> [--watch]` (`--app`, bit 19 h2) and
 * each target's options as `--<target>-<option>`, named after its generate function's options and passed through
 * untouched (each generator validates its own). Strict: an unknown flag, a missing value, a stray argument, an unknown
 * target or an option for a target not asked for is a usage error.
 */
/**
 * Each target, its generate function's options by name, each a string value. Since bit 21 i6 no target has a boolean
 * option: the SDKs' `throwOnError`, the last ones, are gone (a client always throws; its safe mirror answers a Result).
 */
const TARGETS = {
	cli: ["binaryName", "envPrefix", "modulePath", "repo"],
	csharp: ["clientName", "packageId", "rootNamespace", "version"],
	go: ["modulePath"],
	java: ["artifactId", "clientName", "groupId", "packageName", "version"],
	mcp: ["envPrefix", "name"],
	python: ["packageName", "version"],
	rust: ["crateName", "version"],
	ts: ["name", "stem"],
} as const satisfies Record<string, readonly string[]>

export type Target = keyof typeof TARGETS
export type Options = Record<string, string>

/** What one `generate` run asks for: a spec file or an app module (one, never both). */
export type Generate = {
	readonly app: string
	readonly spec: string
	readonly out: string
	readonly targets: readonly Target[]
	readonly options: Readonly<Record<Target, Options>>
	readonly watch: boolean
}

/** The usage text, the options listed by target. */
export function usage(): string {
	return `usage: honey-clients generate (--spec <openapi.json> | --app <module>[#export]) --target <name>... --out <dir>
       [--watch] [options]

  --spec <file>     the OpenAPI document (JSON) to generate from
  --app <module>    a honey app module instead: its export (#name, else app, else default) is the app, and its
                    openApi export, if any, the document's options (core's generateOpenApi); the module
                    exports the app and serves nothing: one that calls serve() as it loads is outside --app
  --target <name>   ${Object.keys(TARGETS).join(", ")}; repeat for more than one
  --out <dir>       each target's files go under <dir>/<target>
  --watch           generate again on each change of the spec or the app module
  -h, --help        this text

A target's options are its generator's, as --<target>-<option> <value>:
${Object.entries(TARGETS)
	.map(([target, options]) => `  ${target}: ${options.map((key) => `--${target}-${kebab(key)}`).join(" ")}`)
	.join("\n")}

Each <out>/<target> keeps .honey-generated.json, every file it wrote with its sha256. A regeneration deletes a
file the last run wrote and this one does not, unless it was edited since: that one is kept and named on stderr.
Nothing outside <out>/<target> is written or deleted, and no symlink is followed.
`
}

/** A mistake in how the CLI was called: printed with the usage text. */
export class UsageError extends Error {}

function kebab(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/** The `--<target>-<option>` flag `flag` names: its target and its option's name; none for another flag. */
function optionFlag(flag: string): { key: string; target: Target } | undefined {
	for (const [target, options] of Object.entries(TARGETS))
		for (const key of options) if (flag === `${target}-${kebab(key)}`) return { key, target: target as Target }
	return undefined
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

/** One flag of `generate` into `into`. */
function takeFlag(
	arg: string,
	rest: string[],
	into: { -readonly [K in keyof Generate]: Generate[K] } & { targets: Target[] },
) {
	const [flag, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
	if (flag === "spec") into.spec = valueOf(flag, inline, rest)
	else if (flag === "app") into.app = valueOf(flag, inline, rest)
	else if (flag === "out") into.out = valueOf(flag, inline, rest)
	else if (flag === "watch") into.watch = booleanOf(flag, inline)
	else if (flag === "target") {
		const target = valueOf(flag, inline, rest)
		if (!Object.hasOwn(TARGETS, target))
			throw new UsageError(`--target ${JSON.stringify(target)}: want one of ${Object.keys(TARGETS).join(", ")}`)
		if (!into.targets.includes(target as Target)) into.targets.push(target as Target)
	} else {
		const option = optionFlag(flag)
		if (option === undefined) throw new UsageError(`unknown option --${flag}`)
		into.options[option.target][option.key] = valueOf(flag, inline, rest)
	}
}

/** `argv` after `generate` as a run, or a usage error. */
export function parseGenerate(argv: readonly string[]): Generate {
	const rest = [...argv]
	const into = {
		app: "",
		options: Object.fromEntries(Object.keys(TARGETS).map((target) => [target, {}])) as Record<Target, Options>,
		out: "",
		spec: "",
		targets: [] as Target[],
		watch: false,
	}
	while (rest.length > 0) {
		const arg = rest.shift() as string
		if (!arg.startsWith("--") || arg === "--") throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`)
		takeFlag(arg, rest, into)
	}
	if (into.spec !== "" && into.app !== "") throw new UsageError("--spec and --app each name the document: give one")
	if (into.spec === "" && into.app === "") throw new UsageError("--spec or --app is required")
	if (into.out === "") throw new UsageError("--out is required")
	if (into.targets.length === 0) throw new UsageError("--target is required")
	const unasked = Object.entries(into.options).filter(
		([target, options]) => Object.keys(options).length > 0 && !into.targets.includes(target as Target),
	)
	if (unasked.length > 0)
		throw new UsageError(`options for ${unasked.map(([target]) => target).join(", ")}, which no --target names`)
	return into
}
