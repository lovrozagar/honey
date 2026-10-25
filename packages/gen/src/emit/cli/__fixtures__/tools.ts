/**
 * The tools the CLI's generated files are checked by (bit 17 phases e and g): bash from the system; fish, zsh and
 * PowerShell for the completion scripts and install.ps1; goreleaser for the release config; shellcheck for install.sh.
 * Each is the release `tool-pins.json` pins by sha256, extracted into `$HOME/.cache/honey-tmp/tools/<dir>` by
 * `toolsInstall`'s command after its checksum passes; CI runs that command verbatim. zsh comes from
 * romkatv/zsh-bin, which publishes no digest: its pin is the sha256 of the release asset whose gpg signature checked
 * out against the author's key (8B060F8B9EB395614A669F2A90ACE942EB90C3DD). A missing pin fails where toolchains are
 * required and skips anywhere else; nothing is fetched by a run.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { toolsInstall } from "../../shared/__fixtures__/installs.ts"

/** A pinned tool: its archive's URL and digest, the directory it extracts to, and its binary there. */
type Pin = { readonly bin: string; readonly dir: string; readonly sha256: string; readonly url: string }

/** The shells a completion script is written for, as cobra names them. */
export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const
export type Shell = (typeof SHELLS)[number]

/* this file's directory, repo-relative, as the install line names it from the repo's top level */

/** The pinned tools, by name. */
export const TOOLS = ["fish", "goreleaser", "pwsh", "shellcheck", "zsh"] as const
export type Tool = (typeof TOOLS)[number]

const pins = (): Record<Tool, Pin> =>
	JSON.parse(readFileSync(resolve(import.meta.dirname, "tool-pins.json"), "utf8")) as Record<Tool, Pin>

/** Where the pinned tools live. */
const toolsDir = () => join(process.env.HOME ?? homedir(), ".cache/honey-tmp/tools")

/** A pinned tool's binary. */
export const toolBin = (name: Tool) => join(toolsDir(), pins()[name].dir, pins()[name].bin)

/** The binary that checks `shell`'s scripts. */
const checker = (shell: Shell) =>
	shell === "bash" ? "bash" : toolBin(({ fish: "fish", powershell: "pwsh", zsh: "zsh" } as const)[shell])

/** Whether every pinned tool and bash is installed: nothing is fetched here. */
export const hasTools = (): boolean =>
	TOOLS.every((name) => existsSync(toolBin(name))) && spawnSync("bash", ["--version"]).status === 0

/**
 * Whether a test runs its tools half: false only where the tools may be absent. A missing pin fails where
 * toolchains are required (CI, the pre-push battery), naming its install, and skips anywhere else.
 */
export function withTools(): boolean {
	const present = hasTools()
	if (!present && process.env.HONEY_REQUIRE_TOOLCHAINS === "1")
		throw new Error(`the pinned tools are required here and are not installed: ${toolsInstall()}`)
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

export { toolsInstall }
