/* Adversarial OpenAPI document for the Go, Rust, Python and Go CLI emitters.
 *
 * Every name, description and enum value here is chosen to break naive interpolation:
 * keywords, prelude/runtime type names, hyphenated and leading-digit keys, colliding
 * snake/camel pairs, quotes, backslashes, comment terminators and multi-line text.
 * The compile harness generates each SDK from it and runs the real toolchain.
 */

const NASTY_TEXT = 'First line.\nSecond line with */ and """ and C:\\users\\temp and a trailing quote"'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

export const adversarialSpec = {
	components: {
		schemas: {
			"2fa": { properties: { code: { type: "string" } }, type: "object" },
			A: { properties: { b: ref("B") }, type: "object" },
			B: { properties: { a: ref("A") }, type: "object" },
			Cat: {
				properties: { kind: { const: "cat", type: "string" }, meows: { type: "boolean" } },
				required: ["kind"],
				type: "object",
			},
			Client: { properties: { id: { type: "string" } }, type: "object" },
			Config: {
				description: NASTY_TEXT,
				properties: { flag: { type: "boolean" }, name: { type: "string" } },
				required: ["name"],
				type: "object",
			},
			Dog: {
				properties: { barks: { type: "boolean" }, kind: { const: "dog", type: "string" } },
				required: ["kind"],
				type: "object",
			},
			Error: { properties: { reason: { type: "string" } }, type: "object" },
			Extra: {
				additionalProperties: { type: "integer" },
				properties: { known: { type: "string" } },
				type: "object",
			},
			Mixed: {
				oneOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }, { type: "integer" }],
			},
			Node: {
				properties: { children: { items: ref("Node"), type: "array" }, next: ref("Node"), value: { type: "string" } },
				required: ["value"],
				type: "object",
			},
			NotFoundError: { properties: { missing: { type: "string" } }, type: "object" },
			Option: { properties: { value: { type: "string" } }, type: "object" },
			Pet: {
				discriminator: {
					mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
					propertyName: "kind",
				},
				oneOf: [ref("Cat"), ref("Dog")],
			},
			Result: { properties: { ok: { type: "boolean" } }, type: "object" },
			Self: { properties: { me: { type: "string" } }, type: "object" },
			Shape: {
				discriminator: { propertyName: "type" },
				oneOf: [
					{ properties: { r: { type: "number" }, type: { const: "circle", type: "string" } }, type: "object" },
					{ properties: { side: { type: "number" }, type: { const: "square", type: "string" } }, type: "object" },
				],
			},
			Status: {
				enum: ["active", "-created_at", "created_at", "self", "", "1h", "text/plain", 'quo"te', "back\\slash"],
				type: "string",
			},
			Level: { enum: [-1, 0, 1, 2], type: "integer" },
			Tags: { items: { type: "string" }, type: "array" },
			User: {
				description: NASTY_TEXT,
				properties: {
					"2fa": { type: "boolean" },
					"@type": { type: "string" },
					'a"b': { type: "string" },
					class: { type: "string" },
					"content-type": { type: "string" },
					from: { type: "string" },
					id: { type: "string" },
					"line\nbreak": { type: "string" },
					maybe: { type: ["string", "null"] },
					nested: {
						properties: { inner_value: { type: "string" }, "inner-value": { type: "integer" } },
						type: "object",
					},
					pet: ref("Pet"),
					profile_settings: { properties: { theme: { type: "string" } }, type: "object" },
					self: { type: "string" },
					status: ref("Status"),
					type: { type: "string" },
					user_id: { type: "string" },
					userId: { type: "string" },
					weird: { description: NASTY_TEXT, enum: ["x", "y"], type: "string" },
				},
				required: ["id"],
				type: "object",
			},
			UserProfile: {
				properties: { settings: { properties: { color: { type: "string" } }, type: "object" } },
				type: "object",
			},
		},
	},
	info: { description: NASTY_TEXT, title: 'Adversarial "API" */', version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/config": {
			get: {
				operationId: "config.get",
				responses: { "200": { content: { "application/json": { schema: ref("Config") } }, description: "ok" } },
				summary: NASTY_TEXT,
			},
		},
		"/events/{room}": {
			post: {
				description: NASTY_TEXT,
				operationId: "events.stream",
				parameters: [
					{ in: "path", name: "room", required: true, schema: { type: "string" } },
					{ in: "query", name: "model", required: true, schema: { type: "string" } },
					{ in: "query", name: "limit", schema: { type: "integer" } },
					{ in: "header", name: "x-tenant", schema: { type: "string" } },
				],
				requestBody: {
					content: { "application/json": { schema: { properties: { prompt: { type: "string" } }, type: "object" } } },
					required: true,
				},
				responses: { "200": { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } },
				summary: "Stream",
			},
		},
		"/files/{url}": {
			get: {
				operationId: "files.download",
				parameters: [{ in: "path", name: "url", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } },
						description: "ok",
					},
				},
			},
			put: {
				operationId: "files.upload",
				parameters: [{ in: "path", name: "url", required: true, schema: { type: "string" } }],
				requestBody: {
					content: {
						"multipart/form-data": {
							schema: {
								properties: {
									data: { format: "binary", type: "string" },
									note: { type: "string" },
									size: { type: "integer" },
								},
								required: ["data"],
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: { "204": { description: "done" } },
			},
		},
		"/forms": {
			post: {
				operationId: "forms.submit",
				requestBody: {
					content: {
						"application/x-www-form-urlencoded": {
							schema: {
								properties: { email: { type: "string" }, tags: { items: { type: "string" }, type: "array" } },
								type: "object",
							},
						},
					},
				},
				responses: { "200": { content: { "text/plain": { schema: { type: "string" } } }, description: "ok" } },
			},
		},
		"/nothing/{id}": {
			delete: {
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "no op id" } },
			},
		},
		"/pets": {
			get: {
				operationId: "pets.list",
				responses: {
					"200": {
						content: { "application/json": { schema: { items: ref("Pet"), type: "array" } } },
						description: "ok",
					},
				},
			},
		},
		"/queue": {
			get: {
				operationId: "queue.list",
				parameters: [
					{ in: "query", name: "timeout", schema: { type: "number" } },
					{ in: "query", name: "headers", schema: { type: "string" } },
					{ in: "query", name: "cancel_token", schema: { type: "string" } },
					{ in: "query", name: "body", schema: { type: "string" } },
					{ in: "query", name: "idempotency_key", schema: { type: "string" } },
					{ in: "query", name: "url", schema: { type: "string" } },
					{ in: "query", name: "output", schema: { type: "string" } },
					{ in: "query", name: "config", schema: { type: "string" } },
					{ in: "query", name: "page[size]", schema: { type: "integer" } },
					{ in: "query", name: "ids", schema: { items: { type: "string" }, type: "array" } },
					{ in: "query", name: "maybe", schema: { type: ["string", "null"] } },
					{ in: "query", name: "order", schema: { enum: ['50%"off', "-created_at", "created_at"], type: "string" } },
					{ in: "query", name: "user_id", schema: { type: "string" } },
					{ in: "query", name: "userId", schema: { type: "string" } },
					{ in: "query", name: "q", schema: { type: "string" } },
					{ in: "query", name: "flag", schema: { type: "boolean" } },
				],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { items: { properties: { n: { type: "integer" } }, type: "object" }, type: "array" },
							},
						},
						description: "ok",
					},
				},
			},
		},
		"/realtime/{room}": {
			get: {
				"x-realtime": true,
				operationId: "rooms.live",
				parameters: [{ in: "path", name: "room", required: true, schema: { type: "string" } }],
				responses: { "101": { description: "upgrade" } },
			},
		},
		"/root": {
			get: {
				operationId: "root.list",
				responses: {
					"200": {
						content: { "application/json": { schema: { items: ref("Result"), type: "array" } } },
						description: "ok",
					},
				},
			},
		},
		"/streams/only": {
			get: {
				operationId: "onlyStreams.feed",
				responses: { "200": { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } },
			},
		},
		"/teams/{id}/members/{member_id}": {
			delete: {
				"x-idempotency-key": true,
				"x-invalidate": ["GET /teams/{id}/members", "GET /users/{user-id}"],
				operationId: "teams.members.remove",
				parameters: [
					{ in: "path", name: "id", required: true, schema: { type: "string" } },
					{ in: "path", name: "member_id", required: true, schema: { type: "string" } },
				],
				responses: { "204": { description: "removed" } },
			},
			post: {
				operationId: "teams.members.add",
				parameters: [
					{ in: "path", name: "id", required: true, schema: { type: "string" } },
					{ in: "path", name: "member_id", required: true, schema: { type: "string" } },
				],
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: {
									data: { type: "string" },
									id: { type: "string" },
									role: { enum: ["admin", "member"], type: "string" },
								},
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: { "201": { content: { "application/json": { schema: ref("User") } }, description: "ok" } },
			},
		},
		"/type/{type}": {
			get: {
				operationId: "type.get",
				parameters: [{ in: "path", name: "type", required: true, schema: { type: "string" } }],
				responses: { "200": { content: { "application/json": { schema: ref("Self") } }, description: "ok" } },
			},
		},
		"/users/{user-id}": {
			get: {
				operationId: "users.get-by-id",
				parameters: [{ in: "path", name: "user-id", required: true, schema: { type: "string" } }],
				responses: {
					"200": { content: { "application/json": { schema: ref("User") } }, description: "ok" },
					"404": { content: { "application/json": { schema: ref("NotFoundError") } }, description: "missing" },
				},
				summary: 'Get a user. Ends with "quote"',
			},
		},
		"/ws/{room}": {
			get: {
				"x-websocket": true,
				operationId: "rooms.socket",
				parameters: [
					{ in: "path", name: "room", required: true, schema: { type: "string" } },
					{ in: "query", name: "token", required: true, schema: { type: "string" } },
				],
				responses: { "101": { description: "upgrade" } },
			},
		},
	},
}
