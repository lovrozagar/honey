/* Regression tests for the TypeScript side of workstreams 9–11 that no existing test reproduces
 * against 3ab88ce: generated type sources that must parse (H40), schema-name hash collisions,
 * trailing slashes in spec paths, and the `ctx.retry()` failure path of `createClient`.
 * Only APIs that already existed at 3ab88ce are used, so the file runs unchanged there. */

import { transformWithOxc } from "vite"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createClient } from "../../../src/client/index.ts"
import {
	deduplicateSchemas,
	generateOpenApi,
	generateRouteTreeFromApp,
	generateTypes,
	resolveRefs,
} from "../../../src/codegen.ts"
import { defineErrors } from "../../../src/errors.ts"
import { honey } from "../../../src/index.ts"

const INFO = { title: "T", version: "1" }

/** Parses generated TypeScript; a broken literal or an unquoted key is a syntax error. */
async function parses(code: string, name: string): Promise<string | null> {
	try {
		await transformWithOxc(code, name, { lang: "ts" })
		return null
	} catch (err) {
		return String((err as Error).message ?? err)
	}
}

describe("H40: generated TypeScript is written as source, never by raw interpolation", () => {
	// regression: H40
	it("H40: enum literals with quotes, backslashes and newlines stay valid string literals", async () => {
		const app = honey<{}>()
		app
			.get("/kinds")
			.input({ search: z.object({ kind: z.enum(['a"b', "C:\\temp", "line\nbreak"]) }) })
			.handler((c) => c.res.text("ok", "ok"))
		const out = generateTypes(app, {})
		expect(await parses(out, "types.gen.ts")).toBeNull()
		expect(out).toContain(JSON.stringify("C:\\temp"))
		expect(out).toContain(JSON.stringify('a"b'))
	})

	// regression: H40
	it("H40: a hyphenated path param is a quoted key", async () => {
		const app = honey<{}>()
		app.get("/users/:user-id").handler((c) => c.res.text("ok", "ok"))
		const out = generateTypes(app, {})
		expect(await parses(out, "types.gen.ts")).toBeNull()
		expect(out).toMatch(/"user-id": string/)
	})

	// regression: H40
	it("H40: error keys with `-` and `.` are quoted keys", async () => {
		const errors = defineErrors({ "rate-limited": "too_many_requests", "user.not_found": "not_found" })
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/u")
			.errors("rate-limited", "user.not_found")
			.handler((c) => c.res.text("ok", "ok"))
		const out = generateTypes(app, {})
		expect(await parses(out, "types.gen.ts")).toBeNull()
	})

	// regression: H40
	it("H40: a meta key cannot inject a statement into routes.gen.ts", async () => {
		const key = 'k"]: 1 }; globalThis.injected = 1; const z = { ["x'
		const app = honey<{}>()
		app
			.get("/m")
			.meta({ [key]: true } as never)
			.handler((c) => c.res.text("ok", "ok"))
		const out = generateRouteTreeFromApp(app)
		expect(await parses(out, "routes.gen.ts")).toBeNull()
		expect(out).not.toMatch(/^\s*globalThis\.injected = 1/m)
		expect(out).toContain(JSON.stringify(key))
	})
})

describe("schema names", () => {
	// regression: L (codegen-hash.ts:2-8; codegen.ts:537,731-736)
	it("L (codegen-hash.ts:2-8): two shapes whose 24-bit name hashes collide keep their own schemas", () => {
		/* three shapes share one derived name, so the second and third get hash suffixes;
		 * djb2 of {"enum":["aR"]} and {"enum":["b1"]} collides in the first 24 bits */
		const content = {
			"application/json": { schema: { enum: ["first"] } },
			"application/xml": { schema: { enum: ["aR"] } },
			"text/plain": { schema: { enum: ["b1"] } },
		}
		const deduped = deduplicateSchemas({
			info: INFO,
			openapi: "3.1.0",
			paths: { "/x": { get: { responses: { "200": { content, description: "ok" } } } } } as never,
		})
		const resolved = resolveRefs(deduped)
		const got = (
			resolved.paths["/x"].get.responses as Record<string, { content: Record<string, { schema: unknown }> }>
		)["200"].content
		expect(got["application/json"].schema).toEqual({ enum: ["first"] })
		expect(got["application/xml"].schema).toEqual({ enum: ["aR"] })
		expect(got["text/plain"].schema).toEqual({ enum: ["b1"] })
	})
})

describe("spec paths", () => {
	// regression: L (trailing slash)
	it("L (trailing slash): with trailingSlash(enforce) spec paths keep the slash clients must send", async () => {
		const app = honey<{}>().trailingSlash("enforce")
		app.get("/users/:id").handler((c) => c.res.text("ok", "ok"))
		const doc = await generateOpenApi(app, { info: INFO })
		expect(Object.keys(doc.paths)).toEqual(["/users/{id}/"])
	})
})

describe("createClient", () => {
	// regression: M (client/http.ts:359-365)
	it("M (client/http.ts:359-365): an unguarded retry hook on a persistent 401 ends with the 401", async () => {
		const fetch = vi.fn(async () => Response.json({ message: "nope" }, { status: 401 }))
		const api = createClient({
			baseURL: "https://x",
			fetch,
			onResponse: [(ctx) => (ctx.response.status === 401 ? ctx.retry() : undefined)],
			throwOnError: true,
		})
		const err = await (api.get as unknown as (p: string) => Promise<unknown>)("/x").then(
			() => null,
			(e: unknown) => e as { message?: string; status?: number },
		)
		expect(err?.message).not.toMatch(/Max 1 retry/)
		expect(err?.status).toBe(401)
		expect(fetch).toHaveBeenCalledTimes(2)
	})
})
