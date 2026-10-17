/**
 * Gen's mutation check, the same mechanism as core's and none of its code (H2): a guard is
 * load-bearing only if the emit adversarial suite goes red without it. For each guard of the registry
 * (mutation-harness.guards.ts), rerun the suite with that guard disabled (HONEY_MUTANT=<id>, applied by the
 * suite through vi.doMock) and require a failing run: a toolchain guard its own language's security file
 * (SUITES, the only one its mock reaches), any other guard all of `tests/security`. With every guard in place
 * the whole directory must pass. A guard whose toolchain is absent is reported skipped, never killed; where the
 * toolchain is required (HONEY_REQUIRE_GO, HONEY_REQUIRE_RUST, HONEY_REQUIRE_PYTHON, HONEY_REQUIRE_TOOLCHAINS)
 * its absence fails the run instead.
 *
 *     bun packages/gen/tests/structure/mutation-harness.ts
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { withGo } from "../../src/emit/go/__fixtures__/go-env.ts"
import { withPython } from "../../src/emit/python/__fixtures__/python-env.ts"
import { withRust } from "../../src/emit/rust/__fixtures__/rust-env.ts"
import { GUARDS, guardNamed, SUITES, skippedFor, type Toolchain, verdicts } from "./mutation-harness.guards.ts"

const GEN = resolve(import.meta.dirname, "../..")
const SUITE = "tests/security"
const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")

/** Each toolchain's name in a skip line. */
const NAMES: Readonly<Record<Toolchain, string>> = { go: "Go", python: "Python", rust: "Rust" }

/** The emit adversarial suite's exit status, with `mutant` disabled when given: its toolchain's file alone, or all of it. */
export function runSuite(mutant: string | undefined): number {
	const env = { ...process.env, HONEY_MUTANT: mutant ?? "" }
	const toolchain = guardNamed(mutant)?.toolchain
	const suite = toolchain === undefined ? SUITE : SUITES[toolchain]
	const run = spawnSync(process.execPath, [VITEST, "run", suite], { cwd: GEN, encoding: "utf8", env })
	return run.status ?? 1
}

function main(): number {
	/* throws where a toolchain is required and absent, before any suite run: a required toolchain never skips */
	const present = { go: withGo(), python: withPython(), rust: withRust() }
	if (runSuite(undefined) !== 0) {
		process.stderr.write("mutation: the emit adversarial suite fails with every guard in place\n")
		return 1
	}
	const { killed, skipped, survived } = verdicts(GUARDS, skippedFor(GUARDS, present), runSuite)
	for (const id of killed) process.stdout.write(`killed   ${id}\n`)
	for (const id of skipped)
		process.stdout.write(`skipped  ${id} (no ${NAMES[guardNamed(id)?.toolchain ?? "go"]} toolchain)\n`)
	for (const id of survived) process.stdout.write(`SURVIVED ${id}\n`)
	process.stdout.write(`mutation: ${killed.length} killed, ${skipped.length} skipped, ${survived.length} survived\n`)
	if (survived.length > 0) process.stderr.write(`mutation: no case catches ${survived.join(", ")}\n`)
	return survived.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(main())
