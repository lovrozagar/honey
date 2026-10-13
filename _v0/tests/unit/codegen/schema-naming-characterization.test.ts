/**
 * Group A: TRUE characterization tests — lock CURRENT structural invariants.
 * These MUST PASS against current code (before refactor).
 * They will continue passing after refactor.
 *
 * Minimal export change made to codegen.ts: `canonicalizeSchema` and `OpenApiSpec`
 * are now exported so tests can import them directly.
 */
import { describe, expect, it } from "vitest"
import { canonicalizeSchema, deduplicateSchemas } from "../../../src/codegen.ts"
import { getFixtureSpec } from "./__fixtures__/schema-naming-routes.ts"

/** Collect all $ref values recursively from a spec. */
function collectRefs(obj: unknown): string[] {
	const refs: string[] = []
	if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
		const rec = obj as Record<string, unknown>
		if (typeof rec.$ref === "string") refs.push(rec.$ref)
		for (const val of Object.values(rec)) refs.push(...collectRefs(val))
	} else if (Array.isArray(obj)) {
		for (const item of obj) refs.push(...collectRefs(item))
	}
	return refs
}

/** Extract inline schema for a given operation+role from raw (un-deduped) spec. */
function extractInlineSchema(
	spec: ReturnType<typeof getFixtureSpec>,
	path: string,
	method: string,
	role: "request" | "response",
	status?: number,
): Record<string, unknown> | undefined {
	const op = spec.paths[path]?.[method] as Record<string, unknown> | undefined
	if (!op) return undefined
	if (role === "request") {
		const rb = op.requestBody as Record<string, unknown> | undefined
		const content = rb?.content as Record<string, Record<string, unknown>> | undefined
		return content?.["application/json"]?.schema as Record<string, unknown> | undefined
	}
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	const key = String(status ?? 200)
	const resp = responses?.[key]
	const content = resp?.content as Record<string, Record<string, unknown>> | undefined
	return content?.["application/json"]?.schema as Record<string, unknown> | undefined
}

/** Recursively resolve all $refs in a node using the processed spec's components. */
function deepResolveRefs(node: unknown, components: Record<string, Record<string, unknown>>): unknown {
	if (node === null || typeof node !== "object") return node
	if (Array.isArray(node)) return node.map((n) => deepResolveRefs(n, components))
	const obj = node as Record<string, unknown>
	if (typeof obj.$ref === "string") {
		const refName = obj.$ref.replace("#/components/schemas/", "")
		return deepResolveRefs(components[refName], components)
	}
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) out[k] = deepResolveRefs(v, components)
	return out
}

/** Get schema from processed spec, deep-resolving all $refs before returning. */
function getProcessedSchema(
	processed: ReturnType<typeof deduplicateSchemas>,
	path: string,
	method: string,
	role: "request" | "response",
	status?: number,
): Record<string, unknown> | undefined {
	const op = processed.paths[path]?.[method] as Record<string, unknown> | undefined
	if (!op) return undefined
	let schema: Record<string, unknown> | undefined
	if (role === "request") {
		const rb = op.requestBody as Record<string, unknown> | undefined
		const content = rb?.content as Record<string, Record<string, unknown>> | undefined
		schema = content?.["application/json"]?.schema as Record<string, unknown> | undefined
	} else {
		const responses = op.responses as Record<string, Record<string, unknown>> | undefined
		const key = String(status ?? 200)
		const resp = responses?.[key]
		const content = resp?.content as Record<string, Record<string, unknown>> | undefined
		schema = content?.["application/json"]?.schema as Record<string, unknown> | undefined
	}
	if (!schema) return undefined
	const components = processed.components?.schemas ?? {}
	return deepResolveRefs(schema, components) as Record<string, unknown>
}

describe("Group A — characterization (must pass against current code)", () => {
	it("ref-integrity — every $ref resolves to a component", () => {
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const componentNames = Object.keys(processed.components?.schemas ?? {})
		const refs = collectRefs(processed.paths)
		const prefix = "#/components/schemas/"
		for (const ref of refs) {
			expect(ref.startsWith(prefix), `$ref malformed: ${ref}`).toBe(true)
			const name = ref.slice(prefix.length)
			expect(componentNames, `$ref "${ref}" points to missing component`).toContain(name)
		}
	})

	it("shape-preservation — resolved schema canonicalizes equal to original inline", () => {
		const original = getFixtureSpec()
		const processed = deduplicateSchemas(structuredClone(original))

		const cases: Array<[string, string, "request" | "response", number?]> = [
			["/v1/projects", "post", "request"],
			["/v1/projects", "post", "response", 201],
			["/v1/projects/{id}", "get", "response", 200],
			["/v1/projects/{id}", "patch", "request"],
			["/v1/projects/{id}/invites", "post", "request"],
			["/v1/users/{id}", "get", "response", 200],
			["/v1/auth/login", "post", "request"],
			["/v1/auth/login", "post", "response", 200],
			["/v1/feedback", "post", "request"],
		]

		for (const [path, method, role, status] of cases) {
			const originalSchema = extractInlineSchema(original, path, method, role, status)
			if (!originalSchema) continue
			const resolvedSchema = getProcessedSchema(processed, path, method, role, status)
			expect(
				resolvedSchema,
				`no resolved schema for ${method.toUpperCase()} ${path} ${role} ${status ?? ""}`,
			).toBeDefined()
			if (!resolvedSchema) throw new Error(`no resolved schema for ${method.toUpperCase()} ${path} ${role}`)
			expect(canonicalizeSchema(resolvedSchema), `canonical mismatch for ${method.toUpperCase()} ${path} ${role}`).toBe(
				canonicalizeSchema(originalSchema),
			)
		}
	})

	it("determinism — two runs on same input produce byte-identical output", () => {
		const specA = getFixtureSpec()
		const specB = getFixtureSpec()
		const resultA = deduplicateSchemas(specA)
		const resultB = deduplicateSchemas(specB)
		expect(JSON.stringify(resultA)).toBe(JSON.stringify(resultB))
	})

	it("dedup-identical-shape-same-op — identical shapes from same operation collapse to one component per schema", () => {
		/* In the fixture, POST /v1/webhooks/github and POST /v1/webhooks/stripe
		 * both have a {ok: boolean} 200 response — structurally identical.
		 * Current code: count=2 → ONE Schema_{hash} component.
		 * This test asserts the current behavior: one component covers both $refs. */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const schemas = processed.components?.schemas ?? {}

		/* find the {ok:boolean} schema component — current code emits it since count>=2 */
		const okSchema = { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }
		const canonical = canonicalizeSchema(okSchema)
		const matchingNames = Object.entries(schemas)
			.filter(([, s]) => canonicalizeSchema(s as Record<string, unknown>) === canonical)
			.map(([name]) => name)

		/* current code emits exactly ONE entry per distinct canonical shape */
		expect(matchingNames.length).toBe(1)

		/* both webhook 200 responses must ref the same component */
		const githubOp = processed.paths["/v1/webhooks/github"]?.post as Record<string, unknown>
		const stripeOp = processed.paths["/v1/webhooks/stripe"]?.post as Record<string, unknown>
		const githubResp = (githubOp?.responses as Record<string, unknown>)?.["200"]
		const stripeResp = (stripeOp?.responses as Record<string, unknown>)?.["200"]
		const githubSchema = (
			(githubResp as Record<string, unknown>)?.content as Record<string, Record<string, unknown>>
		)?.["application/json"]?.schema
		const stripeSchema = (
			(stripeResp as Record<string, unknown>)?.content as Record<string, Record<string, unknown>>
		)?.["application/json"]?.schema
		expect((githubSchema as Record<string, unknown>)?.$ref).toBeDefined()
		expect((stripeSchema as Record<string, unknown>)?.$ref).toBeDefined()
		expect((githubSchema as Record<string, unknown>).$ref).toBe((stripeSchema as Record<string, unknown>).$ref)
	})

	it("rerun-is-idempotent — processing an already-processed spec is a no-op", () => {
		const spec = getFixtureSpec()
		const first = deduplicateSchemas(spec)
		const second = deduplicateSchemas(first)
		expect(JSON.stringify(second)).toBe(JSON.stringify(first))
	})
})
