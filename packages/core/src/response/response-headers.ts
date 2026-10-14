/**
 * Declared response headers (A2): `.output({ headers: { [statusKey]: schema } })` checked against
 * what an answer carries, when the app checks its answers. The schema sees the answer's headers by
 * lowercased name, as `.input({ headers })` sees a request's. A failure is a 500 naming the status
 * key and nothing of the issues.
 */
import type { HeaderSchemas } from "../routing/output-types.ts"
import { dict } from "../routing/tree.ts"
import { validateOutput } from "../validation/validate-output.ts"
import { codeToStatusKey } from "./status.ts"

/** A route's compiled header check: nothing back when it passes, a promise only for an async validator. */
export type HeadersCheck = (response: Response) => Promise<void> | undefined

/** The answer's headers as a record by lowercased name, repeated values joined as Fetch joins them. */
function recordOf(headers: Headers): Record<string, string> {
	const record = dict<string>()
	headers.forEach((value, name) => {
		record[name] = value
	})
	return record
}

/** The check for a route declaring `schemas`, or `null` when no status declares headers. */
export function compileResponseHeaders(schemas: HeaderSchemas | undefined): HeadersCheck | null {
	if (schemas === undefined || Object.keys(schemas).length === 0) return null
	return (response) => {
		const statusKey = codeToStatusKey[response.status]
		const schema = statusKey === undefined ? undefined : schemas[statusKey]
		return schema === undefined ? undefined : validateOutput(schema, statusKey as string, recordOf(response.headers))
	}
}
