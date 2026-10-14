import { describe, expect, expectTypeOf, it } from "vitest"
import { codeToStatusKey, type StatusKey, statusKeyToCode } from "./status.ts"

const expectedMapping: Record<string, number> = {
	accepted: 202,
	already_reported: 208,
	bad_gateway: 502,
	bad_request: 400,
	conflict: 409,
	content_too_large: 413,
	created: 201,
	expectation_failed: 417,
	failed_dependency: 424,
	forbidden: 403,
	found: 302,
	gateway_timeout: 504,
	gone: 410,
	http_version_not_supported: 505,
	im_a_teapot: 418,
	im_used: 226,
	insufficient_storage: 507,
	internal_server_error: 500,
	length_required: 411,
	locked: 423,
	loop_detected: 508,
	method_not_allowed: 405,
	misdirected_request: 421,
	moved_permanently: 301,
	multi_status: 207,
	multiple_choices: 300,
	network_authentication_required: 511,
	no_content: 204,
	non_authoritative_information: 203,
	not_acceptable: 406,
	not_extended: 510,
	not_found: 404,
	not_implemented: 501,
	not_modified: 304,
	ok: 200,
	partial_content: 206,
	payment_required: 402,
	permanent_redirect: 308,
	precondition_failed: 412,
	precondition_required: 428,
	proxy_authentication_required: 407,
	range_not_satisfiable: 416,
	request_header_fields_too_large: 431,
	request_timeout: 408,
	reset_content: 205,
	see_other: 303,
	service_unavailable: 503,
	temporary_redirect: 307,
	too_early: 425,
	too_many_requests: 429,
	unauthorized: 401,
	unavailable_for_legal_reasons: 451,
	unprocessable_entity: 422,
	unsupported_media_type: 415,
	upgrade_required: 426,
	uri_too_long: 414,
	variant_also_negotiates: 506,
}

describe("StatusKey ↔ code mapping", () => {
	// v0: f0d3e254d6
	it("maps every StatusKey to expected HTTP code", () => {
		for (const [key, code] of Object.entries(expectedMapping)) expect(statusKeyToCode[key as StatusKey], key).toBe(code)
	})

	// v0: 36e82ac29b
	it("has exactly 57 entries", () => {
		expect(Object.keys(statusKeyToCode)).toHaveLength(57)
	})

	// v0: fabb19e791
	it("round-trips StatusKey → code → StatusKey for all entries", () => {
		for (const [key, code] of Object.entries(expectedMapping)) expect(codeToStatusKey[code], key).toBe(key)
	})

	// v0: ce274fde2d
	it("codeToStatusKey reverse lookup for all codes", () => {
		for (const [key, code] of Object.entries(statusKeyToCode)) expect(codeToStatusKey[code], key).toBe(key)
	})
})

describe("codeToStatusKey reverse lookup", () => {
	// v0: d26a051f75
	it("all status codes map correctly", () => {
		for (const [key, code] of Object.entries(statusKeyToCode)) expect(codeToStatusKey[code]).toBe(key)
	})

	// v0: 281141953c
	it("unknown status code → undefined", () => {
		expect(codeToStatusKey[999]).toBeUndefined()
		expect(codeToStatusKey[0]).toBeUndefined()
	})
})

describe("type-level tests", () => {
	// v0: 90fe04ec2f
	it("StatusKey covers common keys", () => {
		expectTypeOf<
			| "accepted"
			| "bad_gateway"
			| "bad_request"
			| "conflict"
			| "created"
			| "forbidden"
			| "found"
			| "gateway_timeout"
			| "gone"
			| "im_a_teapot"
			| "internal_server_error"
			| "method_not_allowed"
			| "moved_permanently"
			| "no_content"
			| "not_found"
			| "not_implemented"
			| "ok"
			| "content_too_large"
			| "payment_required"
			| "permanent_redirect"
			| "request_timeout"
			| "service_unavailable"
			| "temporary_redirect"
			| "too_many_requests"
			| "unauthorized"
			| "unprocessable_entity"
		>().toMatchTypeOf<StatusKey>()
	})
})
