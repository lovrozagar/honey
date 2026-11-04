/**
 * The suite `suite-run.test.ts` runs: a passing file, a failing test, a file that fails before any test, a test
 * that kills its own worker and a passing test whose timer throws. `kills-vitest.mjs` is preloaded to take vitest
 * itself down before it reports.
 */
import { defineConfig } from "vitest/config"

export default defineConfig({ test: { include: ["*.case.ts"] } })
