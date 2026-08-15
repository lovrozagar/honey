import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ── shared fixture builder ── */

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

/*
 * Canonical Honey error envelope schemas. Two distinct 400 variants (errEnvelope400,
 * errEnvelope401) and a 404 variant (errEnvelope404) are combined into errorsA / errorsB
 * so the fixture produces at least two distinct _Errs aliases — required for #R6-19.
 */
function makeErrEnvelope(status: number, errorKey: string) {
	return {
		properties: {
			error_key: { enum: [errorKey] },
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
			status: { enum: [status] },
			status_key: { type: "string" },
			success: { const: false },
		},
	}
}
const errEnvelope400 = makeErrEnvelope(400, "invalid_input")
const errEnvelope401 = makeErrEnvelope(401, "unauthorized")
const errEnvelope404 = makeErrEnvelope(404, "not_found")

/* Two distinct shared error sets — produces 2+ _Errs aliases for #R6-19 sort test */
const errorsA = {
	"400": { content: { "application/json": { schema: errEnvelope400 } } },
	"401": { content: { "application/json": { schema: errEnvelope401 } } },
}
const errorsB = {
	"400": { content: { "application/json": { schema: errEnvelope400 } } },
	"404": { content: { "application/json": { schema: errEnvelope404 } } },
}

/*
 * Shared response schemas — object-with-properties so jsonSchemaToTS produces
 * { ... } shapes that pass isHoistableResponseType.
 */
const responseSchemaA = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	type: "object",
}
const responseSchemaB = {
	properties: { count: { type: "number" }, items: { type: "array" } },
	type: "object",
}

/*
 * Primary fixture — canonical path order.
 *
 * Path ordering is deliberate for #R6-19: /v1/beta paths (errorsB) come BEFORE
 * /v1/alpha paths (errorsA) so errorsB is the first unique error type string pushed
 * into errCounts. In the reordered spec the order is reversed, making errorsA first.
 * Pre-fix the alias numbering differs; post-fix the sort makes them identical.
 *
 * Other requirements served by this fixture:
 * - project.export 200 with no content -> #R6-15 void bug
 * - extract: single _call action -> #R6-27 promotion candidate
 * - project/{project_id}: path params -> #R6-20 param validation
 * - items.create x-invalidate -> #R6-17 by[] cap visibility
 */
/* eslint-disable sort-keys -- intentional: /v1/beta before /v1/alpha forces errorsB first in errCounts for #R6-19 bug witness */
const phaseHFixtureSpec = makeSpec({
	"/v1/beta": {
		get: {
			operationId: "beta.list",
			responses: { "200": { content: { "application/json": { schema: responseSchemaB } } }, ...errorsB },
		},
		post: {
			operationId: "beta.create",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaB } } }, ...errorsB },
			"x-invalidate": ["GET /v1/beta"],
		},
	},
	"/v1/alpha": {
		get: {
			operationId: "alpha.list",
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsA },
		},
		post: {
			operationId: "alpha.create",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsA },
		},
	},
	"/v1/projects/{project_id}": {
		get: {
			operationId: "project.get",
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsB },
		},
		patch: {
			operationId: "project.update",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsA },
		},
	},
	"/v1/projects/{project_id}/export": {
		post: {
			operationId: "project.export",
			/* no content — triggers #R6-15 void bug */
			responses: { "200": {} },
		},
	},
	"/v1/extract": {
		post: {
			/* single _call action — triggers #R6-27 promotion */
			operationId: "extract",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaB } } }, ...errorsA },
		},
	},
})
/* eslint-enable sort-keys */

/*
 * Reordered spec — /v1/alpha (errorsA) paths come first, /v1/beta (errorsB) second.
 * Same operations and schemas, different Map insertion order. Pre-fix, _Errs0 is
 * errorsA in this spec but errorsB in phaseHFixtureSpec, so the files.types differ.
 * Post-fix, the sort makes numbering independent of insertion order.
 */
/* eslint-disable sort-keys -- intentional: /v1/projects/{project_id}/export before /v1/projects/{project_id} to produce reversed alias numbering for #R6-19 bug witness */
const phaseHReorderedSpec = makeSpec({
	"/v1/alpha": {
		get: {
			operationId: "alpha.list",
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsA },
		},
		post: {
			operationId: "alpha.create",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsA },
		},
	},
	"/v1/beta": {
		get: {
			operationId: "beta.list",
			responses: { "200": { content: { "application/json": { schema: responseSchemaB } } }, ...errorsB },
		},
		post: {
			operationId: "beta.create",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaB } } }, ...errorsB },
			"x-invalidate": ["GET /v1/beta"],
		},
	},
	"/v1/extract": {
		post: {
			operationId: "extract",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaB } } }, ...errorsA },
		},
	},
	"/v1/projects/{project_id}/export": {
		post: {
			operationId: "project.export",
			responses: { "200": {} },
		},
	},
	"/v1/projects/{project_id}": {
		get: {
			operationId: "project.get",
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsB },
		},
		patch: {
			operationId: "project.update",
			requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } }, ...errorsA },
		},
	},
})
/* eslint-enable sort-keys */

/* ═══════════════════════════════════════════════════════════════════
   #R6-15 — void -> null
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-15 void->null — Layer B' regression", () => {
	it("Layer B' post-fix: project.export method return type contains Promise<null> not Promise<void>", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const exportMethodIdx = files.types.indexOf(`\t\t"export"(`)
		expect(exportMethodIdx).toBeGreaterThan(-1)
		const exportLine = files.types.slice(exportMethodIdx, files.types.indexOf("\n", exportMethodIdx))
		expect(exportLine).toContain("Promise<null>")
		expect(exportLine).not.toContain("Promise<void>")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-19 — deterministic sort
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-19 deterministic sort — Layer A invariants", () => {
	it("Layer A: generating from same spec twice produces byte-identical files.types", () => {
		const { files: a } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const { files: b } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(a.types).toBe(b.types)
	})

	it("Layer A: generating from same spec twice produces byte-identical files.client", () => {
		const { files: a } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const { files: b } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(a.client).toBe(b.client)
	})
})

describe("#R6-19 deterministic sort — Layer B' regression", () => {
	it("Layer B' post-fix: reordered spec produces byte-identical files.types as canonical order", () => {
		const { files: canonical } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const { files: reordered } = generateSDK(phaseHReorderedSpec, { name: "TestSDK" })
		expect(canonical.types).toBe(reordered.types)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-28 — suffix hoist (_HttpOpts/_SseOpts/_WsOpts)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-28 suffix hoist — Layer B' regression", () => {
	it("Layer B' post-fix: files.types contains type _HttpOpts = {", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("type _HttpOpts = {")
	})

	it("Layer B' post-fix: files.types contains type _SseOpts = {", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("type _SseOpts = {")
	})

	it("Layer B' post-fix: files.types contains type _WsOpts = {", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("type _WsOpts = {")
	})

	it("Layer B' post-fix: signal?: AbortSignal appears exactly 2 times in files.types (_HttpOpts and _SseOpts only)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const matches = files.types.match(/signal\?: AbortSignal/g)
		expect((matches ?? []).length).toBe(2)
	})

	it("Layer B' post-fix: files.types contains & _HttpOpts at least once (method intersection)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("& _HttpOpts")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-29 — input dedupe (_Inp\d)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-29 input dedupe — Layer B' regression", () => {
	it("Layer B' post-fix: files.types contains at least one type _Inp alias", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("type _Inp")
	})

	it("Layer B' post-fix: files.types method signatures use _Expand<_Inp for shared input shapes", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("_Expand<_Inp")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-27 — _call resource promotion to callable
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-27 _call promotion — Layer B' regression types", () => {
	it("Layer B' post-fix: files.types does NOT contain extract: { _call( nested wrapper", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const extractIdx = files.types.indexOf("extract: {")
		if (extractIdx !== -1) {
			const extractBlock = files.types.slice(extractIdx, extractIdx + 200)
			expect(extractBlock).not.toContain("_call(")
		}
	})

	it("Layer B' post-fix: files.types contains extract(input: at interface top level (promoted callable)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("extract(input:")
	})

	it("Layer B' post-fix: multi-action resource alpha still uses nested shape (alpha: {)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("alpha: {")
	})

	it("Layer B' post-fix: multi-action resource project still uses nested shape (project: {)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("project: {")
	})
})

describe("#R6-27 _call promotion — Layer B' regression client strings", () => {
	it("Layer B' post-fix: files.client contains the _call promotion guard (actions.length === 1 && actions[0] === \"_call\")", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain(`nodeKeys.length === 1 && nodeKeys[0] === "_call"`)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-20 — path param _ClientError wrap
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-20 path param wrap — Layer B' regression", () => {
	it("Layer B' post-fix: files.client contains for (const p of entry.params) validation loop", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("for (const p of entry.params)")
	})

	it("Layer B' post-fix: files.client contains Missing required path param descriptive message", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("Missing required path param")
	})

	it("Layer B' post-fix: files.client contains status: 0 at least twice (throw + safe returns)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const matches = files.client.match(/status: 0/g)
		expect((matches ?? []).length).toBeGreaterThanOrEqual(2)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-18 — JSON.stringify wrap
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-18 JSON.stringify wrap — Layer B' regression", () => {
	it("Layer B' post-fix: files.client contains JSON serialization failed descriptive error", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("JSON serialization failed")
	})

	it("Layer B' post-fix: files.client contains try { near JSON.stringify(opts.json) (wrapped call)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		const stringifyIdx = files.client.indexOf("JSON.stringify(opts.json)")
		expect(stringifyIdx).toBeGreaterThan(-1)
		/* try { must appear within 100 chars before the stringify call */
		const preceding = files.client.slice(Math.max(0, stringifyIdx - 100), stringifyIdx)
		expect(preceding).toContain("try {")
	})

	it("Layer B' post-fix: files.client #requestSafe contains if (e instanceof _ClientError) safe-mode catch", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("if (e instanceof _ClientError)")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-17 — magic number config surface
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-17 magic number config — Layer B' regression", () => {
	it("Layer B' post-fix: files.types config type contains maxErrorMessageChars?: number", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("maxErrorMessageChars?:")
	})

	it("Layer B' post-fix: files.types config type contains sseMaxBufferChars?: number", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("sseMaxBufferChars?:")
	})

	it("Layer B' post-fix: files.types config type contains maxSourcesPerTarget?: number", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.types).toContain("maxSourcesPerTarget?:")
	})

	it("Layer B' post-fix: files.client contains this.#maxErrorMessageChars field reference", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#maxErrorMessageChars")
	})

	it("Layer B' post-fix: files.client contains this.#sseMaxBufferChars field reference", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#sseMaxBufferChars")
	})

	it("Layer B' post-fix: files.client contains this.#staleMaxEntries field reference", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#staleMaxEntries")
	})

	it("Layer B' post-fix: files.client contains this.#maxSourcesPerTarget field reference", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#maxSourcesPerTarget")
	})

	it("Layer B' post-fix: files.client does NOT contain const maxBuffer = 1024 * 1024 (old literal gone)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).not.toContain("const maxBuffer = 1024 * 1024")
	})

	it("Layer B' post-fix: files.client does NOT contain .slice(0, 512) (old literal gone)", () => {
		const { files } = generateSDK(phaseHFixtureSpec, { name: "TestSDK" })
		expect(files.client).not.toContain(".slice(0, 512)")
	})
})
