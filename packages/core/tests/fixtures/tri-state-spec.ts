/* Optional fields that may be null, required arrays and maps: absent, null and a value are
 * three different requests, and a required list is never sent as null. */
export const triStateSpec = {
	components: {
		schemas: {
			Thing: {
				properties: {
					attrs: { additionalProperties: { type: "string" }, type: "object" },
					note: { type: ["string", "null"] },
					parent: { anyOf: [{ $ref: "#/components/schemas/Thing" }, { type: "null" }] },
					plain: { type: "string" },
					tags: { items: { type: "string" }, type: "array" },
					"x-key": { type: ["integer", "null"] },
				},
				required: ["tags", "attrs"],
				type: "object",
			},
		},
	},
	info: { title: "TriState", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/things": {
			post: {
				operationId: "things.create",
				requestBody: {
					content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } },
					required: true,
				},
				responses: {
					200: {
						content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } },
						description: "ok",
					},
				},
			},
		},
	},
} as Record<string, unknown>
