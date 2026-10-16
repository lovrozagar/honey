/**
 * The Rust SDK's `Cargo.lock` template (contract 18 §5.2): a crate `honey-sdk 0.1.0` with the WebSocket
 * dependency set, as `sdk-cargo.ts` declares it, resolved by cargo under the pinned toolchain (rust-env) and
 * written to `src/runtime/rust/Cargo.lock`. Every emitted crate's lock is cut from it (`cargoLock`). The
 * resolve starts from the current template, so cargo only adds what a new dependency or feature needs and
 * drops what nothing reaches: every version already tested stays, and the floors in `sdk-cargo.ts` (Fb7)
 * stay the lock's. Run it after changing a dependency:
 *
 *     bun packages/gen/scripts/rust-lock.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runCargo, rustCacheDir } from "../src/emit/rust/__fixtures__/rust-env.ts"
import { cargoToml } from "../src/emit/rust/sdk-cargo.ts"

const dir = rustCacheDir("tmp", "lock")
mkdirSync(join(dir, "src"), { recursive: true })
writeFileSync(join(dir, "Cargo.toml"), cargoToml({ name: "honey-sdk", version: "0.1.0" }, true))
writeFileSync(join(dir, "src/lib.rs"), "")
const target = new URL("../src/runtime/rust/Cargo.lock", import.meta.url)
writeFileSync(join(dir, "Cargo.lock"), readFileSync(target, "utf8"))
/* metadata resolves against the lock it finds and rewrites it: unreachable packages pruned, nothing upgraded */
const run = runCargo(["metadata", "--format-version", "1"], { cwd: dir })
if (run.status !== 0) throw new Error(`cargo metadata failed:\n${run.stderr}`)
writeFileSync(target, readFileSync(join(dir, "Cargo.lock"), "utf8"))
process.stdout.write(`wrote ${target.pathname}\n`)
