/**
 * Python's phase-c `http` document (contract 29 §4.3): the shared `http` document (bit 13's, in
 * shared/__fixtures__/documents-http.ts) plus four paths only the Python legs drive: path params named `uuid` and
 * `str` on an op with an idempotency key (acbcf0ef46, S3), a `{id}:cancel` template (3caa440441), a query map
 * that is sent as nothing when empty (the empty-map rule), and an idempotent op declaring an `Idempotency-Key`
 * header (the declared value over the generated key) and a map header (sent as nothing when empty).
 */
import { http } from "../../shared/__fixtures__/documents-http.ts"

type Json = Readonly<Record<string, unknown>>

const STRING = { type: "string" }
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })
const OK: Json = {
	200: {
		content: { "application/json": { schema: { properties: { ok: { type: "boolean" } }, type: "object" } } },
		description: "ok",
	},
}

/** The four Python-only paths. */
function pythonPaths(): Json {
	return {
		"/keyed": {
			post: {
				operationId: "keyed.send",
				parameters: [
					{ in: "header", name: "Idempotency-Key", schema: STRING },
					{ in: "header", name: "X-Meta", schema: { additionalProperties: STRING, type: "object" } },
				],
				responses: OK,
				"x-idempotency-key": true,
			},
		},
		"/items/{uuid}/{str}": {
			put: {
				operationId: "items.put",
				parameters: [path("uuid"), path("str")],
				responses: OK,
				"x-idempotency-key": true,
			},
		},
		"/ops/{id}:cancel": { post: { operationId: "ops.cancel", parameters: [path("id")], responses: OK } },
		"/search": {
			get: {
				operationId: "search.run",
				parameters: [
					{ in: "query", name: "q", schema: STRING },
					{ in: "query", name: "tags", schema: { additionalProperties: STRING, type: "object" } },
				],
				responses: OK,
			},
		},
	}
}

/** The shared `http` document with the Python-only paths beside its own. */
export function pythonHttp(): Json {
	const shared = http()
	return { ...shared, paths: { ...(shared.paths as Json), ...pythonPaths() } }
}
