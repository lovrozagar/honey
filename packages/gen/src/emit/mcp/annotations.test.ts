/**
 * A tool's annotations (bit 18 phase d), by method, each hint only where it differs from the spec's default: GET and
 * HEAD read only, a POST not destructive (and idempotent with an idempotency key), PUT and DELETE idempotent, PATCH
 * none at all.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { sdkModel } from "../../ir/sdk-model.ts"
import { annotationsOf } from "./annotations.ts"

/** The annotations of one `method` operation, with `more` on it. */
function annotations(method: string, more: Record<string, unknown> = {}) {
	const ir = toIR(
		{
			info: { title: "A", version: "1" },
			openapi: "3.1.0",
			paths: { "/a": { [method]: { operationId: "a.do", responses: { 204: { description: "done" } }, ...more } } },
		} as unknown as OpenApiDocument,
		{ deriveOperationIds: true },
	)
	return annotationsOf(sdkModel(ir).ops[0] as NonNullable<ReturnType<typeof sdkModel>["ops"][number]>)
}

describe("a tool's annotations (phase d)", () => {
	it.each([
		["GET", "get", {}, { readOnlyHint: true }],
		["HEAD", "head", {}, { readOnlyHint: true }],
		["POST", "post", {}, { destructiveHint: false }],
		[
			"a POST taking an idempotency key",
			"post",
			{ "x-idempotency-key": true },
			{ destructiveHint: false, idempotentHint: true },
		],
		["PUT", "put", {}, { idempotentHint: true }],
		["DELETE", "delete", {}, { idempotentHint: true }],
		["PATCH", "patch", {}, undefined],
		["OPTIONS", "options", {}, undefined],
	])("writes %s's hints, none at its default", (_, method, more, expected) => {
		expect(annotations(method, more)).toEqual(expected)
	})
})
