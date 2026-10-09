import { ensurePython } from "./python-env.ts"

/**
 * Harness globalSetup: provision Python once, before any worker starts. Without a usable
 * interpreter the Python tests skip, and this says so loudly; with `HONEY_REQUIRE_PYTHON=1`
 * (CI) it fails the run instead.
 */
export default function setup(): void {
	const result = ensurePython()
	if (result.ok) {
		if (result.created) console.log(`[harness] python venv ready: ${result.python}`)
		return
	}
	if (process.env.HONEY_REQUIRE_PYTHON === "1") {
		throw new Error(`[harness] HONEY_REQUIRE_PYTHON=1 but no usable Python: ${result.reason}`)
	}
	const message = `[harness] Python SDK tests will be SKIPPED: ${result.reason}`
	console.warn(
		`\n${"!".repeat(72)}\n${message}\nSet HONEY_PYTHON to an interpreter with the packages in tests/python-requirements.txt.\n${"!".repeat(72)}\n`,
	)
}
