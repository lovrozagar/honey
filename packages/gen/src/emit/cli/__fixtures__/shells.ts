/**
 * The shells the CLI's completion scripts are checked by (bit 17 phase e): bash from the system, and fish, zsh and
 * PowerShell at the releases `shell-pins.json` pins by sha256, extracted into `$HOME/.cache/honey-tmp/tools/<dir>`
 * by `shellsInstall`'s command after each checksum passes; CI runs that command verbatim. zsh comes from
 * romkatv/zsh-bin, which publishes no digest: its pin is the sha256 of the release asset whose gpg signature checked
 * out against the author's key (8B060F8B9EB395614A669F2A90ACE942EB90C3DD). A missing pin fails where toolchains are
 * required and skips anywhere else; nothing is fetched by a run.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** A pinned shell: its archive's URL and digest, the directory it extracts to, and its binary there. */
type Pin = { readonly bin: string; readonly dir: string; readonly sha256: string; readonly url: string }

/** The shells a completion script is written for, as cobra names them. */
export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const
export type Shell = (typeof SHELLS)[number]

/* this file's directory, repo-relative, as the install line names it from the repo's top level */
const FIXTURES = "packages/gen/src/emit/cli/__fixtures__"

const pins = (): Record<"fish" | "pwsh" | "zsh", Pin> =>
	JSON.parse(readFileSync(resolve(import.meta.dirname, "shell-pins.json"), "utf8")) as Record<
		"fish" | "pwsh" | "zsh",
		Pin
	>

/** Where the pinned shells live. */
const toolsDir = () => join(process.env.HOME ?? homedir(), ".cache/honey-tmp/tools")

/** A pinned shell's binary. */
const pinned = (name: "fish" | "pwsh" | "zsh") => join(toolsDir(), pins()[name].dir, pins()[name].bin)

/** The binary that checks `shell`'s scripts. */
const checker = (shell: Shell) =>
	shell === "bash" ? "bash" : pinned(({ fish: "fish", powershell: "pwsh", zsh: "zsh" } as const)[shell])

/**
 * The command that installs every pin into the tools cache, from anywhere in the repo: each archive checked against
 * `shell-pins.json`'s sha256 before it is kept, then extracted whole or not at all.
 */
export function shellsInstall(): string {
	return [
		`P="$(git rev-parse --show-toplevel)/${FIXTURES}/shell-pins.json" && D="$HOME/.cache/honey-tmp/tools" && mkdir -p "$D/dl"`,
		`for k in $(jq -r 'keys[]' "$P"); do U="$(jq -r --arg k "$k" '.[$k].url' "$P")" && R="$(jq -r --arg k "$k" '.[$k].dir' "$P")"`,
		`curl -fsSL -o "$D/dl/$k" "$U" && echo "$(jq -r --arg k "$k" '.[$k].sha256' "$P")  $D/dl/$k" | sha256sum -c -`,
		`rm -rf "$D/$R" "$D/$R.partial" && mkdir -p "$D/$R.partial" && tar -xf "$D/dl/$k" -C "$D/$R.partial"`,
		`chmod +x "$D/$R.partial/$(jq -r --arg k "$k" '.[$k].bin' "$P")" && mv "$D/$R.partial" "$D/$R" && rm "$D/dl/$k" || exit 1; done`,
	].join(" && ")
}

/** Whether every shell is installed: nothing is fetched here. */
export const hasShells = (): boolean =>
	(["fish", "pwsh", "zsh"] as const).every((name) => existsSync(pinned(name))) &&
	spawnSync("bash", ["--version"]).status === 0

/**
 * Whether a test runs its shell half: false only where the shells may be absent. A missing pin fails where
 * toolchains are required (CI, the pre-push battery), naming its install, and skips anywhere else.
 */
export function withShells(): boolean {
	const present = hasShells()
	if (!present && process.env.HONEY_REQUIRE_TOOLCHAINS === "1")
		throw new Error(`the pinned shells are required here and are not installed: ${shellsInstall()}`)
	return present
}

/** `shell`'s parse of the script at `file`: its exit status and what it reported; status 0 when the script parses. */
export function syntaxCheck(shell: Shell, file: string): { readonly status: number; readonly errors: string } {
	const args =
		shell === "powershell"
			? [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					/* the path as a single-quoted literal: -Command appends extra arguments to the script, never as $args */
					`$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`,
				]
			: ["-n", file]
	const ran = spawnSync(checker(shell), args, { encoding: "utf8", env: { ...process.env, HOME: toolsDir() } })
	return { errors: `${ran.stdout}${ran.stderr}`, status: ran.status ?? 1 }
}
