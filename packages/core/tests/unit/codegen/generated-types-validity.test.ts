import { type } from "arktype"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateTypes } from "../../../src/codegen.ts"
import { defineErrors, honey } from "../../../src/index.ts"

/**
 * Verify that generateTypes() emits concrete TypeScript types (not "unknown")
 * for valibot, arktype, and mixed-vendor schemas. Each test asserts:
 *  - expected type literals appear in input/output positions
 *  - "unknown" never leaks into schema-derived positions
 *  - bracket/brace balance is correct (syntactically valid TS)
 */

function assertNoSchemaUnknowns(types: string): void {
	const lines = types.split("\n")
	for (const line of lines) {
		/* skip lines that aren't schema type positions */
		if (!line.includes("input:") && !line.includes("output:") && !line.includes("ctx:")) continue
		/* skip lines that are just `input: {}` or `output: {}` (no schema) */
		if (line.trim() === "input: {}" || line.trim() === "output: {}") continue

		/* "unknown" should not appear in schema-derived type positions */
		const trimmed = line.trim()
		if (
			trimmed.startsWith("input:") ||
			trimmed.startsWith("output:") ||
			trimmed.startsWith("ctx:")
		) {
			expect(trimmed).not.toContain("unknown")
		}
	}
}

function assertBalancedBrackets(types: string): void {
	let braces = 0
	let angles = 0
	let parens = 0
	let brackets = 0

	for (const ch of types) {
		if (ch === "{") braces++
		else if (ch === "}") braces--
		else if (ch === "<") angles++
		else if (ch === ">") angles--
		else if (ch === "(") parens++
		else if (ch === ")") parens--
		else if (ch === "[") brackets++
		else if (ch === "]") brackets--
	}

	expect(braces).toBe(0)
	expect(angles).toBe(0)
	expect(parens).toBe(0)
	expect(brackets).toBe(0)
}

function assertValidStructure(types: string): void {
	expect(types).toContain("export type Routes = {")
	expect(types).toContain("import type {")
	expect(types).toContain('from "honey"')
	assertBalancedBrackets(types)
}

describe("generated types validity - valibot", () => {
	it("simple object input + output compiles to concrete types", () => {
		const app = honey()
			.get("/users")
			.input({ search: v.object({ limit: v.number(), q: v.string() }) })
			.output({
				"application/json": {
					ok: v.object({ id: v.string(), name: v.string() }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { id: "1", name: ctx.input.search.q }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("q: string")
		expect(types).toContain("limit: number")
		expect(types).toContain("id: string")
		expect(types).toContain("name: string")
	})

	it("nested objects, arrays, optionals emit concrete types", () => {
		const app = honey()
			.post("/items")
			.input({
				json: v.object({
					address: v.optional(v.object({ city: v.string(), zip: v.string() })),
					tags: v.array(v.string()),
				}),
			})
			.output({
				"application/json": {
					created: v.object({
						items: v.array(v.object({ id: v.string(), score: v.number() })),
					}),
				},
			})
			.handler((ctx) => ctx.res.json("created", { items: [] }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("tags: string[]")
		expect(types).toContain("city: string")
		expect(types).toContain("zip: string")
		expect(types).toContain("| undefined")
		expect(types).toContain("id: string")
		expect(types).toContain("score: number")
	})

	it("unions and literals produce concrete types", () => {
		const app = honey()
			.post("/events")
			.input({
				json: v.object({
					priority: v.union([v.literal("low"), v.literal("high")]),
					status: v.picklist(["draft", "published"]),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain('"low"')
		expect(types).toContain('"high"')
		expect(types).toContain('"draft"')
		expect(types).toContain('"published"')
	})

	it("nullable and nullish emit correct union types", () => {
		const app = honey()
			.post("/profile")
			.input({
				json: v.object({
					avatar: v.nullable(v.string()),
					bio: v.nullish(v.string()),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("avatar: string | null")
		expect(types).toContain("bio?: string | null | undefined")
	})

	it("multiple routes all emit concrete types", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/users")
			.input({ search: v.object({ page: v.number() }) })
			.output({
				"application/json": {
					ok: v.object({ items: v.array(v.string()) }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { items: [] }))
			.post("/users")
			.input({ json: v.object({ email: v.string(), name: v.string() }) })
			.handler((ctx) => ctx.res.json("created", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain('"/health"')
		expect(types).toContain('"/users"')
		expect(types).toContain("page: number")
		expect(types).toContain("email: string")
	})
})

describe("generated types validity - arktype", () => {
	it("simple object input + output compiles to concrete types", () => {
		const app = honey()
			.get("/items")
			.input({ search: type({ limit: "number", q: "string" }) })
			.output({
				"application/json": {
					ok: type({ id: "string", name: "string" }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { id: "1", name: ctx.input.search.q }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("q: string")
		expect(types).toContain("limit: number")
		expect(types).toContain("id: string")
		expect(types).toContain("name: string")
	})

	it("optional fields and arrays emit concrete types", () => {
		const app = honey()
			.post("/records")
			.input({
				json: type({
					"email?": "string",
					name: "string",
					tags: "string[]",
				}),
			})
			.output({
				"application/json": {
					created: type({ id: "string", items: "string[]" }),
				},
			})
			.handler((ctx) => ctx.res.json("created", { id: "1", items: [] }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("name: string")
		expect(types).toContain("tags: string[]")
		expect(types).toContain("email?: string")
		expect(types).toContain("id: string")
		expect(types).toContain("items: string[]")
	})

	it("union types emit concrete types", () => {
		const app = honey()
			.post("/dispatch")
			.input({
				json: type({
					payload: "string | number",
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("string")
		expect(types).toContain("number")
	})

	it("literal unions produce concrete types", () => {
		const app = honey()
			.post("/roles")
			.input({
				json: type({
					role: '"admin" | "user"',
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain('"admin"')
		expect(types).toContain('"user"')
	})

	it("nested objects emit concrete types", () => {
		const app = honey()
			.post("/nested")
			.input({
				json: type({
					meta: {
						createdAt: "string",
						updatedAt: "string",
					},
					name: "string",
				}),
			})
			.output({
				"application/json": {
					ok: type({
						result: {
							id: "string",
							score: "number",
						},
					}),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { result: { id: "1", score: 42 } }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("createdAt: string")
		expect(types).toContain("updatedAt: string")
		expect(types).toContain("id: string")
		expect(types).toContain("score: number")
	})
})

describe("generated types validity - mixed vendors", () => {
	it("zod input + valibot output produce concrete types", () => {
		const app = honey()
			.post("/mixed-zv")
			.input({ json: z.object({ name: z.string() }) })
			.output({
				"application/json": {
					ok: v.object({ created: v.boolean(), id: v.string() }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { created: true, id: "1" }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("name: string")
		expect(types).toContain("id: string")
		expect(types).toContain("created: boolean")
	})

	it("zod input + arktype output produce concrete types", () => {
		const app = honey()
			.post("/mixed-za")
			.input({ json: z.object({ email: z.string(), name: z.string() }) })
			.output({
				"application/json": {
					ok: type({ id: "string", success: "boolean" }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { id: "1", success: true }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("email: string")
		expect(types).toContain("name: string")
		expect(types).toContain("id: string")
		expect(types).toContain("boolean")
	})

	it("valibot input + arktype output produce concrete types", () => {
		const app = honey()
			.post("/mixed-va")
			.input({ json: v.object({ count: v.number(), name: v.string() }) })
			.output({
				"application/json": {
					created: type({ id: "string", ts: "number" }),
				},
			})
			.handler((ctx) => ctx.res.json("created", { id: "1", ts: 123 }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("count: number")
		expect(types).toContain("name: string")
		expect(types).toContain("id: string")
		expect(types).toContain("ts: number")
	})

	it("multiple routes with different vendors in same app", () => {
		const app = honey()
			.get("/zod-route")
			.input({ search: z.object({ page: z.number() }) })
			.handler((ctx) => ctx.res.json("ok", {}))
			.post("/valibot-route")
			.input({ json: v.object({ title: v.string() }) })
			.handler((ctx) => ctx.res.json("created", {}))
			.put("/arktype-route")
			.input({ json: type({ data: "string" }) })
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain('"/zod-route"')
		expect(types).toContain('"/valibot-route"')
		expect(types).toContain('"/arktype-route"')
		expect(types).toContain("page: number")
		expect(types).toContain("title: string")
		expect(types).toContain("data: string")
	})
})

describe("generated types validity - complex schemas", () => {
	it("deeply nested objects across all vendors", () => {
		const zodSchema = z.object({
			level1: z.object({
				level2: z.object({
					value: z.string(),
				}),
			}),
		})
		const valibotSchema = v.object({
			level1: v.object({
				level2: v.object({
					value: v.number(),
				}),
			}),
		})
		const arktypeSchema = type({
			level1: {
				level2: {
					value: "boolean",
				},
			},
		})

		const app = honey()
			.post("/deep-zod")
			.input({ json: zodSchema })
			.handler((ctx) => ctx.res.json("ok", {}))
			.post("/deep-valibot")
			.input({ json: valibotSchema })
			.handler((ctx) => ctx.res.json("ok", {}))
			.post("/deep-arktype")
			.input({ json: arktypeSchema })
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		/* each nested path emits real types */
		expect(types).toContain("level1: { level2: { value: string } }")
		expect(types).toContain("level1: { level2: { value: number } }")
		expect(types).toContain("level1: { level2: { value: boolean } }")
	})

	it("arrays of objects with multiple fields", () => {
		const app = honey()
			.get("/list")
			.output({
				"application/json": {
					ok: v.object({
						items: v.array(
							v.object({
								active: v.boolean(),
								id: v.string(),
								score: v.number(),
							}),
						),
						total: v.number(),
					}),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { items: [], total: 0 }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("active: boolean")
		expect(types).toContain("id: string")
		expect(types).toContain("score: number")
		expect(types).toContain("total: number")
		expect(types).toContain("[]")
	})

	it("optional + nullable + union combinations", () => {
		const app = honey()
			.post("/combo")
			.input({
				json: v.object({
					age: v.optional(v.number()),
					name: v.string(),
					nickname: v.nullable(v.string()),
					role: v.union([v.literal("admin"), v.literal("user"), v.literal("guest")]),
				}),
			})
			.output({
				"application/json": {
					ok: z.object({
						items: z.string().array(),
						status: z.union([z.literal("ok"), z.literal("error")]),
					}),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { items: [], status: "ok" }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("name: string")
		expect(types).toContain("age?: number | undefined")
		expect(types).toContain("nickname: string | null")
		expect(types).toContain('"admin"')
		expect(types).toContain('"user"')
		expect(types).toContain('"guest"')
		expect(types).toContain("string[]")
		expect(types).toContain('"ok"')
		expect(types).toContain('"error"')
	})

	it("valibot tuples emit concrete tuple types", () => {
		const app = honey()
			.post("/tuple")
			.input({
				json: v.object({
					coords: v.tuple([v.number(), v.number()]),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("[number, number]")
	})

	it("valibot record emits Record type", () => {
		const app = honey()
			.post("/record")
			.input({
				json: v.object({
					metadata: v.record(v.string(), v.number()),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("Record<string, number>")
	})

	it("zod record and tuple emit concrete types", () => {
		const app = honey()
			.post("/zod-advanced")
			.input({
				json: z.object({
					lookup: z.record(z.string(), z.boolean()),
					pair: z.tuple([z.string(), z.number()]),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("Record<string, boolean>")
		expect(types).toContain("[string, number]")
	})

	it("params from path combined with vendor schemas", () => {
		const app = honey()
			.put("/users/:userId/posts/:postId")
			.input({
				json: v.object({ body: v.string(), title: v.string() }),
			})
			.output({
				"application/json": {
					ok: type({ id: "string", updated: "boolean" }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.userId, updated: true }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("readonly params: { userId: string; postId: string }")
		expect(types).toContain("body: string")
		expect(types).toContain("title: string")
		expect(types).toContain("id: string")
	})

	it("multiple output status keys with different schemas", () => {
		const app = honey()
			.post("/multi-status")
			.output({
				"application/json": {
					created: v.object({ id: v.string() }),
					ok: v.object({ message: v.string() }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { message: "done" }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		assertNoSchemaUnknowns(types)
		expect(types).toContain("ok: { message: string }")
		expect(types).toContain("created: { id: string }")
	})
})

describe("generated types validity - optional properties across vendors", () => {
	it("zod: optional properties emit ? markers in generated types", () => {
		const app = honey()
			.post("/zod-optionals")
			.input({
				json: z.object({
					avatar: z.string().nullable(),
					bio: z.string().nullable().optional(),
					email: z.string(),
					nickname: z.string().optional(),
				}),
			})
			.output({ "application/json": { created: z.object({}) } })
			.handler((ctx) => ctx.res.json("created", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		expect(types).toContain("email: string")
		expect(types).toContain("nickname?: string | undefined")
		expect(types).toContain("avatar: string | null")
		expect(types).toContain("bio?: string | null | undefined")
		/* email must NOT be optional */
		expect(types).not.toContain("email?")
		/* avatar (nullable only) must NOT be optional */
		expect(types).not.toContain("avatar?")
	})

	it("valibot: optional and nullish properties emit ? markers", () => {
		const app = honey()
			.post("/valibot-optionals")
			.input({
				json: v.object({
					avatar: v.nullable(v.string()),
					bio: v.nullish(v.string()),
					email: v.string(),
					nickname: v.optional(v.string()),
				}),
			})
			.output({ "application/json": { created: v.object({}) } })
			.handler((ctx) => ctx.res.json("created", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		expect(types).toContain("email: string")
		expect(types).toContain("nickname?: string | undefined")
		expect(types).toContain("avatar: string | null")
		expect(types).toContain("bio?: string | null | undefined")
		expect(types).not.toContain("email?")
		expect(types).not.toContain("avatar?")
	})

	it("arktype: optional properties emit ? markers", () => {
		const app = honey()
			.post("/arktype-optionals")
			.input({
				json: type({
					"age?": "number",
					email: "string",
					name: "string",
				}),
			})
			.output({ "application/json": { created: type({}) } })
			.handler((ctx) => ctx.res.json("created", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		expect(types).toContain("email: string")
		expect(types).toContain("name: string")
		expect(types).toContain("age?: number")
		expect(types).not.toContain("email?")
		expect(types).not.toContain("name?")
	})

	it("mixed vendors with optionals in same app produce correct ? markers", () => {
		const app = honey()
			.post("/zod-register")
			.input({
				json: z.object({
					email: z.string(),
					first_name: z.string().nullable().optional(),
					last_name: z.string().nullable().optional(),
					password: z.string(),
				}),
			})
			.output({ "application/json": { created: z.object({}) } })
			.handler((ctx) => ctx.res.json("created", {}))
			.post("/valibot-profile")
			.input({
				json: v.object({
					avatar: v.optional(v.nullable(v.string())),
					bio: v.nullish(v.string()),
					display_name: v.string(),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))
			.put("/arktype-settings")
			.input({
				json: type({
					"notifications?": "boolean",
					theme: '"light" | "dark"',
				}),
			})
			.handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		assertValidStructure(types)
		/* zod route */
		expect(types).toContain("email: string")
		expect(types).toContain("password: string")
		expect(types).toContain("first_name?: string | null | undefined")
		expect(types).toContain("last_name?: string | null | undefined")
		/* valibot route */
		expect(types).toContain("display_name: string")
		expect(types).toContain("avatar?: string | null | undefined")
		expect(types).toContain("bio?: string | null | undefined")
		/* arktype route */
		expect(types).toContain("theme:")
		expect(types).toContain("notifications?: boolean")
	})
})

describe("generated types validity - complex real-world apps", () => {
	it("20+ route app with mixed schemas, params, errors, outputs", () => {
		const errs = defineErrors({
			email_taken: "conflict",
			not_authorized: "unauthorized",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const app = honey()
			/* health */
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			/* auth */
			.post("/v1/auth/register")
			.input({
				json: z.object({
					email: z.string(),
					first_name: z.string().nullable().optional(),
					last_name: z.string().nullable().optional(),
					password: z.string(),
				}),
			})
			.output({ "application/json": { created: z.object({ id: z.string() }) } })
			.errors(errs, "email_taken")
			.handler((ctx) => ctx.res.json("created", { id: "1" }))
			.post("/v1/auth/login")
			.input({
				json: z.object({ email: z.string(), password: z.string() }),
			})
			.output({ "application/json": { ok: z.object({ token: z.string() }) } })
			.errors(errs, "not_authorized")
			.handler((ctx) => ctx.res.json("ok", { token: "t" }))
			/* users */
			.get("/v1/users")
			.input({
				search: v.object({ limit: v.optional(v.number()), page: v.number() }),
			})
			.output({
				"application/json": {
					ok: v.object({
						items: v.array(v.object({ email: v.string(), id: v.string(), name: v.string() })),
						total: v.number(),
					}),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { items: [], total: 0 }))
			.get("/v1/users/:id")
			.output({
				"application/json": {
					ok: v.object({ email: v.string(), id: v.string(), name: v.string() }),
				},
			})
			.errors(errs, "not_found")
			.handler((ctx) => ctx.res.json("ok", { email: "", id: ctx.params.id, name: "" }))
			.put("/v1/users/:id")
			.input({
				json: v.object({
					avatar: v.optional(v.nullable(v.string())),
					bio: v.nullish(v.string()),
					name: v.string(),
				}),
			})
			.errors(errs, "not_found")
			.handler((ctx) => ctx.res.json("ok", {}))
			.delete("/v1/users/:id")
			.errors(errs, "not_found", "not_authorized")
			.handler((ctx) => ctx.res.noContent())
			/* projects */
			.get("/v1/projects")
			.input({ search: type({ limit: "number", offset: "number" }) })
			.output({
				"application/json": {
					ok: type({
						items: type({ id: "string", name: "string" }).array(),
						total: "number",
					}),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { items: [], total: 0 }))
			.post("/v1/projects")
			.input({
				json: type({
					"description?": "string",
					name: "string",
				}),
			})
			.output({ "application/json": { created: type({ id: "string" }) } })
			.handler((ctx) => ctx.res.json("created", { id: "1" }))

		const types = generateTypes(app, { appExport: "app", appImport: "./app" })

		expect(types).toContain("export type Routes = {")
		expect(types).toContain('from "honey"')
		/* all routes present */
		expect(types).toContain('"/health"')
		expect(types).toContain('"/v1/auth/register"')
		expect(types).toContain('"/v1/auth/login"')
		expect(types).toContain('"/v1/users"')
		expect(types).toContain('"/v1/users/:id"')
		expect(types).toContain('"/v1/projects"')
		/* optional properties preserved */
		expect(types).toContain("first_name?: string | null | undefined")
		expect(types).toContain("last_name?: string | null | undefined")
		expect(types).toContain("limit?: number | undefined")
		expect(types).toContain("avatar?: string | null | undefined")
		expect(types).toContain("bio?: string | null | undefined")
		expect(types).toContain("description?: string")
		/* required properties NOT optional */
		expect(types).not.toContain("email?")
		expect(types).not.toContain("password?")
		/* params */
		expect(types).toContain("readonly params: { id: string }")
		/* errors */
		expect(types).toContain('"email_taken"')
		expect(types).toContain('"not_authorized"')
		expect(types).toContain('"not_found"')
		/* output schemas */
		expect(types).toContain("token: string")
		expect(types).toContain("total: number")
	})
})
