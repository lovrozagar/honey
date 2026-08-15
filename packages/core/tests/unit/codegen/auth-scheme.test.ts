import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { generateGoSDK } from "../../../src/codegen-go.ts"

/* ── helpers ── */

/**
 * Builds a minimal OpenAPI spec with a single security scheme under the
 * `sec` key. Pass null to omit `components` entirely.
 */
function specWith(scheme: unknown): Record<string, unknown> {
	const base: Record<string, unknown> = {
		openapi: "3.1.0",
		info: { title: "Auth Test", version: "1.0.0" },
		paths: {},
	}
	if (scheme !== null) {
		base.components = { securitySchemes: { sec: scheme } }
	}
	return base
}

/**
 * Builds a spec with multiple named security schemes. Used to assert
 * first-key-alphabetical selection.
 */
function specWithSchemes(schemes: Record<string, unknown>): Record<string, unknown> {
	return {
		openapi: "3.1.0",
		info: { title: "Auth Test", version: "1.0.0" },
		paths: {},
		components: { securitySchemes: schemes },
	}
}

/** Reads the static runtime.go template directly from disk. */
function readRuntimeGo(): string {
	const filePath = fileURLToPath(new URL("../../../src/client-go/runtime.go", import.meta.url))
	return readFileSync(filePath, "utf8")
}

/* ── Tier AS1: detection via emitted client source ── */

describe("Tier AS1: auth scheme detection → emitted client.go", () => {
	it("[#1] http + bearer → emits AuthHeaderName=Authorization and AuthHeaderPrefix=Bearer ", () => {
		const spec = specWith({ type: "http", scheme: "bearer" })
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toBeDefined()
		expect(client).toContain(`AuthHeaderName = "Authorization"`)
		expect(client).toContain(`AuthHeaderPrefix = "Bearer "`)
	})

	it("[#2] http + basic → emits Basic prefix", () => {
		const spec = specWith({ type: "http", scheme: "basic" })
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toContain(`AuthHeaderName = "Authorization"`)
		expect(client).toContain(`AuthHeaderPrefix = "Basic "`)
	})

	it("[#3] apiKey header X-API-Key with no prefix hint → custom header name and empty prefix", () => {
		const spec = specWith({ type: "apiKey", in: "header", name: "X-API-Key" })
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toContain(`AuthHeaderName = "X-API-Key"`)
		expect(client).toContain(`AuthHeaderPrefix = ""`)
	})

	it("[#4] apiKey with Format: ApiKey {your_key} description → extracts ApiKey prefix", () => {
		const spec = specWith({
			type: "apiKey",
			in: "header",
			name: "Authorization",
			description: "API key authentication. Format: ApiKey {your_api_key}",
		})
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toContain(`AuthHeaderName = "Authorization"`)
		expect(client).toContain(`AuthHeaderPrefix = "ApiKey "`)
	})

	it("[#5] apiKey with Format: Token {k} description → extracts Token prefix", () => {
		const spec = specWith({
			type: "apiKey",
			in: "header",
			name: "Authorization",
			description: "Format: Token {k}",
		})
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toContain(`AuthHeaderName = "Authorization"`)
		expect(client).toContain(`AuthHeaderPrefix = "Token "`)
	})

	it("[#6] no securitySchemes → defaults to Authorization / Bearer ", () => {
		const spec = specWith(null)
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toContain(`AuthHeaderName = "Authorization"`)
		expect(client).toContain(`AuthHeaderPrefix = "Bearer "`)
	})

	it("[#7] apiKey in: query → falls back to default Bearer (out of scope v1)", () => {
		const spec = specWith({ type: "apiKey", in: "query", name: "api_key" })
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toContain(`AuthHeaderName = "Authorization"`)
		expect(client).toContain(`AuthHeaderPrefix = "Bearer "`)
	})

	it("[#8] multiple schemes → picks first alphabetically by key", () => {
		/* `alpha` sorts before `zeta`, so alpha (basic) must win over zeta (bearer) */
		const spec = specWithSchemes({
			zeta: { type: "http", scheme: "bearer" },
			alpha: { type: "http", scheme: "basic" },
		})
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		expect(client).toContain(`AuthHeaderPrefix = "Basic "`)
		expect(client).not.toContain(`AuthHeaderPrefix = "Bearer "`)
	})
})

/* ── Tier AS2: runtime.go honors the new Config fields ── */

describe("Tier AS2: runtime.go Config + buildHeaders honor auth fields", () => {
	it("[#9] Config struct has AuthHeaderName and AuthHeaderPrefix string fields", () => {
		const src = readRuntimeGo()
		expect(src).toMatch(/AuthHeaderName\s+string/)
		expect(src).toMatch(/AuthHeaderPrefix\s+string/)
	})

	it("[#10] mergeHeaders uses cfg.AuthHeaderName with fallback to \"Authorization\"", () => {
		const src = readRuntimeGo()
		const start = src.indexOf("func mergeHeaders(")
		expect(start, "mergeHeaders func missing").toBeGreaterThan(-1)
		const body = src.slice(start)
		expect(body).toContain("cfg.AuthHeaderName")
		expect(body).toContain(`"Authorization"`)
	})

	it("[#11] mergeHeaders uses cfg.AuthHeaderPrefix with fallback to \"Bearer \"", () => {
		const src = readRuntimeGo()
		const start = src.indexOf("func mergeHeaders(")
		expect(start).toBeGreaterThan(-1)
		const body = src.slice(start)
		expect(body).toContain("cfg.AuthHeaderPrefix")
		expect(body).toContain(`"Bearer "`)
	})

	it("[#12] mergeHeaders assembles header as prefix + bearerToken", () => {
		const src = readRuntimeGo()
		const start = src.indexOf("func mergeHeaders(")
		const body = src.slice(start)
		const usesPrefixVar = /prefix\s*\+\s*bearerToken/.test(body)
		expect(usesPrefixVar, "mergeHeaders must concat a prefix variable with the token").toBe(true)
		expect(body).not.toMatch(/"Bearer "\s*\+\s*bearerToken/)
	})
})

/* ── Tier AS3: backwards compat ── */

describe("Tier AS3: backwards compat", () => {
	it("[#13] NewClient signature preserved AND auth init emitted inside its body", () => {
		const spec = specWith({ type: "http", scheme: "bearer" })
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		/* signature unchanged (backwards compat) */
		expect(client).toContain(`func NewClient(cfg Config) *Client`)
		/* new behavior: NewClient body must set auth header defaults before
		 * constructing *Client. Slice from signature to the first `return c`
		 * so we're asserting the init happens inside NewClient, not elsewhere. */
		const sigIdx = client.indexOf(`func NewClient(cfg Config) *Client`)
		expect(sigIdx).toBeGreaterThan(-1)
		const afterSig = client.slice(sigIdx)
		const retIdx = afterSig.indexOf("return c")
		expect(retIdx).toBeGreaterThan(-1)
		const newClientBody = afterSig.slice(0, retIdx)
		expect(newClientBody).toContain(`AuthHeaderName`)
		expect(newClientBody).toContain(`AuthHeaderPrefix`)
	})

	it("[#14] default Bearer path still emits AuthHeaderPrefix: \"Bearer \" for http/bearer specs", () => {
		const spec = specWith({ type: "http", scheme: "bearer" })
		const { files } = generateGoSDK(spec)
		const client = files["client.go"]
		/* end-to-end: emitted init + runtime fallback together must produce
		 * `Authorization: Bearer <token>` for existing bearer-style APIs. */
		expect(client).toContain(`AuthHeaderName = "Authorization"`)
		expect(client).toContain(`AuthHeaderPrefix = "Bearer "`)
	})
})
