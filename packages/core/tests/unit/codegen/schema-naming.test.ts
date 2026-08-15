/**
 * Group B: NEW behavior assertions — expected RED against current code.
 * These tests document TARGET behavior after the refactor.
 * All 8 MUST FAIL against current code (which emits Schema_{8hex}, deduplicates by
 * canonical across routes, and only hoists schemas used 2+ times globally).
 */
import { describe, expect, it } from "vitest"
import { canonicalizeSchema, deduplicateSchemas } from "../../../src/codegen.ts"
import { EXPECTED_COMPONENT_COUNT_AFTER_REFACTOR, getFixtureSpec } from "./__fixtures__/schema-naming-routes.ts"

/** Collect all $ref values recursively. */
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

const DERIVED_NAME_RE = /^(Err\d{3}[A-Za-z0-9]*|([A-Z][a-z0-9]*)+(Request|Response\d{3}))(_[0-9a-f]{6})?$/
const HOISTED_NAME_RE = /^([A-Z][a-z0-9]*)+$/
const HASH_SUFFIX_RE = /_[0-9a-f]{6}$/

describe("Group B — new behavior (expected RED against current code)", () => {
	it("collision-distinct-shapes — two distinct shapes with same derived base get disambiguated", () => {
		/* POST /v1/webhooks/github and POST /v1/webhooks/stripe both derive
		 * "CreateWebhookRequest" as base name (same path segment, same verb).
		 * Their request body schemas differ (payload.repo vs payload.customer).
		 * After refactor: both present in components, both starting with "CreateWebhookRequest",
		 * one ending with _<6hex> hash suffix. Current code: neither hoisted (count=1 each). */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})

		const collisionNames = names.filter((n) => n.startsWith("CreateWebhookRequest"))
		expect(collisionNames.length, "expected 2 CreateWebhookRequest entries").toBe(2)

		const hashSuffixed = collisionNames.filter((n) => HASH_SUFFIX_RE.test(n))
		expect(hashSuffixed.length, "expected exactly one hash-suffixed entry").toBe(1)
	})

	it("shared-shape-dedupes-to-one-component — identical shapes from distinct operations share one component", () => {
		/* POST /v1/duplicate-shape-a and POST /v1/duplicate-shape-b both have body {x: number}.
		 * Amendment 2: same canonical → ONE component (Tier 3, first-walk-order name wins).
		 * Both routes $ref the same entry. */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})
		const schemas = processed.components?.schemas ?? {}

		/* exactly ONE component with this canonical shape */
		const xNumberCanonical = canonicalizeSchema({
			properties: { x: { type: "number" } },
			required: ["x"],
			type: "object",
		})
		const matchingNames = Object.entries(schemas)
			.filter(([, s]) => canonicalizeSchema(s as Record<string, unknown>) === xNumberCanonical)
			.map(([n]) => n)
		expect(matchingNames.length, "expected exactly one component for {x: number} shape").toBe(1)

		/* both routes must $ref the same single component */
		const sharedName = matchingNames[0]
		expect(names).toContain(sharedName)

		const opA = processed.paths["/v1/duplicate-shape-a"]?.post as Record<string, unknown>
		const opB = processed.paths["/v1/duplicate-shape-b"]?.post as Record<string, unknown>
		const rbA = (opA?.requestBody as Record<string, unknown>)?.content as Record<string, Record<string, unknown>>
		const rbB = (opB?.requestBody as Record<string, unknown>)?.content as Record<string, Record<string, unknown>>
		const refA = rbA?.["application/json"]?.schema as Record<string, unknown>
		const refB = rbB?.["application/json"]?.schema as Record<string, unknown>
		expect(refA?.$ref).toBe(`#/components/schemas/${sharedName}`)
		expect(refB?.$ref).toBe(`#/components/schemas/${sharedName}`)
	})

	it("nested-hoisting — inline object used in 2+ top-level schemas hoists to {Parent}{Field}", () => {
		/* GET /v1/projects/{id} and GET /v1/users/{id} both have settings: {theme, locale}.
		 * After refactor: "Settings" (or {Parent}Settings) component exists and both
		 * routes' settings field is a $ref.
		 * Current code: settings stays inline (never hoisted since it's a nested field). */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})

		/* some component name containing "Settings" must exist */
		const settingsComponents = names.filter((n) => n.includes("Settings"))
		expect(settingsComponents.length, "expected a hoisted Settings component").toBeGreaterThan(0)

		/* at least one component schema must reference the hoisted Settings via $ref
		 * (settings is nested inside top-level components, not directly in paths) */
		const refs = collectRefs(processed.components?.schemas ?? {})
		const settingsRef = refs.find((r) => r.includes("Settings"))
		expect(settingsRef, "expected a $ref pointing to hoisted Settings").toBeDefined()
	})

	it("derived-name-format — every top-level component name matches {Verb}{Resource}(Request|Response|Error{N})", () => {
		/* Current code emits Schema_{8hex} names. After refactor: human-readable names.
		 * This is the primary RED — regex fails on all current Schema_{hex} names. */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})

		expect(names.length, "expected components to be non-empty after refactor").toBeGreaterThan(0)

		for (const name of names) {
			/* hoisted nested schemas and hash-suffixed collision entries are excluded from this regex */
			if (HASH_SUFFIX_RE.test(name)) continue
			if (!name.endsWith("Request") && !/Response\d{3}$/.test(name)) continue
			expect(name, `name "${name}" does not match derived name format`).toMatch(DERIVED_NAME_RE)
		}

		/* current code emits Schema_{8hex} — assert NONE of those exist */
		const hashNames = names.filter((n) => /^Schema_[0-9a-f]{8}$/.test(n))
		expect(hashNames.length, `unexpected Schema_{8hex} names: ${hashNames.join(", ")}`).toBe(0)
	})

	it("hoisted-nested-name-format — hoisted nested schemas match PascalCase without role suffix", () => {
		/* After refactor: Settings (or GetProjectResponseSettings) exists and has no
		 * Request/Response/Error suffix. Current code never hoists nested objects. */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})

		const hoisted = names.filter((n) => !n.endsWith("Request") && !/Response\d{3}$/.test(n) && !HASH_SUFFIX_RE.test(n))
		expect(hoisted.length, "expected at least one hoisted nested schema").toBeGreaterThan(0)

		for (const name of hoisted) {
			expect(name, `hoisted name "${name}" does not match PascalCase format`).toMatch(HOISTED_NAME_RE)
		}
	})

	it("collision-hash-format — disambiguated names use _[0-9a-f]{6} suffix not ordinal", () => {
		/* After refactor: collision tie-breaker uses 6-char hex hash, not _2/_3.
		 * Current code never disambiguates (no derived names, no collision tracking). */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})

		const collisionEntries = names.filter((n) => n.startsWith("CreateWebhookRequest"))
		expect(collisionEntries.length, "expected CreateWebhookRequest collision entries").toBe(2)

		const suffixed = collisionEntries.filter((n) => HASH_SUFFIX_RE.test(n))
		expect(suffixed.length, "expected exactly one 6-char hex suffixed entry").toBe(1)
		expect(suffixed[0], "hash suffix must be exactly 6 hex chars").toMatch(/_[0-9a-f]{6}$/)

		/* ordinal suffixes (_2, _3) must NOT appear */
		const ordinal = names.filter((n) => /_\d+$/.test(n))
		expect(ordinal.length, `unexpected ordinal suffixes: ${ordinal.join(", ")}`).toBe(0)
	})

	it("type-count-parity — component count matches expected value for fixture", () => {
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const count = Object.keys(processed.components?.schemas ?? {}).length
		expect(count).toBe(EXPECTED_COMPONENT_COUNT_AFTER_REFACTOR)
	})

	it("idempotent-rerun — processing an already-processed spec is a no-op", () => {
		/* After refactor: derived names are stable. Re-running on an already-processed
		 * spec must produce byte-identical output (no double-suffixing, no new components).
		 * Current code: NOT idempotent — each pass adds more Schema_{hex} entries. */
		const spec = getFixtureSpec()
		const once = deduplicateSchemas(spec)
		const twice = deduplicateSchemas(structuredClone(once))
		expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
	})

	it("shared-error-envelope-naming — Tier 2 emits Err{status}* names", () => {
		/* ERROR_400_SCHEMA shared across 3 routes → Err400InvalidInput (1 key).
		 * ERROR_500_SCHEMA with 4 keys → Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable.
		 * ERROR_404_SCHEMA single-use (only /v1/teams) → Tier 1 operation-derived name. */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})

		expect(names, "Err400InvalidInput missing").toContain("Err400InvalidInput")
		expect(names, "Err500*... missing").toContain("Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable")

		/* refs in paths must point to these names */
		const refs = collectRefs(processed.paths)
		expect(refs).toContain("#/components/schemas/Err400InvalidInput")
		expect(refs).toContain("#/components/schemas/Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable")
	})

	it("shared-error-envelope-dedup — same error envelope across routes shares one component", () => {
		/* ERROR_400_SCHEMA appears on /v1/projects, /v1/feedback, /v1/teams.
		 * Exactly one envelope component emitted (Err400InvalidInput).
		 * All three routes $ref it. */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})

		expect(names, "Err400InvalidInput missing").toContain("Err400InvalidInput")

		/* all three routes must ref the same component */
		const refs = collectRefs(processed.paths)
		const err400Refs = refs.filter((r) => r.includes("Err400InvalidInput"))
		expect(err400Refs.length, "expected 3 refs to Err400InvalidInput (one per route)").toBe(3)
	})

	it("shared-error-envelope-4plus-keys — envelope with 4+ error_keys concats all sorted", () => {
		/* ERROR_500_SCHEMA has 4 error_keys → all sorted + PascalCase'd, no truncation */
		const spec = getFixtureSpec()
		const processed = deduplicateSchemas(spec)
		const names = Object.keys(processed.components?.schemas ?? {})
		expect(names).toContain("Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable")
	})

	it("path-sort-determinism — reversed path order produces identical output", () => {
		const spec = getFixtureSpec()
		const reversedSpec = {
			...spec,
			paths: Object.fromEntries(Object.entries(spec.paths).reverse()),
		}
		const forward = deduplicateSchemas(spec)
		const reversed = deduplicateSchemas(reversedSpec)
		expect(JSON.stringify(forward.components?.schemas)).toBe(JSON.stringify(reversed.components?.schemas))
	})
})
