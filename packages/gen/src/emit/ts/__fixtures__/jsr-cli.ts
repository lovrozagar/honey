/**
 * The CLI JSR's publish check runs in (plan 39 8.3.1): the release `jsr-pins.json` pins by sha256, extracted into
 * `$HOME/.cache/honey-tmp/tools/<dir>` by `jsrCliInstall`'s command after its checksum passes; CI runs that command
 * verbatim. The pin file is the one place its name is spelled. A missing pin fails where toolchains are required
 * and skips anywhere else; nothing is fetched by a run.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { jsrCliInstall } from "../../shared/__fixtures__/installs.ts"

/** The pinned CLI: its archive's URL and digest, the directory it extracts to, and its binary there. */
type Pin = { readonly bin: string; readonly dir: string; readonly sha256: string; readonly url: string }

const pin = (): Pin => JSON.parse(readFileSync(resolve(import.meta.dirname, "jsr-pins.json"), "utf8")) as Pin

/** The pinned CLI's binary. */
export const jsrCli = (): string => join(process.env.HOME ?? homedir(), ".cache/honey-tmp/tools", pin().dir, pin().bin)

/**
 * Whether a leg runs its JSR half: false only where the CLI may be absent. A missing pin fails where toolchains are
 * required (CI, the pre-push battery), naming its install, and skips anywhere else.
 */
export function withJsrCli(): boolean {
	const present = existsSync(jsrCli())
	if (!present && process.env.HONEY_REQUIRE_TOOLCHAINS === "1")
		throw new Error(`the pinned JSR CLI is required here and is not installed: ${jsrCliInstall()}`)
	return present
}
