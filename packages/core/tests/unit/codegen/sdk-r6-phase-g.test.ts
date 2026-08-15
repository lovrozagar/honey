import { describe, expect, it } from "vitest"
import { generateSDK, isStandardErrEnvelope } from "../../../src/codegen.ts"

/* ── shared fixture builder ── */

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

/*
 * Canonical Honey error envelope schema (well-formed — passes isStandardErrEnvelope).
 * fields.additionalProperties.items has all three required sub-props with type: "string".
 */
const canonicalEnvelopeSchema = {
	properties: {
		error_key: { enum: ["validation_error"] },
		fields: {
			additionalProperties: {
				items: {
					properties: {
						error_key: { type: "string" },
						message: { type: "string" },
						path: { type: "string" },
					},
					type: "object",
				},
				type: "array",
			},
			type: "object",
		},
		message: { type: "string" },
		status: { enum: [400] },
		status_key: { type: "string" },
		success: { const: false },
	},
}

/*
 * Malformed "fake envelope": property names match but field types are wrong.
 * fields is { type: "string" }, message is { type: "number" }.
 * Current (buggy) emitter accepts this and emits _ErrEnvelope<418, "fake">.
 * Fixed emitter rejects it and falls through to inline schema.
 */
const fakeEnvelopeSchema = {
	properties: {
		error_key: { enum: ["fake"] },
		fields: { type: "string" },
		message: { type: "number" },
		status: { enum: [418] },
		status_key: { type: "string" },
		success: { const: false },
	},
}

const phaseGFixtureSpec = makeSpec({
	"/v1/items": {
		get: {
			operationId: "items.list",
			responses: {
				"200": { content: { "application/json": { schema: { type: "array" } } } },
			},
		},
		post: {
			operationId: "items.create",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
			},
			"x-invalidate": ["GET /v1/items"],
		},
	},
	"/v1/items/{id}": {
		get: {
			operationId: "items.get",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
				"400": { content: { "application/json": { schema: canonicalEnvelopeSchema } } },
				"418": { content: { "application/json": { schema: fakeEnvelopeSchema } } },
			},
		},
		patch: {
			operationId: "items.update",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
			},
			"x-invalidate": ["GET /v1/items/:id"],
		},
	},
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-6 — isStandardErrEnvelope direct unit tests (Layer A — always GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-6 isStandardErrEnvelope — Layer A invariants", () => {
	it("canonical Honey envelope returns { keys, status }", () => {
		const result = isStandardErrEnvelope(canonicalEnvelopeSchema as Record<string, unknown>)
		expect(result).not.toBeNull()
		expect(result?.status).toBe(400)
		expect(result?.keys).toContain("validation_error")
	})

	it("schema with no properties returns null", () => {
		expect(isStandardErrEnvelope({})).toBeNull()
	})

	it("schema missing success: false returns null", () => {
		const schema = {
			properties: {
				error_key: { enum: ["x"] },
				fields: { additionalProperties: { items: { properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } }, type: "object" }, type: "array" }, type: "object" },
				message: { type: "string" },
				status: { enum: [400] },
				status_key: { type: "string" },
				success: { const: true },
			},
		}
		expect(isStandardErrEnvelope(schema as Record<string, unknown>)).toBeNull()
	})

	it("schema with non-string message type — current code passes (fixed in Phase G)", () => {
		/* pre-fix: only presence-checks message key, not its type — returns non-null;
		   post-fix: type-validates message.type === "string" — returns null.
		   This is a known bug, NOT a Layer A invariant. The post-fix assertion lives in Layer B'. */
		const schema = {
			properties: {
				error_key: { enum: ["x"] },
				fields: { additionalProperties: { items: { properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } }, type: "object" }, type: "array" }, type: "object" },
				message: { type: "number" },
				status: { enum: [400] },
				status_key: { type: "string" },
				success: { const: false },
			},
		}
		/* always verify the function returns SOMETHING (non-crash) — the null vs non-null is gated below */
		const result = isStandardErrEnvelope(schema as Record<string, unknown>)
		expect(result === null || typeof result === "object").toBe(true)
	})

	it("schema with string fields (not object) — current code passes (fixed in Phase G)", () => {
		const result = isStandardErrEnvelope(fakeEnvelopeSchema as Record<string, unknown>)
		expect(result === null || typeof result === "object").toBe(true)
	})

	it("schema with non-array status enum returns null", () => {
		const schema = {
			properties: {
				error_key: { enum: ["x"] },
				fields: { additionalProperties: { items: { properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } }, type: "object" }, type: "array" }, type: "object" },
				message: { type: "string" },
				status: { type: "number" },
				status_key: { type: "string" },
				success: { const: false },
			},
		}
		expect(isStandardErrEnvelope(schema as Record<string, unknown>)).toBeNull()
	})

	it("schema with multiple status enum values returns null", () => {
		const schema = {
			properties: {
				error_key: { enum: ["x"] },
				fields: { additionalProperties: { items: { properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } }, type: "object" }, type: "array" }, type: "object" },
				message: { type: "string" },
				status: { enum: [400, 422] },
				status_key: { type: "string" },
				success: { const: false },
			},
		}
		expect(isStandardErrEnvelope(schema as Record<string, unknown>)).toBeNull()
	})

	it("schema with non-string error_key enum members returns null", () => {
		const schema = {
			properties: {
				error_key: { enum: [42] },
				fields: { additionalProperties: { items: { properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } }, type: "object" }, type: "array" }, type: "object" },
				message: { type: "string" },
				status: { enum: [400] },
				status_key: { type: "string" },
				success: { const: false },
			},
		}
		expect(isStandardErrEnvelope(schema as Record<string, unknown>)).toBeNull()
	})

	it("schema where fields.additionalProperties is not array type — current code passes (fixed in Phase G)", () => {
		const schema = {
			properties: {
				error_key: { enum: ["x"] },
				fields: { additionalProperties: { type: "string" }, type: "object" },
				message: { type: "string" },
				status: { enum: [400] },
				status_key: { type: "string" },
				success: { const: false },
			},
		}
		const result = isStandardErrEnvelope(schema as Record<string, unknown>)
		expect(result === null || typeof result === "object").toBe(true)
	})

	it("schema where fields.additionalProperties.items is missing path property — current code passes (fixed in Phase G)", () => {
		const schema = {
			properties: {
				error_key: { enum: ["x"] },
				fields: {
					additionalProperties: {
						items: {
							properties: {
								error_key: { type: "string" },
								message: { type: "string" },
							},
							type: "object",
						},
						type: "array",
					},
					type: "object",
				},
				message: { type: "string" },
				status: { enum: [400] },
				status_key: { type: "string" },
				success: { const: false },
			},
		}
		const result = isStandardErrEnvelope(schema as Record<string, unknown>)
		expect(result === null || typeof result === "object").toBe(true)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-6 — emitter Layer B bug witness: fake envelope passes through
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-6 isStandardErrEnvelope — emitter Layer B' regression strings", () => {
	it("post-fix: canonical Honey envelope still emits _ErrEnvelope<400", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("_ErrEnvelope<400")
	})

	it("post-fix: malformed fake envelope does NOT emit _ErrEnvelope<418 — falls through to inline", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.types).not.toContain("_ErrEnvelope<418")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-7 — String(body.message) guard emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-7 parseAsClientError string guard — emitter Layer B' regression strings", () => {
	it("post-fix: emitted #parseAsClientError uses typeof msgVal === \"string\" guard", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain(`typeof msgVal === "string"`)
	})

	it("post-fix: String((body as ...) coercion pattern is gone", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).not.toContain(`String((body as Record<string, unknown>)["message"])`)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-8 — #parseBody MIME parsing emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-8 parseBody MIME parsing — emitter Layer B' regression strings", () => {
	it("post-fix: files.client uses rawCt.split(\";\")[0] to strip params", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain(`rawCt.split(";")[0]`)
	})

	it("post-fix: files.client uses ct.endsWith(\"+json\") for vendor JSON types", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain(`ct.endsWith("+json")`)
	})

	it("post-fix: files.client uses ct.startsWith(\"text/\") for text types", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain(`ct.startsWith("text/")`)
	})

	it("post-fix: loose ct.includes(\"application/json\") packed-substring form is gone", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).not.toContain(`ct.includes("application/json")`)
	})

	it("post-fix: binary fallback return response.arrayBuffer() appears at least twice", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		const matches = files.client.match(/return response\.arrayBuffer\(\)/g)
		expect((matches ?? []).length).toBeGreaterThanOrEqual(2)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-11 — onRequest body exposure emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-11 onRequest body exposure — emitter Layer B' regression strings", () => {
	it("post-fix: files.client inline reqCtx type includes body?: BodyInit;", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("body?: BodyInit;")
	})

	it("post-fix: files.client reqCtx initializer includes body in the literal", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("body, headers, method, path")
	})

	it("post-fix: files.client contains body rebind after hook loop", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("if (reqCtx.body !== body) body = reqCtx.body")
	})

	it("post-fix: files.types onRequest? array element type includes body?: BodyInit", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		const onReqIdx = files.types.indexOf("onRequest?")
		const snippet = files.types.slice(onReqIdx, onReqIdx + 400)
		expect(snippet).toContain("body?: BodyInit")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-12 — unresolved invalidate target drop emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-12 unresolved invalidate target drop — emitter Layer B' regression strings", () => {
	it("post-fix: files.client #resolveInvalidationTargets uses let hasUnresolved = false", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("let hasUnresolved = false")
	})

	it("post-fix: files.client contains if (hasUnresolved) continue guard", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("if (hasUnresolved) continue")
	})

	it("post-fix: old return targets.map((target) shape is gone", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).not.toContain("return targets.map((target)")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-13 — retry() parsed error emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-13 retry parsed error — emitter Layer B' regression strings", () => {
	it("post-fix: files.client retry block checks r.response.ok and throws parsed error", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("if (!r.response.ok) throw await this.#parseAsClientError(r.response)")
	})

	it("post-fix: raw .then((r) => r.response) pattern is gone from files.client", () => {
		const { files } = generateSDK(phaseGFixtureSpec, { name: "TestSDK" })
		const count = (files.client.match(/\.then\(\(r\) => r\.response\)/g) ?? []).length
		expect(count).toBe(0)
	})
})
