/**
 * Every OpenAPI document honey writes is a valid OpenAPI 3.1 document, reads back the same through
 * a YAML reader, refers only to components it holds, and describes only requests the router
 * serves. ajv, ajv-formats and js-yaml are test-only: the emitter itself stays vendor-free.
 */
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as v from "valibot"
import * as z from "zod"
import { generateOpenApi } from "../../../src/openapi/generate.ts"
import { toYaml } from "../../../src/openapi/yaml.ts"
import { honey } from "../../../src/routing/app.ts"
import { SILENT } from "../../../src/telemetry/logger.ts"
import { createConformanceApp } from "./app.ts"

const require = createRequire(import.meta.url)
const OAS31 = join(import.meta.dirname, "oas31")
const E2E_APPS = join(import.meta.dirname, "../../e2e/apps")

type Ajv = {
	addFormat(name: string, format: boolean): void
	addSchema(schema: unknown): void
	compile(schema: unknown): ((doc: unknown) => boolean) & { errors?: unknown }
}
type Parameter = { in?: string; name?: string; "x-honey-wildcard"?: boolean }
type Doc = {
	components?: { schemas?: Record<string, unknown> }
	paths: Record<string, Record<string, { parameters?: Parameter[]; "x-websocket"?: boolean }>>
	servers?: { url: string }[]
}
type App = { fetch(request: Request, env: object): Promise<Response> | Response }

const jsYaml = require("js-yaml") as { load(text: string): unknown }

/**
 * The 3.1 schema checks Schema Objects through `$dynamicRef: "#meta"`, which ajv resolves
 * unreliably across documents; pointing it at the OAS base dialect checks the same thing: every
 * Schema Object is a valid JSON Schema 2020-12 schema.
 */
function compileValidator(): (doc: unknown) => { errors: unknown; ok: boolean } {
	const read = (name: string) =>
		JSON.parse(readFileSync(join(OAS31, `${name}.json`), "utf8")) as Record<string, unknown>
	const Ajv2020 = (require("ajv/dist/2020.js") as { default: new (options: object) => Ajv }).default
	const ajv = new Ajv2020({ allErrors: true, strict: false })
	;(require("ajv-formats") as { default: (ajv: Ajv) => void }).default(ajv)
	ajv.addFormat("media-range", true)
	const oas = JSON.parse(
		JSON.stringify(read("schema")).replaceAll(
			'"$dynamicRef":"#meta"',
			'"$ref":"https://spec.openapis.org/oas/3.1/dialect/base"',
		),
	) as { $defs: { schema: Record<string, unknown> } }
	delete oas.$defs.schema.$dynamicAnchor
	ajv.addSchema(read("meta-base"))
	ajv.addSchema(read("dialect-base"))
	const check = ajv.compile(oas)
	return (doc) => {
		const ok = check(doc)
		return { errors: check.errors ?? null, ok }
	}
}

const validate = compileValidator()

/** Every document an e2e app commits: what `bun run generate` writes. */
function committedDocuments(): [string, Doc][] {
	return readdirSync(E2E_APPS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			const dir = join(E2E_APPS, entry.name, "src/_gen")
			const files = readdirSync(dir).filter((file) => /^openapi\..*json$/.test(file))
			return files.map((file): [string, Doc] => [
				`${entry.name}/${file}`,
				JSON.parse(readFileSync(join(dir, file), "utf8")) as Doc,
			])
		})
}

/** An app with every shape the generator knows: the adversarial corner of the corpus. */
function cornerCases() {
	const Category = z.object({
		name: z.string(),
		get children() {
			return z.array(Category)
		},
	})
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
		.input({ form: z.object({ file: z.file(), tags: z.array(z.string()) }) })
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
		.handler((c) => c.res.json("ok", { blob: null, n: 1n }))
	app
		.get("/valibot")
		.input({ search: v.object({ page: v.optional(v.pipe(v.number(), v.integer())) }) })
		.output({ "application/json": { ok: v.strictObject({ items: v.tuple([v.string(), v.number()]) }) } })
		.handler((c) => c.res.json("ok", { items: ["a", 1] }))
	app.ws("/live/:room").handler({ onMessage() {} })
	return app
}

/** `trailingSlash("enforce")`: the documented paths carry the slash clients send. */
function trailingSlash() {
	const app = honey<{}>().trailingSlash("enforce")
	app.get("/items/:id").handler((c) => c.res.text("ok", "ok"))
	app.post("/items").handler((c) => c.res.text("ok", "ok"))
	return app
}

/** One object nested in another, shared by two bodies: required in one, optional in the other. */
function sharedNested() {
	const assertion = z.object({
		clientExtensionResults: z.object({}),
		id: z.string(),
		response: z.object({ signature: z.string() }),
	})
	const app = honey<{}>()
	app
		.post("/login")
		.input({ json: z.object({ response: assertion }) })
		.handler((c) => c.res.json("ok", {}))
	app
		.post("/reauth")
		.input({ json: z.object({ passkey: assertion.optional() }) })
		.handler((c) => c.res.json("ok", {}))
	return app
}

/** Each corpus app's document, beside the app that serves it. */
function generated(): [string, Doc, App][] {
	return (
		[
			["corner cases", cornerCases],
			["trailing slash", trailingSlash],
			["shared nested object", sharedNested],
			/* the reference app every generated client is measured against (bit 11): broken here, red in `bun run test` */
			["conformance app", () => createConformanceApp()],
		] as const
	).map(([name, make]) => {
		const app = make()
		const doc = generateOpenApi(app, { info: { title: name, version: "1" }, logger: SILENT }) as unknown as Doc
		return [name, doc, app]
	})
}

/** The `$ref`s to `#/components/schemas/*` that name no component. */
function danglingRefs(doc: Doc): string[] {
	const have = new Set(Object.keys(doc.components?.schemas ?? {}))
	const missing = new Set<string>()
	JSON.stringify(doc, (key, value: unknown) => {
		if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/schemas/")) {
			const name = value.slice("#/components/schemas/".length)
			if (!have.has(name)) missing.add(name)
		}
		return value
	})
	return [...missing].sort()
}

describe("OpenAPI 3.1 conformance: valid documents", () => {
	// v0: 666408fb48
	it("refuses an invalid document: the check itself works", () => {
		const bad = {
			info: { title: "x", version: "1" },
			openapi: "3.1.0",
			paths: { "/a/{id}": { get: { parameters: [{ in: "path", name: "id", required: false }], responses: {} } } },
		}
		expect(validate(bad).ok).toBe(false)
	})

	// v0: 8c176a0d0e
	// v0: 5a784bd838
	// v0: 200ed8a5ae
	it("finds every committed document valid 3.1, and read back whole through YAML", () => {
		const committed = committedDocuments()
		expect(committed.length).toBeGreaterThan(0)
		for (const [name, doc] of committed) {
			expect(validate(doc).errors, name).toBeNull()
			expect(jsYaml.load(toYaml(doc)), name).toEqual(doc)
		}
	})

	// v0: 66e3fbca3b
	it("finds every generated document valid 3.1, and read back whole through YAML", () => {
		for (const [name, doc] of generated()) {
			expect(validate(doc).errors, name).toBeNull()
			expect(jsYaml.load(toYaml(doc)), name).toEqual(JSON.parse(JSON.stringify(doc)))
		}
	})

	// v0: 473e2a0d14
	it("resolves every $ref of a committed or generated document", () => {
		for (const [name, doc] of [...committedDocuments(), ...generated()]) expect(danglingRefs(doc), name).toEqual([])
	})
})

describe("OpenAPI 3.1 conformance: the router serves what the document says", () => {
	// v0: bb8c5188fc
	it("reaches a handler for every operation, its declared path parameters filled in", async () => {
		for (const [name, doc, app] of generated()) {
			const prefix = doc.servers?.[0]?.url ?? ""
			for (const [template, item] of Object.entries(doc.paths)) {
				for (const [method, op] of Object.entries(item)) {
					const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name as string)
					const inTemplate = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string)
					/* every template variable is declared, and nothing else is */
					expect(declared.sort(), `${name}: ${method} ${template}`).toEqual(inTemplate.sort())
					const url = template.replace(/\{([^}]+)\}/g, (_, param: string) =>
						op.parameters?.find((p) => p.name === param)?.["x-honey-wildcard"] ? "a/b" : "v1",
					)
					const headers: Record<string, string> = op["x-websocket"]
						? { connection: "upgrade", upgrade: "websocket" }
						: {}
					const request = new Request(`http://x${prefix}${url}`, { headers, method: method.toUpperCase() })
					const res = await app.fetch(request, {})
					expect([404, 405, 308], `${name}: ${method.toUpperCase()} ${prefix}${url} → ${res.status}`).not.toContain(
						res.status,
					)
				}
			}
		}
	})
})
