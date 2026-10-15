import { describe, expect, it } from "vitest"
import {
	deriveErrorEnvelopeName,
	deriveSchemaName,
	isErrorEnvelope,
	sanitizeComponentName,
	type SchemaNameContext,
	shortHash,
} from "./naming.ts"

describe("deriveSchemaName: a component name from the operation", () => {
	// v0: 0075d6c4ad
	// v0: d947e4db31
	// v0: d0f5c3b187
	// v0: 6526164b5d
	// v0: 9b5e11cb11
	// v0: 24f489e8ea
	// v0: a1878bfb8b
	// v0: 99054856fe
	// v0: 730c51fe37
	it.each<[string, SchemaNameContext, string]>([
		["a POST body creates", { method: "post", path: "/v1/projects", role: "request" }, "CreateProjectRequest"],
		[
			"a POST answer by status",
			{ method: "post", path: "/v1/projects", role: "response", status: 201 },
			"CreateProjectResponse201",
		],
		[
			"a POST error answer",
			{ method: "post", path: "/v1/projects", role: "response", status: 400 },
			"CreateProjectResponse400",
		],
		[
			"a GET of a collection lists, plural kept",
			{ method: "get", path: "/v1/projects", role: "response", status: 200 },
			"ListProjectsResponse200",
		],
		[
			"a GET by id gets",
			{ method: "get", path: "/v1/projects/{id}", role: "response", status: 200 },
			"GetProjectResponse200",
		],
		["a PATCH updates", { method: "patch", path: "/v1/projects/{id}", role: "request" }, "UpdateProjectRequest"],
		["a DELETE deletes", { method: "delete", path: "/v1/projects/{id}", role: "request" }, "DeleteProjectRequest"],
		["a PUT replaces", { method: "put", path: "/v1/projects/{id}", role: "request" }, "ReplaceProjectRequest"],
		["a known action is the verb", { method: "post", path: "/v1/auth/refresh", role: "request" }, "RefreshAuthRequest"],
	])("%s", (_name, context, expected) => {
		expect(deriveSchemaName(context)).toBe(expected)
	})
})

describe("deriveSchemaName: the heuristics, as they stand", () => {
	// v0: 1149efb3b7
	// v0: 535dd35747
	// v0: fcc1977df2
	it("singularizes only the last noun, drops a known action from the resource, and reads any other leaf as a resource", () => {
		expect([
			deriveSchemaName({ method: "post", path: "/v1/projects/{id}/invites", role: "request" }),
			deriveSchemaName({ method: "post", path: "/v1/projects/{id}/invites/accept", role: "request" }),
			deriveSchemaName({ method: "post", path: "/v1/auth/login", role: "request" }),
		]).toEqual(["CreateProjectsInviteRequest", "AcceptProjectsInvitesRequest", "CreateAuthLoginRequest"])
	})

	// v0: 5d9d2dcc21
	// v0: 46a3bf686b
	it("a nested field's path replaces the role suffix", () => {
		const at = { method: "get", path: "/v1/projects/{id}", role: "response", status: 200 } as const
		expect([
			deriveSchemaName({ ...at, fieldPath: ["settings"] }),
			deriveSchemaName({ ...at, fieldPath: ["settings", "theme"] }),
		]).toEqual(["GetProjectSettings", "GetProjectSettingsTheme"])
	})

	it("drops a variant after a collection, so the two variants collide and the hash tells them apart", () => {
		expect([
			deriveSchemaName({ method: "post", path: "/v1/webhooks/github", role: "request" }),
			deriveSchemaName({ method: "post", path: "/v1/webhooks/stripe", role: "request" }),
			deriveSchemaName({ method: "post", path: "/", role: "request" }),
		]).toEqual(["CreateWebhookRequest", "CreateWebhookRequest", "CreateRequest"])
	})
})

describe("sanitizeComponentName: a name every SDK language can use", () => {
	it("keeps letters, digits and _, joins the rest with _, and never starts with a digit", () => {
		expect(["user-profiles.v1", "__a__", "1st", "%%", "Ok_2"].map(sanitizeComponentName)).toEqual([
			"user_profiles_v1",
			"a",
			"S1st",
			"",
			"Ok_2",
		])
	})
})

describe("shortHash: six hex characters of the content", () => {
	// v0: c34dcdb322
	// v0: b0d0a39b77
	// v0: 0e46b8dd5e
	// v0: 70a9166d43
	it("is the leading six of a djb2 hash: stable, and apart for different content", () => {
		const repo = JSON.stringify({ properties: { repo: { type: "string" } }, type: "object" })
		const customer = JSON.stringify({ properties: { customer: { type: "string" } }, type: "object" })
		expect([shortHash("test"), shortHash(""), shortHash(repo) === shortHash(repo)]).toEqual(["7c9e68", "000015", true])
		expect(shortHash(repo)).toMatch(/^[0-9a-f]{6}$/)
		expect(shortHash(repo)).not.toBe(shortHash(customer))
	})
})

const ENVELOPE = {
	properties: {
		error_key: { enum: ["invalid_input"], type: "string" },
		message: { type: "string" },
		status: { const: 400, type: "integer" },
		success: { const: false, type: "boolean" },
	},
	type: "object",
}

/** `ENVELOPE` with `key` set to `value`, or left out when `value` is undefined. */
function envelope(key: string, value: unknown) {
	const properties: Record<string, unknown> = { ...ENVELOPE.properties, [key]: value }
	if (value === undefined) delete properties[key]
	return { properties, type: "object" }
}

describe("isErrorEnvelope: honey's error body", () => {
	// v0: eaa140d1b2
	// v0: 9e9a99c5e7
	// v0: 3bca1654b4
	// v0: ef03a293c2
	// v0: 26f255bb99
	// v0: 0ae1dbb05a
	// v0: 1002db7bfa
	// v0: b1baecb964
	it("needs error_key, status and a success that can only be false", () => {
		expect(
			[
				ENVELOPE,
				envelope("success", { enum: [false], type: "boolean" }),
				envelope("error_key", undefined),
				envelope("status", undefined),
				envelope("success", undefined),
				envelope("success", { const: true, type: "boolean" }),
				envelope("success", { enum: [false, true], type: "boolean" }),
				{ properties: { id: { type: "string" } }, type: "object" },
				{ type: "object" },
			].map(isErrorEnvelope),
		).toEqual([true, true, false, false, false, false, false, false, false])
	})
})

/** An error envelope of `status` (a const) whose error_key is one of `keys`. */
function errors(status: unknown, keys?: readonly string[]) {
	return {
		properties: {
			error_key: keys === undefined ? { type: "string" } : { enum: keys, type: "string" },
			status,
			success: { const: false, type: "boolean" },
		},
		type: "object",
	}
}

describe("deriveErrorEnvelopeName: Err, the status, then every key", () => {
	// v0: ff1626e2f4
	// v0: 02729efb99
	// v0: de7467b825
	// v0: fa851d22fe
	// v0: e09c7eddff
	// v0: f4d2c9a8c0
	// v0: 3c4ad8c52f
	it("joins every error key, sorted and in PascalCase, never truncated", () => {
		const status = { const: 400, type: "integer" }
		expect([
			deriveErrorEnvelopeName(errors(status), undefined),
			deriveErrorEnvelopeName(errors(status, ["invalid_input"]), undefined),
			deriveErrorEnvelopeName(errors(status, ["b", "a"]), undefined),
			deriveErrorEnvelopeName(errors(status, ["not_found", "bad_request", "invalid_input"]), undefined),
			deriveErrorEnvelopeName(errors(status, ["a", "b", "c", "d"]), undefined),
			deriveErrorEnvelopeName(
				errors({ const: 500 }, ["service_unavailable", "bad_gateway", "internal_server_error", "gateway_timeout"]),
				undefined,
			),
		]).toEqual([
			"Err400",
			"Err400InvalidInput",
			"Err400AB",
			"Err400BadRequestInvalidInputNotFound",
			"Err400ABCD",
			"Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable",
		])
	})

	// v0: 96a7f91074
	// v0: ef6cd0c4c4
	// v0: 68dba0014d
	it("reads the status from its const, then a one-value enum, then the response's status, else names it without one", () => {
		expect([
			deriveErrorEnvelopeName(errors({ const: 500, type: "integer" }), 422),
			deriveErrorEnvelopeName(errors({ enum: [503], type: "integer" }), 422),
			deriveErrorEnvelopeName(errors({ type: "integer" }), 422),
			deriveErrorEnvelopeName(errors({ type: "integer" }, ["denied"]), undefined),
		]).toEqual(["Err500", "Err503", "Err422", "ErrDenied"])
	})
})
