/**
 * The suite `suite-run.test.ts` runs: a passing file, a failing test, a file that fails before any test and a test
 * that kills its own worker. `kills-vitest.mjs` is preloaded to take vitest itself down before it reports.
 */
import { defineConfig } from "vitest/config"

export default defineConfig({ test: { include: ["*.case.ts"] } })
