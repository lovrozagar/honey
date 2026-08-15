import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Shared cargo target on the workspace disk — /tmp is an 8GB tmpfs that cargo fills. */
export const CARGO_TARGET_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../.cache/cargo-target")

mkdirSync(CARGO_TARGET_DIR, { recursive: true })

export function cargoEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...process.env, CARGO_TARGET_DIR, ...extra }
}

/** Pin the process so every `execSync("cargo …")` inherits the disk target. */
process.env.CARGO_TARGET_DIR = CARGO_TARGET_DIR
