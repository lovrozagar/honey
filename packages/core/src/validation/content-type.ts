/**
 * A route's declared body against what can reach it. At registration: a json or form schema on a
 * route only GET or HEAD reach can never be met (Fetch forbids them a body), and a request carries
 * one body, so json and form are exclusive. Per request: the media type must select the declared
 * parser, by essence, before the body is read; anything else is a 415.
 */
import { EK, HoneyError } from "../errors/error.ts"
import { type BodyParser, bodyParserFor } from "../response/media-type.ts"

/** The body sources a route may declare; any other key is a non-body source. */
type BodySchemas = { readonly [source: string]: unknown; readonly form?: unknown; readonly json?: unknown }

/**
 * Throws when `schemas` declare a body that `methods` at `path` can never receive (every method
 * GET or HEAD), or both json and form. A route that also takes another method keeps its schema:
 * a GET reaching it without a body answers 415.
 */
export function assertBodySchemaAllowed(schemas: BodySchemas, methods: readonly string[], path: string): void {
	const kind = schemas.json !== undefined ? "json" : schemas.form !== undefined ? "form" : null
	if (kind === null) return
	const method = methods[0] as string
	if (schemas.json !== undefined && schemas.form !== undefined) {
		throw new Error(`${method} ${path} declares both a json and a form body schema; a request carries one body.`)
	}
	if (!methods.every((m) => m === "GET" || m === "HEAD")) return
	throw new Error(
		`${method} ${path} declares a ${kind} body schema, but ${method} requests have no body. ` +
			"Validate query data with `search`, or register the route for a method that carries a body.",
	)
}

/**
 * The parser the request's Content-Type selects for the declared body, or `null` when no body is
 * declared. A missing, malformed or other media type is a 415 `unsupported_media_type`; the body
 * is never read here.
 */
export function assertRequestContentType(schemas: BodySchemas, contentType: string | null): BodyParser | null {
	if (schemas.json === undefined && schemas.form === undefined) return null
	const parser = bodyParserFor(contentType)
	const accepted = schemas.json !== undefined ? parser === "json" : parser === "multipart" || parser === "urlencoded"
	if (accepted) return parser
	throw new HoneyError({ errorKey: EK.unsupported_media_type, status: "unsupported_media_type" })
}
