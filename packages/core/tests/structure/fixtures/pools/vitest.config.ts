/** Eight files, each failing with the pool its worker took, so a run reports the most forks it held at once. */
import { defineConfig } from "vitest/config"

export default defineConfig({ test: { include: ["*.case.ts"] } })
