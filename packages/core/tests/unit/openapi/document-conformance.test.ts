/**
 * Every OpenAPI document honey produces is a valid OpenAPI 3.1 document, survives a YAML round
 * trip unchanged, and describes only requests the router actually serves.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { load as loadYaml } from "js-yaml"
import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"
import * as z from "zod"
import { generateOpenApi, toYaml } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, "../../fixtures/oas31")
const E2E_APPS = join(HERE, "../../../../../e2e/apps")

type Doc = {
	paths: Record<string, Record<string, { parameters?: Array<Record<string, unknown>> }>>
	servers?: Array<{ url: string }>
}

/**
 * The OpenAPI 3.1 schema validates Schema Objects through `$dynamicRef: "#meta"`, which Ajv
 * resolves unreliably across documents. Pointing it statically at the OAS base dialect checks
 * the same thing: every Schema Object is a valid JSON Schema 2020-12 schema.
 */
function compileValidator(): (doc: unknown) => { errors: unknown; ok: boolean } {
	const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"))
	const AjvCtor = Ajv2020 as unknown as new (opts: Record<string, unknown>) => {
		addFormat(name: string, format: boolean): void
		addSchema(schema: unknown): void
		compile(schema: unknown): ((doc: unknown) => boolean) & { errors?: unknown }
	}
	const ajv = new AjvCtor({ allErrors: true, strict: false })
	;(addFormats as unknown as (a: unknown) => void)(ajv)
	ajv.addFormat("media-range", true)
	const oas = JSON.parse(
		JSON.stringify(read("schema")).replaceAll(
			'"$dynamicRef":"#meta"',
			'"$ref":"https://spec.openapis.org/oas/3.1/dialect/base"',
		),
	)
	delete oas.$defs.schema.$dynamicAnchor
	ajv.addSchema(read("meta-base"))
	ajv.addSchema(read("dialect-base"))
	const validate = ajv.compile(oas)
	return (doc) => {
		const ok = validate(doc)
		return { errors: validate.errors, ok }
	}
}

const validate = compileValidator()

function committedDocuments(): Array<[string, unknown]> {
	const out: Array<[string, unknown]> = []
	for (const app of readdirSync(E2E_APPS, { withFileTypes: true })) {
		if (!app.isDirectory()) continue
		const dir = join(E2E_APPS, app.name, "src/_gen")
		let files: string[]
		try {
			files = readdirSync(dir)
		} catch {
			continue
		}
		for (const file of files) {
			if (!/^openapi\..*json$/.test(file)) continue
			out.push([`${app.name}/${file}`, JSON.parse(readFileSync(join(dir, file), "utf8"))])
		}
	}
	return out
}

/** An app that exercises every shape the generator knows: the adversarial corner of the corpus. */
function cornerCaseApp() {
	const Category = z.object({
		name: z.string(),
		get children() {
			return z.array(Category)
		},
	})
	const errors = { conflict: () => new Error("x") }
	void errors
	const app = honey<{}>().stripPrefix("/api")
	app.get("/").handler((c) => c.res.text("ok", "root"))
	app
		.get("/users/:id")
		.meta({ operationId: "getUser", summary: "One user", tags: ["users"] })
		.input({
			cookies: z.object({ session: z.string().optional() }),
			headers: z.object({ "x-trace": z.string().optional() }),
			params: z.object({ id: z.string().uuid() }),
			search: z.object({ at: z.date().optional(), expand: z.array(z.string()).optional() }),
		})
		.output({ "application/json": { ok: z.object({ id: z.string(), joined: z.date() }) } })
		.handler((c) => c.res.json("ok", { id: "1", joined: new Date() }))
	app.get("/u/:user-id").handler((c) => c.res.text("ok", "ok"))
	app.get("/v1/books:archive").handler((c) => c.res.text("ok", "ok"))
	app.get("/files/*path").handler((c) => c.res.text("ok", "ok"))
	app.all("/proxy/*").handler((c) => c.res.text("ok", "ok"))
	app.get("/opt/:id?").handler((c) => c.res.text("ok", "ok"))
	app
		.on(["GET", "POST"], "/multi")
		.meta({ operationId: "multi" })
		.handler((c) => c.res.text("ok", "ok"))
	app
		.post("/upload")
		.input({
			form: z.object({ file: z.file(), tags: z.array(z.string()) }),
			json: z.object({ url: z.string().url() }),
		})
		.handler((c) => c.res.text("ok", "ok"))
	app
		.get("/tree")
		.output({ "application/json": { ok: Category } })
		.handler((c) => c.res.json("ok", { children: [], name: "root" }))
	app
		.get("/union")
		.output({
			"application/json": { ok: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) },
			"text/csv": { ok: z.string() },
		})
		.handler((c) => c.res.json("ok", { a: "x" }))
	app
		.get("/custom")
		.output({ "application/json": { ok: z.object({ blob: z.custom<unknown>(), n: z.bigint() }) } })
		.handler((c) => c.res.json("ok", { blob: null, n: 1 }))
	app
		.get("/valibot")
		.input({ search: v.object({ page: v.optional(v.pipe(v.number(), v.integer())) }) })
		.output({ "application/json": { ok: v.strictObject({ items: v.tuple([v.string(), v.number()]) }) } })
		.handler((c) => c.res.json("ok", { items: ["a", 1] }))
	app.ws("/live/:room").handler({ onMessage() {} })
	return app
}

function trailingSlashApp() {
	const app = honey<{}>().trailingSlash("enforce")
	app.get("/items/:id").handler((c) => c.res.text("ok", "ok"))
	app.post("/items").handler((c) => c.res.text("ok", "ok"))
	return app
}

async function generated(): Promise<Array<[string, Doc, ReturnType<typeof honey<{}>>]>> {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	try {
		const out: Array<[string, Doc, ReturnType<typeof honey<{}>>]> = []
		for (const [name, make] of [
			["corner cases", cornerCaseApp],
			["trailing slash", trailingSlashApp],
		] as const) {
			const app = make() as unknown as ReturnType<typeof honey<{}>>
			out.push([name, (await generateOpenApi(app, { info: { title: name, version: "1" } })) as Doc, app])
		}
		return out
	} finally {
		warn.mockRestore()
	}
}

describe("OpenAPI 3.1 conformance", () => {
	it("the meta-schema check rejects an invalid document (the check itself works)", () => {
		const bad = {
			info: { title: "x", version: "1" },
			openapi: "3.1.0",
			paths: { "/a/{id}": { get: { parameters: [{ in: "path", name: "id", required: false }], responses: {} } } },
		}
		expect(validate(bad).ok).toBe(false)
	})

	for (const [name, doc] of committedDocuments()) {
		it(`committed document ${name} is valid OpenAPI 3.1`, () => {
			const result = validate(doc)
			expect(result.errors).toBeNull()
			expect(result.ok).toBe(true)
		})
	}

	it("generated documents are valid OpenAPI 3.1 and round-trip through YAML", async () => {
		for (const [name, doc] of await generated()) {
			const result = validate(doc)
			expect(result.errors, name).toBeNull()
			expect(loadYaml(toYaml(doc)), name).toEqual(JSON.parse(JSON.stringify(doc)))
		}
	})

	it("committed documents round-trip through YAML", () => {
		for (const [name, doc] of committedDocuments()) {
			expect(loadYaml(toYaml(doc)), name).toEqual(doc)
		}
	})
})

describe("the router accepts every path the document emits", () => {
	// regression: M (openapi/collect.ts:15-27)
	it("every operation, with its declared path parameters filled in, reaches a handler", async () => {
		for (const [name, doc, app] of await generated()) {
			const prefix = doc.servers?.[0]?.url ?? ""
			for (const [template, item] of Object.entries(doc.paths)) {
				for (const [method, op] of Object.entries(item)) {
					const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name as string)
					const inTemplate = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
					/* every template variable is declared, and nothing else is */
					expect(declared.sort(), `${name}: ${method} ${template}`).toEqual(inTemplate.sort())
					const url = template.replace(/\{([^}]+)\}/g, (_, param: string) =>
						op.parameters?.find((p) => p.name === param)?.["x-honey-wildcard"] ? "a/b" : "v1",
					)
					const headers: Record<string, string> = {}
					if ((op as Record<string, unknown>)["x-websocket"]) {
						headers.upgrade = "websocket"
						headers.connection = "upgrade"
					}
					const res = await app.fetch(
						new Request(`http://x${prefix}${url}`, { headers, method: method.toUpperCase() }),
						{},
					)
					expect([404, 405, 308], `${name}: ${method.toUpperCase()} ${prefix}${url} → ${res.status}`).not.toContain(
						res.status,
					)
				}
			}
		}
	})
})
