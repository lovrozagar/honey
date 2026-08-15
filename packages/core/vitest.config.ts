import { defineConfig } from "vitest/config"

/** Language SDK harnesses — cargo/go/python/mcp. Opt-in via `test:harness`. */
export const harness = [
	"tests/integration/sdk-harness/**",
	"tests/unit/codegen/go-cli/**",
	"tests/unit/codegen/go-sdk.test.ts",
	"tests/unit/codegen/python-sdk.test.ts",
	"tests/unit/codegen/rust-sdk.test.ts",
	"tests/unit/codegen/*-emitter-byte-equiv.test.ts",
]

/**
 * Snapshot / characterization files that are already red in this extract.
 * Kept on disk for later cleanup; not part of the default loop.
 */
export const stale = [
	"tests/integration/bug-hunt-15.test.ts",
	"tests/integration/bug-hunt-16.test.ts",
	"tests/unit/client/http-r6-phase-g.test.ts",
	"tests/unit/codegen/arktype-json-schema.test.ts",
	"tests/unit/codegen/auth-scheme.test.ts",
	"tests/unit/codegen/codegen.test.ts",
	"tests/unit/codegen/custom-error-openapi.test.ts",
	"tests/unit/codegen/effect.test.ts",
	"tests/unit/codegen/error-schema-openapi.test.ts",
	"tests/unit/codegen/invalidate-meta.test.ts",
	"tests/unit/codegen/sdk-r4-phase-a.test.ts",
	"tests/unit/codegen/sdk-r5-phase-d.test.ts",
	"tests/unit/codegen/sdk-r6-25-json-schema.test.ts",
	"tests/unit/codegen/sdk-r6-phase-h.test.ts",
	"tests/unit/codegen/sdk-r6-phase-i.test.ts",
	"tests/unit/codegen/type-emitter.test.ts",
	"tests/unit/codegen/type-extractor.test.ts",
	"tests/unit/codegen/type-generator.test.ts",
	"tests/unit/codegen/valibot-json-schema.test.ts",
	"tests/unit/codegen/yup.test.ts",
	"tests/unit/codegen/zod-mini.test.ts",
	"tests/unit/integration/integration.test.ts",
	"tests/unit/openapi/dedup-schemas.test.ts",
	"tests/unit/plugin/vite-plugin.test.ts",
	"tests/unit/sdk/sdk-demo2-real.test.ts",
	"tests/unit/sdk/sdk-r6-1-baseurl-query.test.ts",
	"tests/unit/sdk/sdk-r6-2-signal-cleanup.test.ts",
	"tests/unit/sdk/sdk-r6-3-stale-race.test.ts",
	"tests/unit/sdk/sdk-r6-4-action-cache.test.ts",
	"tests/unit/sdk/sdk-r6-5-regex-injection.test.ts",
	"tests/unit/sdk/sdk-r6-phase-g-runtime.test.ts",
	"tests/unit/sdk/sdk-r6-phase-i-runtime.test.ts",
	"tests/unit/sdk/sdk-runtime-characterization.test.ts",
	"tests/unit/sdk/sdk-ws-sse.test.ts",
]

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", ...harness, ...stale],
		include: ["tests/**/*.test.ts"],
		passWithNoTests: true,
	},
})
