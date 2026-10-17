/**
 * Python's phase-c `http` document (contract 29 §4.3): the shared `http` document (bit 13's, in
 * shared/__fixtures__/documents-http.ts) plus the four paths only the Python and C# legs drive, from the shared
 * `httpExtraPaths()` (contract 47 §4.1): path params named `uuid` and `str` on an op with an idempotency key
 * (acbcf0ef46, S3), a `{id}:cancel` template (3caa440441), a query map that is sent as nothing when empty (the
 * empty-map rule), and an idempotent op declaring an `Idempotency-Key` header (the declared value over the
 * generated key) and a map header (sent as nothing when empty).
 */
import { http, httpExtraPaths } from "../../shared/__fixtures__/documents-http.ts"

type Json = Readonly<Record<string, unknown>>

/** The shared `http` document with the extra paths beside its own. */
export function pythonHttp(): Json {
	const shared = http()
	return { ...shared, paths: { ...(shared.paths as Json), ...httpExtraPaths() } }
}
