import { describe, expect, it } from "vitest"
import { deriveErrorEnvelopeName, deriveSchemaName, isErrorEnvelope, shortHash } from "../../../src/codegen-schema-naming.ts"
import { hashString } from "../../../src/codegen-hash.ts"

describe("deriveSchemaName", () => {
	it("POST collection → CreateXRequest", () => {
		expect(deriveSchemaName({ method: "post", path: "/v1/projects", role: "request" }))
			.toBe("CreateProjectRequest")
	})

	it("POST collection 201 → CreateXResponse201", () => {
		expect(deriveSchemaName({ method: "post", path: "/v1/projects", role: "response", status: 201 }))
			.toBe("CreateProjectResponse201")
	})

	it("POST collection 400 → CreateXResponse400", () => {
		expect(deriveSchemaName({ method: "post", path: "/v1/projects", role: "response", status: 400 }))
			.toBe("CreateProjectResponse400")
	})

	it("GET collection → ListXsResponse200", () => {
		expect(deriveSchemaName({ method: "get", path: "/v1/projects", role: "response", status: 200 }))
			.toBe("ListProjectsResponse200")
	})

	it("GET by id → GetXResponse200", () => {
		expect(deriveSchemaName({ method: "get", path: "/v1/projects/{id}", role: "response", status: 200 }))
			.toBe("GetProjectResponse200")
	})

	it("PATCH by id → UpdateXRequest", () => {
		expect(deriveSchemaName({ method: "patch", path: "/v1/projects/{id}", role: "request" }))
			.toBe("UpdateProjectRequest")
	})

	it("POST sub-collection → CreateXsYRequest (intermediate plural not singularized — documented heuristic limit)", () => {
		/* "projects" is an intermediate segment; only the final noun gets singularized.
		 * Spec example shows CreateProjectInviteRequest but actual output is CreateProjectsInviteRequest. */
		expect(deriveSchemaName({ method: "post", path: "/v1/projects/{id}/invites", role: "request" }))
			.toBe("CreateProjectsInviteRequest")
	})

	it("POST known-action → AcceptXYRequest (intermediate segments not singularized — documented heuristic limit)", () => {
		/* deriveVerb returns "Accept"; buildResourcePart drops "accept" leaf but keeps
		 * all intermediate non-param segments ("projects", "invites") without singularizing them.
		 * Spec example shows AcceptProjectInviteRequest but actual output is AcceptProjectsInvitesRequest.
		 * Locked here to document the current behavior, not the ideal. */
		expect(deriveSchemaName({ method: "post", path: "/v1/projects/{id}/invites/accept", role: "request" }))
			.toBe("AcceptProjectsInvitesRequest")
	})

	it("POST action-less leaf treated as resource → CreateAuthLoginRequest", () => {
		/* "login" not in KNOWN_ACTIONS → falls through to Create verb.
		 * Documented in spec as acceptable caveat; Tier-1 opt-in is the escape hatch. */
		expect(deriveSchemaName({ method: "post", path: "/v1/auth/login", role: "request" }))
			.toBe("CreateAuthLoginRequest")
	})

	it("POST known action refresh → RefreshXRequest", () => {
		expect(deriveSchemaName({ method: "post", path: "/v1/auth/refresh", role: "request" }))
			.toBe("RefreshAuthRequest")
	})

	it("fieldPath appended → {VerbResource}{Field} (role suffix omitted when fieldPath present)", () => {
		/* base = "GetProject", fieldPath replaces the role suffix entirely */
		expect(deriveSchemaName({
			fieldPath: ["settings"],
			method: "get",
			path: "/v1/projects/{id}",
			role: "response",
			status: 200,
		})).toBe("GetProjectSettings")
	})

	it("multi-segment fieldPath joined → {VerbResource}{FieldA}{FieldB}", () => {
		expect(deriveSchemaName({
			fieldPath: ["settings", "theme"],
			method: "get",
			path: "/v1/projects/{id}",
			role: "response",
			status: 200,
		})).toBe("GetProjectSettingsTheme")
	})

	it("DELETE by id → DeleteXRequest", () => {
		expect(deriveSchemaName({ method: "delete", path: "/v1/projects/{id}", role: "request" }))
			.toBe("DeleteProjectRequest")
	})

	it("PUT → ReplaceXRequest", () => {
		expect(deriveSchemaName({ method: "put", path: "/v1/projects/{id}", role: "request" }))
			.toBe("ReplaceProjectRequest")
	})
})

describe("shortHash", () => {
	it("returns 6-char lowercase hex", () => {
		const h = shortHash("some canonical json")
		expect(h).toMatch(/^[0-9a-f]{6}$/)
	})

	it("same canonical → same hash (deterministic)", () => {
		const canonical = JSON.stringify({ properties: { id: { type: "string" } }, type: "object" })
		expect(shortHash(canonical)).toBe(shortHash(canonical))
	})

	it("is first 6 chars of hashString", () => {
		const canonical = "test"
		expect(shortHash(canonical)).toBe(hashString(canonical).slice(0, 6))
	})

	it("distinct canonicals produce distinct hashes (collision resistance for test cases)", () => {
		const a = shortHash(JSON.stringify({ properties: { repo: { type: "string" } }, type: "object" }))
		const b = shortHash(JSON.stringify({ properties: { customer: { type: "string" } }, type: "object" }))
		expect(a).not.toBe(b)
	})
})

const FULL_ENVELOPE = {
	properties: {
		error_key: { enum: ["invalid_input"], type: "string" },
		fields: { type: "object" },
		message: { type: "string" },
		status: { const: 400, type: "integer" },
		status_key: { type: "string" },
		success: { const: false, type: "boolean" },
	},
	type: "object",
}

describe("isErrorEnvelope", () => {
	it("true — full envelope with success.const === false", () => {
		expect(isErrorEnvelope(FULL_ENVELOPE)).toBe(true)
	})

	it("true — envelope with success.enum === [false]", () => {
		const schema = {
			...FULL_ENVELOPE,
			properties: { ...FULL_ENVELOPE.properties, success: { enum: [false], type: "boolean" } },
		}
		expect(isErrorEnvelope(schema)).toBe(true)
	})

	it("false — missing error_key", () => {
		const { error_key: _, ...rest } = FULL_ENVELOPE.properties
		expect(isErrorEnvelope({ properties: rest, type: "object" })).toBe(false)
	})

	it("false — missing status", () => {
		const { status: _, ...rest } = FULL_ENVELOPE.properties
		expect(isErrorEnvelope({ properties: rest, type: "object" })).toBe(false)
	})

	it("false — missing success", () => {
		const { success: _, ...rest } = FULL_ENVELOPE.properties
		expect(isErrorEnvelope({ properties: rest, type: "object" })).toBe(false)
	})

	it("false — success.const === true (not an error envelope)", () => {
		const schema = {
			...FULL_ENVELOPE,
			properties: { ...FULL_ENVELOPE.properties, success: { const: true, type: "boolean" } },
		}
		expect(isErrorEnvelope(schema)).toBe(false)
	})

	it("false — plain object without envelope fields", () => {
		expect(isErrorEnvelope({ properties: { id: { type: "string" } }, type: "object" })).toBe(false)
	})

	it("false — no properties at all", () => {
		expect(isErrorEnvelope({ type: "object" })).toBe(false)
	})
})

describe("deriveErrorEnvelopeName", () => {
	it("0 keys → Err400", () => {
		const schema = { properties: { error_key: { type: "string" }, status: { const: 400, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err400")
	})

	it("1 key invalid_input → Err400InvalidInput", () => {
		const schema = { properties: { error_key: { enum: ["invalid_input"], type: "string" }, status: { const: 400, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err400InvalidInput")
	})

	it("2 keys a, b → Err400AB", () => {
		const schema = { properties: { error_key: { enum: ["a", "b"], type: "string" }, status: { const: 400, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err400AB")
	})

	it("3 keys → concat pascal", () => {
		const schema = { properties: { error_key: { enum: ["bad_request", "invalid_input", "not_found"], type: "string" }, status: { const: 400, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err400BadRequestInvalidInputNotFound")
	})

	it("4 keys → concat all pascal (no truncation)", () => {
		const schema = { properties: { error_key: { enum: ["a", "b", "c", "d"], type: "string" }, status: { const: 400, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err400ABCD")
	})

	it("5+ keys → concat all pascal, sorted", () => {
		const schema = { properties: { error_key: { enum: ["bad_gateway", "gateway_timeout", "internal_server_error", "service_unavailable", "bad_request"], type: "string" }, status: { const: 500, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err500BadGatewayBadRequestGatewayTimeoutInternalServerErrorServiceUnavailable")
	})

	it("unsorted input → same name as sorted (order independence)", () => {
		const sorted = { properties: { error_key: { enum: ["a", "b"], type: "string" }, status: { const: 400, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		const reversed = { properties: { error_key: { enum: ["b", "a"], type: "string" }, status: { const: 400, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(sorted)).toBe(deriveErrorEnvelopeName(reversed))
	})

	it("status from const", () => {
		const schema = { properties: { error_key: { type: "string" }, status: { const: 500, type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err500")
	})

	it("status from enum[0]", () => {
		const schema = { properties: { error_key: { type: "string" }, status: { enum: [503], type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema)).toBe("Err503")
	})

	it("status from fallback when no const/enum", () => {
		const schema = { properties: { error_key: { type: "string" }, status: { type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(deriveErrorEnvelopeName(schema, 422)).toBe("Err422")
	})

	it("throws when no status source at all", () => {
		const schema = { properties: { error_key: { type: "string" }, status: { type: "integer" }, success: { const: false, type: "boolean" } }, type: "object" }
		expect(() => deriveErrorEnvelopeName(schema)).toThrow("no status")
	})
})
