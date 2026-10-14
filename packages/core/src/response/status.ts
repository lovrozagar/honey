/** The status vocabulary: every 2xx–5xx status as the snake_case key handlers and errors name it by. */

export type StatusKey =
	/* 2xx success */
	| "accepted"
	| "already_reported"
	| "created"
	| "im_used"
	| "multi_status"
	| "no_content"
	| "non_authoritative_information"
	| "ok"
	| "partial_content"
	| "reset_content"
	/* 3xx redirection */
	| "found"
	| "moved_permanently"
	| "multiple_choices"
	| "not_modified"
	| "permanent_redirect"
	| "see_other"
	| "temporary_redirect"
	/* 4xx client error */
	| "bad_request"
	| "conflict"
	| "expectation_failed"
	| "failed_dependency"
	| "forbidden"
	| "gone"
	| "im_a_teapot"
	| "length_required"
	| "locked"
	| "method_not_allowed"
	| "misdirected_request"
	| "not_acceptable"
	| "not_found"
	| "content_too_large"
	| "payment_required"
	| "precondition_failed"
	| "precondition_required"
	| "proxy_authentication_required"
	| "range_not_satisfiable"
	| "request_header_fields_too_large"
	| "request_timeout"
	| "too_early"
	| "too_many_requests"
	| "unauthorized"
	| "unavailable_for_legal_reasons"
	| "unprocessable_entity"
	| "unsupported_media_type"
	| "upgrade_required"
	| "uri_too_long"
	/* 5xx server error */
	| "bad_gateway"
	| "gateway_timeout"
	| "http_version_not_supported"
	| "insufficient_storage"
	| "internal_server_error"
	| "loop_detected"
	| "network_authentication_required"
	| "not_extended"
	| "not_implemented"
	| "service_unavailable"
	| "variant_also_negotiates"

export const statusKeyToCode: Readonly<Record<StatusKey, number>> = /* @__PURE__ */ Object.freeze({
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
})

function invert(map: Readonly<Record<StatusKey, number>>): Readonly<Record<number, StatusKey>> {
	const out: Record<number, StatusKey> = Object.create(null)
	for (const key of Object.keys(map) as StatusKey[]) out[map[key]] = key
	return Object.freeze(out)
}

/** HTTP code → status key; `undefined` for a code outside the vocabulary. */
export const codeToStatusKey: Readonly<Record<number, StatusKey>> = /* @__PURE__ */ invert(statusKeyToCode)
