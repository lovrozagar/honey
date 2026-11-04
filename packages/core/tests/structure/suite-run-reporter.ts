/**
 * The vitest reporter runVitest adds to its child run: it writes each error the run caught outside a test (a timer's
 * throw, an unhandled rejection, a dead fork's pool error) to the file `HONEY_SUITE_RUN_ERRORS` names, as JSON, so
 * the errors are read as data and never parsed from the default reporter's text, whose colors CI turns on.
 */
import { writeFileSync } from "node:fs"
import type { Reporter, SerializedError, TestModule } from "vitest/node"

export default class UnhandledErrors implements Reporter {
	onTestRunEnd(_modules: readonly TestModule[], errors: readonly SerializedError[]): void {
		const file = process.env.HONEY_SUITE_RUN_ERRORS
		if (file === undefined) return
		writeFileSync(
			file,
			JSON.stringify(errors.map((error) => (error.name ? `${error.name}: ${error.message}` : error.message))),
		)
	}
}
