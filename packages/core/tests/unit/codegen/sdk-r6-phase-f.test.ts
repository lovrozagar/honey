import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ── shared fixture ── */

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

/*
 * Full fixture: multiple actions per resource (for #R6-4 actionCache),
 * x-invalidate on two operations (for #R6-3 seq bookkeeping),
 * standard GET + PATCH paths (for #R6-1, #R6-2, generic structure).
 */
const phaseFixtureSpec = makeSpec({
	"/v1/users": {
		get: {
			operationId: "users.list",
			responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
		},
		post: {
			operationId: "users.create",
			responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
			"x-invalidate": ["GET /v1/users"],
		},
	},
	"/v1/users/{id}": {
		get: {
			operationId: "users.get",
			responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
		},
		patch: {
			operationId: "users.update",
			responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
			"x-invalidate": ["GET /v1/users/:id"],
		},
	},
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-4 — actionCache emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-4 actionCache — emitter Layer B' regression strings", () => {
	it("Layer B': files.client contains 'actionCache' (Record<string, Fn> declaration)", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("actionCache")
	})

	it("Layer B': files.client contains Object.defineProperty(fn, \"name\" (debug-name emission)", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain(`Object.defineProperty(fn, "name"`)
	})

	it("Layer B': return (input?: shape is gone — old inline arrow-per-access replaced by cached fn", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		/* The old shape emitted `return (input?: Record...` directly in the inner get trap.
		   After the fix, the action is cached via `actionCache[actionName] = fn; return fn`.
		   Zero occurrences of the old pattern is the regression guard. */
		const matches = files.client.match(/return \(input\?:/g)
		expect((matches ?? []).length).toBe(0)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-1 — baseURL query merge emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-1 baseURL query merge — emitter Layer B' regression strings", () => {
	it("Layer B': files.client contains 'baseUrl.searchParams' (the merge loop)", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("baseUrl.searchParams")
	})

	it("Layer B': files.client does NOT contain standalone 'new URL(relative, base)' line", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		/* The fix replaces `new URL(relative, base)` with a new URL built from basePath+relative.
		   The old bare construction that drops base query must be gone. */
		expect(files.client).not.toContain("new URL(relative, base)")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-2 — buildSignal cleanup emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-2 buildSignal cleanup — emitter Layer B' regression strings", () => {
	it("Layer B': files.client contains new #buildSignal return type with cleanup property", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("cleanup: () => void")
	})

	it("Layer B': files.client contains clearTimeout(timer) inside cleanup closure", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("clearTimeout(timer)")
	})

	it("Layer B': files.client contains try { ... } finally { ... cleanup() } pattern in #doRequest", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("} finally {")
		expect(files.client).toContain("cleanup()")
	})

	it("Layer B': files.client contains cleanup() inside #doSSE generator's finally block", () => {
		const sseSpec = makeSpec({
			"/v1/events": {
				get: {
					operationId: "events.stream",
					responses: { "200": { content: { "text/event-stream": { schema: { type: "string" } } } } },
				},
			},
		})
		const { files } = generateSDK(sseSpec, { name: "TestSDK" })
		expect(files.client).toContain("cleanup()")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-3 — monotonic invalidationSeq emitter strings
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-3 invalidationSeq — emitter Layer B' regression strings", () => {
	it("Layer B': files.client contains '#invalidationSeq = 0' class field", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("#invalidationSeq = 0")
	})

	it("Layer B': files.client contains 'seqSnapshot: this.#invalidationSeq' in #buildRequestMeta", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("seqSnapshot: this.#invalidationSeq")
	})

	it("Layer B': files.client contains 'seq: number' in the #staleUntil Map value type", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("seq: number")
	})

	it("Layer B': files.client contains seq guard in #clearStale: 'if (entry.seq > seqSnapshot) continue'", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("if (entry.seq > seqSnapshot) continue")
	})

	it("Layer B': files.client #request passes seqSnapshot into #clearStale call", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toMatch(/#clearStale\([^)]*seqSnapshot/)
	})

	it("Layer B': files.client #markStale bumps seq before writing: 'const seq = ++this.#invalidationSeq'", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("const seq = ++this.#invalidationSeq")
	})

	it("Layer B': files.client safe path gates #markStale on response status, not r.error === null", () => {
		const { files } = generateSDK(phaseFixtureSpec, { name: "TestSDK" })
		expect(files.client).toContain("r.status >= 200 && r.status < 300")
		expect(files.client).not.toContain("r.error === null")
	})
})
