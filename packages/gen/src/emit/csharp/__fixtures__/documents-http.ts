/**
 * C#'s phase-c `http` document (contract 47 §4.1): the shared `http` document (bit 13's, in
 * shared/__fixtures__/documents-http.ts), the extra paths Python and C# share (`httpExtraPaths()`), and one path
 * only the C# legs drive: `merge.patch`, whose body's declared media type `application/merge-patch+json` is what
 * the SDK sends (Python's `body.py:76` rule).
 */
import { http, httpExtraPaths } from "../../shared/__fixtures__/documents-http.ts"

type Json = Readonly<Record<string, unknown>>

/** `PATCH /merge`: a `{name}` body as `application/merge-patch+json`, answering 200 `{ok}`. */
function mergePath(): Json {
	const schema = (properties: Json): Json => ({ properties, type: "object" })
	return {
		"/merge": {
			patch: {
				operationId: "merge.patch",
				requestBody: {
					content: { "application/merge-patch+json": { schema: schema({ name: { type: "string" } }) } },
					required: true,
				},
				responses: {
					200: {
						content: { "application/json": { schema: schema({ ok: { type: "boolean" } }) } },
						description: "ok",
					},
				},
			},
		},
	}
}

/** The shared `http` document with the extra paths and `merge.patch` beside its own. */
export function csharpHttp(): Json {
	const shared = http()
	return { ...shared, paths: { ...(shared.paths as Json), ...httpExtraPaths(), ...mergePath() } }
}
