import { existsSync, statSync } from "node:fs"
import { describe, expect, expectTypeOf, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ── helpers (copied from sdk-r4-phase-a.test.ts) ── */

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

function makeErrResponse(statusCode: number, keys: string[]) {
	return {
		content: {
			"application/json": {
				schema: {
					properties: {
						error_key: { enum: keys, type: "string" },
						fields: {
							additionalProperties: { items: { type: "object" }, type: "array" },
							type: "object",
						},
						message: { type: "string" },
						status: { enum: [statusCode], type: "integer" },
						status_key: { type: "string" },
						success: { const: false, type: "boolean" },
					},
					required: ["error_key", "fields", "message", "status", "status_key", "success"],
					type: "object",
				},
			},
		},
	}
}

/* a large response schema shared by multiple methods — target for _Res dedupe */
const sharedResponseSchema = {
	properties: {
		items: {
			items: {
				properties: {
					created_at: { type: "string" },
					id: { type: "string" },
					name: { type: "string" },
					updated_at: { type: "string" },
				},
				required: ["id", "name", "created_at", "updated_at"],
				type: "object",
			},
			type: "array",
		},
		page: { type: "integer" },
		total: { type: "integer" },
	},
	required: ["items", "page", "total"],
	type: "object",
} as const

function makeJsonResponse(schema: Record<string, unknown>) {
	return { content: { "application/json": { schema } } }
}

/* fixture with 3 methods sharing an identical long response shape */
const dedupeResponseSpec = makeSpec({
	"/a/list": {
		get: {
			operationId: "a.list",
			responses: {
				"200": makeJsonResponse(sharedResponseSchema),
				"400": makeErrResponse(400, ["invalid_input"]),
			},
		},
	},
	"/b/list": {
		get: {
			operationId: "b.list",
			responses: {
				"200": makeJsonResponse(sharedResponseSchema),
				"400": makeErrResponse(400, ["invalid_input"]),
			},
		},
	},
	"/c/list": {
		get: {
			operationId: "c.list",
			responses: {
				"200": makeJsonResponse(sharedResponseSchema),
				"400": makeErrResponse(400, ["invalid_input"]),
			},
		},
	},
})

/* fixture with 1 method and a long response that should be hoisted by length threshold */
const longUniqueResponseSpec = makeSpec({
	"/unique/list": {
		get: {
			operationId: "unique.list",
			responses: {
				"200": makeJsonResponse({
					properties: {
						big_obj: {
							properties: {
								alpha: { type: "string" },
								beta: { type: "string" },
								delta: { type: "string" },
								epsilon: { type: "string" },
								gamma: { type: "string" },
								iota: { type: "string" },
								kappa: { type: "string" },
								lambda: { type: "string" },
								theta: { type: "string" },
								zeta: { type: "string" },
							},
							required: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "iota", "kappa", "lambda"],
							type: "object",
						},
						items: {
							items: {
								properties: {
									created_at: { type: "string" },
									description: { type: "string" },
									id: { type: "string" },
									name: { type: "string" },
									tags: { items: { type: "string" }, type: "array" },
								},
								required: ["id", "name", "description", "tags", "created_at"],
								type: "object",
							},
							type: "array",
						},
						meta: {
							properties: {
								has_next: { type: "boolean" },
								page: { type: "integer" },
								total: { type: "integer" },
							},
							required: ["page", "total", "has_next"],
							type: "object",
						},
					},
					required: ["items", "meta", "big_obj"],
					type: "object",
				}),
			},
		},
	},
})

/* fixture with both SSE and WS endpoints for R5-5 and R5-6 */
const streamingSpec = makeSpec({
	"/stream": {
		get: {
			operationId: "events.stream",
			responses: {
				"200": { content: { "text/event-stream": { schema: { type: "string" } } } },
			},
		},
	},
	"/ws": {
		get: {
			operationId: "ws.connect",
			responses: { "200": {} },
			"x-websocket": true,
		},
	},
})

/* optional local fixture for the R5-3 file-size baseline */
const ANYROW_TYPES_PATH = process.env.HONEY_ANYROW_TYPES_PATH

/*
 * Baseline captured at tester-baseline time (Phase A ceiling = 228642 bytes).
 * Cleaner's Phase D R5-3 fix must shrink this below 80% = 182913 bytes.
 */
const ANYROW_TYPES_BASELINE_BYTES = 228_642
const ANYROW_TYPES_TARGET_PCT = 0.8

/* ═══════════════════════════════════════════════════════════════════
   R5-1 — `_ErrField` recursive shape lie
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-1 _ErrField shape — no recursive fields key", () => {
	it("R5-1: _ErrField type does not declare recursive fields key", () => {
		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })
		/*
		 * Capture the _ErrField alias line — it should NOT contain `fields:` inside its body.
		 * The envelope-level `fields: Record<string, _ErrField[]>` on _ErrEnvelope is correct
		 * and must not confuse this check, so we assert strictly on the _ErrField alias
		 * declaration.
		 */
		const errFieldLine = files.types
			.split("\n")
			.find((l) => l.trimStart().startsWith("type _ErrField ="))
		expect(errFieldLine).toBeDefined()
		/* must be flat — no nested fields key */
		expect(errFieldLine).not.toMatch(/type _ErrField\s*=\s*\{[^}]*fields:/)
	})

	it("R5-1: _ErrField declares exactly { error_key; message; path } as a flat literal", () => {
		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })
		/*
		 * Whitespace-tolerant contain check for the flat literal. The current buggy
		 * form is `{ error_key: string; fields: ...; message: string; path: string }`
		 * so this substring match (no `fields:` between error_key and message) FAILS
		 * against current → RED. After fix, `{ error_key: string; message: string; path: string }`
		 * is the whole body → substring found → GREEN.
		 */
		expect(files.types).toContain(
			"{ error_key: string; message: string; path: string }",
		)
	})

	it("R5-1: _ErrField keys equal exactly (error_key | message | path) via inline replica", () => {
		/*
		 * The generated type lives in a separate package we cannot import across
		 * workspaces, so we assert on the emitted STRING directly: parse the
		 * _ErrField declaration and confirm no key other than error_key/message/path
		 * appears. Type-level shape assertion via inline replica below locks the
		 * expected shape so the test body doubles as documentation.
		 */
		type ExpectedErrField = { error_key: string; message: string; path: string }
		expectTypeOf<keyof ExpectedErrField>().toEqualTypeOf<"error_key" | "message" | "path">()

		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })
		const errFieldLine = files.types
			.split("\n")
			.find((l) => l.trimStart().startsWith("type _ErrField ="))
		if (!errFieldLine) {
			throw new Error("_ErrField declaration not found in generated types")
		}

		/* extract the object literal body — between the first `{` and the matching `}` on this line */
		const open = errFieldLine.indexOf("{")
		const close = errFieldLine.lastIndexOf("}")
		expect(open).toBeGreaterThan(-1)
		expect(close).toBeGreaterThan(open)
		const body = errFieldLine.slice(open + 1, close)
		/* split by `;` and extract the key name on each entry */
		const keys = body
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.map((s) => {
				const head = s.split(":")[0]
				return head === undefined ? "" : head.trim()
			})
			.sort()
		expect(keys).toEqual(["error_key", "message", "path"])
	})
})

/* ═══════════════════════════════════════════════════════════════════
   R5-2 — `SDKResult` fallback absorbs typed-error narrowing
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-2 SDKResult narrowing — typed branch has no unknown fallback", () => {
	it("R5-2: typed branch of SDKResult does not emit `| { data: null; error: unknown ... }` fallback", () => {
		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })

		/* locate the SDKResult declaration */
		const sdkResIdx = files.types.indexOf("export type SDKResult<")
		expect(sdkResIdx).toBeGreaterThan(-1)
		/* slice to the end of the SDKResult declaration (closing paren + newline) */
		const tail = files.types.slice(sdkResIdx)
		/* the SDKResult block ends at the first blank line after the opening */
		const blankIdx = tail.indexOf("\n\n")
		expect(blankIdx).toBeGreaterThan(-1)
		const block = tail.slice(0, blankIdx)

		/*
		 * The untyped branch (`[TErrorsByStatus] extends [never]`) is allowed to emit
		 * `{ data: null; error: unknown; ... }`. The TYPED branch (the `: ...` arm of the
		 * conditional) must NOT have a trailing `| { data: null; error: unknown; ... }`
		 * fallback because that collapses discriminated-union narrowing back to unknown.
		 *
		 * Strategy: after the mapped-type line (`{ [S in keyof TErrorsByStatus & number]: ... }`),
		 * the next line inside the typed branch should close the paren — NOT add an
		 * `| { data: null; error: unknown ... }` arm.
		 */
		const mappedIdx = block.indexOf("[S in keyof TErrorsByStatus")
		expect(mappedIdx).toBeGreaterThan(-1)
		const typedBranchTail = block.slice(mappedIdx)
		/* In the buggy form this tail contains a second `| { data: null; error: unknown`
		 * AFTER the mapped-type arm. Assert that substring does NOT appear. */
		expect(typedBranchTail).not.toMatch(/\|\s*\{\s*data:\s*null;\s*error:\s*unknown/)
	})

	it("R5-2: typed branch of SDKResult closes immediately after mapped-type arm (no trailing unknown fallback)", () => {
		/*
		 * Complementary structural lock: check that the typed-branch arm of
		 * `SDKResult` consists of EXACTLY the mapped-type expression, followed by
		 * the closing paren. In the buggy form there is a `| { data: null; error:
		 * unknown; response: Response; status: number })` line between the
		 * mapped-type arm and the closing paren. In the fixed form the mapped
		 * type line ends with `...[keyof TErrorsByStatus & number])` — the
		 * close-paren is on the same line as the mapped-type terminator.
		 *
		 * Note: vitest in this repo does NOT run typecheck, so a pure type-level
		 * `expectTypeOf` assertion is a no-op. We use structural string matching
		 * instead; the type-level intent is the same — the fallback must be gone
		 * from the typed branch entirely.
		 */
		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })
		const sdkResIdx = files.types.indexOf("export type SDKResult<")
		expect(sdkResIdx).toBeGreaterThan(-1)
		const tail = files.types.slice(sdkResIdx)
		const blankIdx = tail.indexOf("\n\n")
		expect(blankIdx).toBeGreaterThan(-1)
		const block = tail.slice(0, blankIdx)

		/*
		 * Match the mapped-type arm and require its closing `)` to come on the
		 * SAME line (or immediately after) — no second `|` arm is permitted
		 * between the mapped-type arm and the conditional's closing paren.
		 */
		const lines = block.split("\n")
		const mappedLineIdx = lines.findIndex((l) => l.includes("[S in keyof TErrorsByStatus"))
		expect(mappedLineIdx).toBeGreaterThan(-1)

		/*
		 * After the mapped-type line, the conditional must close. That is: the
		 * mapped-type line either ends with `)` (closing the conditional) OR
		 * the NEXT non-empty line starts with `)`. Any other pattern (in
		 * particular `| { data: null; error: unknown`) means the fallback is
		 * still present → RED.
		 */
		const mappedLine = lines[mappedLineIdx] ?? ""
		const closesOnMappedLine = mappedLine.trimEnd().endsWith(")")
		let closesOnNextLine = false
		if (!closesOnMappedLine) {
			const nextLine = (lines[mappedLineIdx + 1] ?? "").trimStart()
			closesOnNextLine = nextLine.startsWith(")")
		}
		expect(closesOnMappedLine || closesOnNextLine).toBe(true)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   R5-3 — Response-type dedupe
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-3 response-type dedupe — _Res aliases + file size", () => {
	it("R5-3: generated types contain at least one _Res\\d alias for a shared response shape", () => {
		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })
		expect(files.types).toMatch(/type _Res\d+\s*=/)
	})

	it("R5-3: no two identical long response literals appear in the interface body", () => {
		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })
		/* isolate the interface body */
		const ifaceStart = files.types.indexOf("export interface ")
		expect(ifaceStart).toBeGreaterThan(-1)
		const ifaceBody = files.types.slice(ifaceStart)

		/*
		 * Collect every occurrence of the shared response literal (well-known fragment
		 * that identifies it). In the buggy form the literal shows up twice per method
		 * (once in the throw branch, once in the safe branch) × 3 methods = 6 times.
		 * After dedupe it should be replaced by an alias (_Res\d) and the literal body
		 * itself should appear ZERO times inside the interface.
		 */
		const needle = "items: { created_at: string; id: string; name: string; updated_at: string }[]"
		const count = ifaceBody.split(needle).length - 1
		expect(count).toBe(0)
	})

	it("R5-3: long single-use response literals are hoisted to _Res aliases via length threshold", () => {
		const { files } = generateSDK(longUniqueResponseSpec, { name: "TestSDK" })
		/* at least one _Res alias must exist */
		expect(files.types).toMatch(/type _Res\d+\s*=/)
		/*
		 * The unique method `unique.list` has a response shape that is >200 chars.
		 * After hoisting, its method signature should reference the alias instead of
		 * inlining the literal twice. The literal `big_obj:` fragment should appear
		 * only once (in the alias definition) — NOT twice in the interface body.
		 */
		const ifaceStart = files.types.indexOf("export interface ")
		expect(ifaceStart).toBeGreaterThan(-1)
		const ifaceBody = files.types.slice(ifaceStart)
		const count = ifaceBody.split("big_obj: { alpha").length - 1
		/* the inline literal should NOT appear in the interface body once hoisted */
		expect(count).toBe(0)
	})

	it("R5-3: anyrow sdk.types.gen.ts shrinks to <80% of Phase A baseline (228642 bytes)", () => {
		if (!ANYROW_TYPES_PATH || !existsSync(ANYROW_TYPES_PATH)) return
		const stat = statSync(ANYROW_TYPES_PATH)
		const currentBytes = stat.size
		const targetBytes = Math.floor(ANYROW_TYPES_BASELINE_BYTES * ANYROW_TYPES_TARGET_PCT)
		/*
		 * Baseline is the pre-fix Phase A size; cleaner must regenerate after the
		 * emitter fix and drop this file below 80% of baseline (~182913 bytes).
		 */
		expect(currentBytes).toBeLessThan(targetBytes)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   R5-4 — `#requestSafe` parse-error contract (emitter string only)
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-4 #requestSafe parse contract — try/catch around parseBody", () => {
	it("R5-4: emitted #requestSafe wraps this.#parseBody(response) in try/catch", () => {
		const { files } = generateSDK(dedupeResponseSpec, { name: "TestSDK" })
		/* locate the #requestSafe body */
		const startIdx = files.client.indexOf("async #requestSafe(")
		expect(startIdx).toBeGreaterThan(-1)
		/* the method body ends before the next top-level `async #` or `#` method */
		const bodySlice = files.client.slice(startIdx, startIdx + 2000)
		/*
		 * After the fix, the body must contain a `try` keyword followed (anywhere below)
		 * by `this.#parseBody(response)` followed by a `catch` branch that returns the
		 * safe-mode shape. Match a permissive try-block pattern.
		 */
		expect(bodySlice).toMatch(/try\s*\{[^}]*this\.#parseBody\(response\)/s)
		expect(bodySlice).toMatch(/catch\s*\(/)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   R5-5 — WS `headers?` dead / SSE `cookies?` missing
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-5 WS/SSE suffix asymmetry", () => {
	it("R5-5: WS method input types do NOT contain headers?: Record<string, string>", () => {
		const { files } = generateSDK(streamingSpec, { name: "TestSDK" })
		/* find the WS method line (returns TypedWebSocket) */
		const wsLine = files.types
			.split("\n")
			.find((l) => l.includes("connect(") && l.includes("TypedWebSocket"))
		expect(wsLine).toBeDefined()
		expect(wsLine).not.toContain("headers?: Record<string, string>")
	})

	it("R5-5: SSE method input types contain cookies?: Record<string, string>", () => {
		const { files } = generateSDK(streamingSpec, { name: "TestSDK" })
		/* find the SSE method line (returns AsyncIterable<...>) */
		const sseLine = files.types
			.split("\n")
			.find((l) => l.includes("stream(") && l.includes("AsyncIterable"))
		expect(sseLine).toBeDefined()
		expect(sseLine).toContain("cookies?: Record<string, string>")
	})

	it("R5-5: SSE method input types still contain headers?, lastEventId?, signal? (non-regression)", () => {
		const { files } = generateSDK(streamingSpec, { name: "TestSDK" })
		const sseLine = files.types
			.split("\n")
			.find((l) => l.includes("stream(") && l.includes("AsyncIterable"))
		expect(sseLine).toBeDefined()
		expect(sseLine).toContain("headers?: Record<string, string>")
		expect(sseLine).toContain("lastEventId?: string")
		expect(sseLine).toContain("signal?: AbortSignal")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   R5-6 — Emitter SSE return type wrong
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-6 SSE return type — optional event, retry?: number", () => {
	it("R5-6: SSE method return type declares event as optional (event?:)", () => {
		const { files } = generateSDK(streamingSpec, { name: "TestSDK" })
		const sseLine = files.types
			.split("\n")
			.find((l) => l.includes("stream(") && l.includes("AsyncIterable"))
		expect(sseLine).toBeDefined()
		/*
		 * Current buggy form emits `event: string` (required).
		 * Fixed form must emit `event?: string` (optional).
		 */
		expect(sseLine).toContain("event?:")
		expect(sseLine).not.toMatch(/\bevent:\s*string(?!\?)/)
	})

	it("R5-6: SSE method return type declares retry?: number", () => {
		const { files } = generateSDK(streamingSpec, { name: "TestSDK" })
		const sseLine = files.types
			.split("\n")
			.find((l) => l.includes("stream(") && l.includes("AsyncIterable"))
		expect(sseLine).toBeDefined()
		expect(sseLine).toMatch(/retry\?:\s*number/)
	})
})

