/** A JSON body as `.input({ json })` declares it. */
import { EK, HoneyError } from "../errors/error.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema } from "../validation/validate-input.ts"

/** A body the declared parser cannot read: the client's mistake, a 400, never a 500. */
export function malformedBody(format: "json" | "multipart", cause: unknown): HoneyError {
	return new HoneyError({ cause, errorKey: EK.malformed_body, status: "bad_request", vars: { format } })
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown
	} catch (error) {
		throw malformedBody("json", error)
	}
}

/**
 * The body read once as JSON and validated by `schema`. An empty or unparseable body is a 400
 * `malformed_body`; an error while reading it (a size limit, a client abort) passes through.
 */
export async function jsonInput(schema: StandardSchemaLike, req: Request): Promise<unknown> {
	return runSchema(schema, parse(await req.text()), "json")
}
