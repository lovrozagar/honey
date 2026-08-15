import type { OpenApiSpec } from "../../../../src/codegen.ts"

/**
 * Synthetic ~20-route OpenAPI spec for schema-naming characterization + RED tests.
 * Bypasses the Honey app builder — exercises deduplicateSchemas directly.
 *
 * Engineered conditions:
 * - github vs stripe webhooks: same derived base name ("CreateWebhookRequest"),
 *   structurally distinct payload fields → hash-suffix disambiguation required
 * - settings nested object: {theme, locale} shared by GET /v1/projects/{id} and
 *   GET /v1/users/{id} → must hoist after refactor (shared in 2+ top-level schemas)
 * - duplicate-shape-a/b: identical {x: number} body → Amendment 2 dedupes to ONE
 *   shared component (first-walk-order name wins, Tier 3)
 * - projects list items {id,name,slug} vs users list items {id,email}: different shapes,
 *   no collision on derived name since routes differ
 * - shared 400 error envelope across 3 routes → Tier 2: Err400InvalidInput (one component)
 * - shared 500 envelope with 4 error_keys → Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable
 * - 404 envelope with single key → Err404NotFound
 */
export const EXPECTED_COMPONENT_COUNT_AFTER_REFACTOR = 32

/* Shared 400 error envelope — emitted by 3 routes to trigger Tier 2 naming. */
export const ERROR_400_SCHEMA = {
	properties: {
		error_key: { enum: ["invalid_input"], type: "string" },
		fields: { additionalProperties: { items: { type: "object" }, type: "array" }, type: "object" },
		message: { type: "string" },
		status: { const: 400, type: "integer" },
		status_key: { type: "string" },
		success: { const: false, type: "boolean" },
	},
	required: ["error_key", "status", "success", "message", "status_key", "fields"],
	type: "object",
} as const

/* Shared 500 envelope with 4 error_keys → Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable. */
export const ERROR_500_SCHEMA = {
	properties: {
		error_key: { enum: ["internal_server_error", "service_unavailable", "gateway_timeout", "bad_gateway"], type: "string" },
		message: { type: "string" },
		status: { const: 500, type: "integer" },
		status_key: { type: "string" },
		success: { const: false, type: "boolean" },
	},
	required: ["error_key", "status", "success", "message", "status_key"],
	type: "object",
} as const

/* 404 envelope with single key → Err404NotFound. */
export const ERROR_404_SCHEMA = {
	properties: {
		error_key: { enum: ["not_found"], type: "string" },
		message: { type: "string" },
		status: { const: 404, type: "integer" },
		status_key: { type: "string" },
		success: { const: false, type: "boolean" },
	},
	required: ["error_key", "status", "success", "message", "status_key"],
	type: "object",
} as const

function mediaJson(schema: Record<string, unknown>) {
	return { content: { "application/json": { schema } } }
}

function response(status: number, schema: Record<string, unknown>) {
	return { [String(status)]: mediaJson(schema) }
}

function errorResponse(status: number, schema: Record<string, unknown>) {
	return response(status, schema)
}

function requestBody(schema: Record<string, unknown>) {
	return { content: { "application/json": { schema } } }
}

export function getFixtureSpec(): OpenApiSpec {
	return {
		info: { title: "Fixture API", version: "1.0.0" },
		openapi: "3.1.0",
		paths: {
			"/v1/auth/login": {
				post: {
					requestBody: requestBody({ properties: { email: { type: "string" }, password: { type: "string" } }, required: ["email", "password"], type: "object" }),
					responses: {
						...response(200, { properties: { token: { type: "string" }, user: { properties: { email: { type: "string" }, id: { type: "string" } }, required: ["id", "email"], type: "object" } }, required: ["token", "user"], type: "object" }),
					},
				},
			},
			"/v1/auth/logout": {
				post: {
					responses: {
						"204": { description: "No Content" },
					},
				},
			},
			"/v1/auth/refresh": {
				post: {
					requestBody: requestBody({ properties: { refresh_token: { type: "string" } }, required: ["refresh_token"], type: "object" }),
					responses: {
						...response(200, { properties: { token: { type: "string" } }, required: ["token"], type: "object" }),
					},
				},
			},
			"/v1/duplicate-shape-a": {
				post: {
					/* identical body to duplicate-shape-b: {x: number}.
					 * Amendment 2: same canonical → ONE component (Tier 3 first-claim).
					 * Both routes $ref the same entry. */
					requestBody: requestBody({ properties: { x: { type: "number" } }, required: ["x"], type: "object" }),
					responses: {
						...response(200, { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }),
					},
				},
			},
			"/v1/duplicate-shape-b": {
				post: {
					requestBody: requestBody({ properties: { x: { type: "number" } }, required: ["x"], type: "object" }),
					responses: {
						...response(200, { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }),
					},
				},
			},
			"/v1/feedback": {
				post: {
					requestBody: requestBody({ properties: { message: { type: "string" }, rating: { type: "number" } }, required: ["message", "rating"], type: "object" }),
					responses: {
						...response(200, { properties: { id: { type: "string" } }, required: ["id"], type: "object" }),
						...errorResponse(400, ERROR_400_SCHEMA as unknown as Record<string, unknown>),
						...errorResponse(500, ERROR_500_SCHEMA as unknown as Record<string, unknown>),
					},
				},
			},
			"/v1/projects": {
				get: {
					responses: {
						...response(200, { properties: { items: { items: { properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } }, required: ["id", "name", "slug"], type: "object" }, type: "array" }, next_cursor: { type: "string" } }, required: ["items"], type: "object" }),
					},
				},
				post: {
					requestBody: requestBody({ properties: { name: { type: "string" }, slug: { type: "string" } }, required: ["name", "slug"], type: "object" }),
					responses: {
						...response(201, { properties: { created_at: { type: "string" }, id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } }, required: ["id", "name", "slug", "created_at"], type: "object" }),
						...errorResponse(400, ERROR_400_SCHEMA as unknown as Record<string, unknown>),
					},
				},
			},
			"/v1/projects/{id}": {
				delete: {
					responses: {
						"204": { description: "No Content" },
					},
				},
				get: {
					responses: {
						...response(200, { properties: { id: { type: "string" }, name: { type: "string" }, settings: { properties: { locale: { type: "string" }, theme: { type: "string" } }, required: ["theme", "locale"], type: "object" }, slug: { type: "string" } }, required: ["id", "name", "slug", "settings"], type: "object" }),
					},
				},
				patch: {
					requestBody: requestBody({ properties: { name: { type: "string" }, slug: { type: "string" } }, type: "object" }),
					responses: {
						...response(200, { properties: { id: { type: "string" }, name: { type: "string" }, settings: { properties: { locale: { type: "string" }, theme: { type: "string" } }, required: ["theme", "locale"], type: "object" }, slug: { type: "string" } }, required: ["id", "name", "slug", "settings"], type: "object" }),
					},
				},
			},
			"/v1/projects/{id}/invites": {
				post: {
					requestBody: requestBody({ properties: { email: { type: "string" }, role: { type: "string" } }, required: ["email", "role"], type: "object" }),
					responses: {
						...response(201, { properties: { email: { type: "string" }, id: { type: "string" }, invited_at: { type: "string" }, role: { type: "string" } }, required: ["id", "email", "role", "invited_at"], type: "object" }),
						...errorResponse(409, { properties: { conflicting_id: { type: "string" }, message: { type: "string" } }, required: ["message"], type: "object" }),
					},
				},
			},
			"/v1/projects/{id}/invites/accept": {
				post: {
					requestBody: requestBody({ properties: { token: { type: "string" } }, required: ["token"], type: "object" }),
					responses: {
						...response(200, { properties: { project_id: { type: "string" } }, required: ["project_id"], type: "object" }),
					},
				},
			},
			"/v1/search": {
				get: {
					responses: {
						...response(200, { properties: { results: { items: {}, type: "array" }, total: { type: "number" } }, required: ["results", "total"], type: "object" }),
					},
				},
			},
			"/v1/teams": {
				post: {
					/* Third route sharing ERROR_400_SCHEMA — confirms Tier 2 dedup across 3 routes. */
					requestBody: requestBody({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
					responses: {
						...response(201, { properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], type: "object" }),
						...errorResponse(400, ERROR_400_SCHEMA as unknown as Record<string, unknown>),
						...errorResponse(404, ERROR_404_SCHEMA as unknown as Record<string, unknown>),
						...errorResponse(500, ERROR_500_SCHEMA as unknown as Record<string, unknown>),
					},
				},
			},
			"/v1/users": {
				get: {
					responses: {
						...response(200, { properties: { items: { items: { properties: { email: { type: "string" }, id: { type: "string" } }, required: ["id", "email"], type: "object" }, type: "array" }, next_cursor: { type: "string" } }, required: ["items"], type: "object" }),
					},
				},
			},
			"/v1/users/{id}": {
				get: {
					responses: {
						...response(200, { properties: { email: { type: "string" }, id: { type: "string" }, settings: { properties: { locale: { type: "string" }, theme: { type: "string" } }, required: ["theme", "locale"], type: "object" } }, required: ["id", "email", "settings"], type: "object" }),
					},
				},
				patch: {
					requestBody: requestBody({ properties: { email: { type: "string" } }, type: "object" }),
					responses: {
						...response(200, { properties: { email: { type: "string" }, id: { type: "string" }, settings: { properties: { locale: { type: "string" }, theme: { type: "string" } }, required: ["theme", "locale"], type: "object" } }, required: ["id", "email", "settings"], type: "object" }),
					},
				},
			},
			"/v1/users/{id}/avatar": {
				post: {
					requestBody: requestBody({ properties: { url: { type: "string" } }, required: ["url"], type: "object" }),
					responses: {
						...response(200, { properties: { avatar_url: { type: "string" } }, required: ["avatar_url"], type: "object" }),
					},
				},
			},
			"/v1/webhooks/github": {
				post: {
					/* body: {event, payload: {repo}} — distinct from stripe payload shape */
					requestBody: requestBody({ properties: { event: { type: "string" }, payload: { properties: { repo: { type: "string" } }, required: ["repo"], type: "object" } }, required: ["event", "payload"], type: "object" }),
					responses: {
						...response(200, { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }),
						...errorResponse(401, { properties: { message: { type: "string" } }, required: ["message"], type: "object" }),
					},
				},
			},
			"/v1/webhooks/stripe": {
				post: {
					/* body: {event, payload: {customer}} — STRUCTURALLY DIFFERENT inner shape.
					 * Both routes end in a "webhook" segment derivative → engineered derived-name collision.
					 * Current code: both get count=1, neither hoisted. After refactor: distinct names
					 * with hash suffix because canonical differs but derived base name is same. */
					requestBody: requestBody({ properties: { event: { type: "string" }, payload: { properties: { customer: { type: "string" } }, required: ["customer"], type: "object" } }, required: ["event", "payload"], type: "object" }),
					responses: {
						...response(200, { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }),
						...errorResponse(401, { properties: { message: { type: "string" } }, required: ["message"], type: "object" }),
					},
				},
			},
		},
	}
}
