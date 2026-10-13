import type { ReporterDescription } from "@playwright/test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export function e2eAppName(): string {
	return process.env.HONEY_E2E_APP ?? "kitchen"
}

/** Playwright testDir for the selected app, resolved from this file. */
export function e2eAppTestDir(): string {
	const app = e2eAppName()
	const dir = join(dirname(fileURLToPath(import.meta.url)), "apps", app, "tests", "e2e")
	if (!existsSync(dir)) {
		throw new Error(`e2e tests not found for app "${app}" at ${dir}`)
	}
	return dir
}

/** With HONEY_E2E_RECORD set (`run.ts --record`), Playwright also writes its JSON report there. */
export function e2eReporter(): { reporter?: ReporterDescription[] } {
	const file = process.env.HONEY_E2E_RECORD
	return file ? { reporter: [["list"], ["json", { outputFile: file }]] } : {}
}
