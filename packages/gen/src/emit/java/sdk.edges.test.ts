/**
 * The Java emitter's edge shapes (bit 16 phase c1): the branches the c1 legs' documents do not reach, each with its
 * own minimal OpenAPI document. A document with no servers builds its client on a null base; an operation whose id
 * has no resource sits on the client itself; a JSON answer with no schema is untyped; and a key whose inline schema
 * two operations declare is declared once. A component spelled like an operation's own type keeps its name, the
 * operation's type claims `…2` after it (C#'s order), and no two declarations ever share one file.
 */
import { describe, expect, it } from "vitest"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk, javaCallPlans } from "./sdk.ts"
import { putFile } from "./sdk-models.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips the compiled leg elsewhere. */
const JAVA = withJava()

const info = { title: "Edge", version: "1" }
const CLIENT = "src/main/java/ai/anyrow/AnyrowClient.java"

/** A document of `paths` under the OpenAPI 3.1 envelope, with `extra` members beside them. */
const doc = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	info,
	openapi: "3.1.0",
	paths,
	...extra,
})

const servers = [{ url: "https://api.example.test" }]

describe("the client's base and its operations' places", () => {
	it("builds the client on a null base when the document names no server", () => {
		const files = generateJavaSdk(
			doc({ "/x": { get: { operationId: "x.get", responses: { 204: { description: "done" } } } } }),
		).files
		expect(files[CLIENT]).toContain("ClientConfig.builder(null,")
	})

	it("places an operation whose id has no resource on the client itself", () => {
		const document = doc(
			{ "/ping": { get: { operationId: "ping", responses: { 204: { description: "done" } } } } },
			{ servers },
		)
		const files = generateJavaSdk(document).files
		expect(files[CLIENT]).toMatch(/public void ping\(PingParams params\)/)
		expect(javaCallPlans(document)["ping"]?.accessors).toEqual([])
	})
})

describe("an answer's type", () => {
	it("is untyped for a JSON answer with no schema, and still planned as JSON", () => {
		const document = doc(
			{
				"/raw": {
					get: {
						operationId: "raw.get",
						responses: { 200: { description: "ok", content: { "application/json": {} } } },
					},
				},
			},
			{ servers },
		)
		expect(javaCallPlans(document)["raw.get"]?.response).toBe("json")
		expect(() => generateJavaSdk(document)).not.toThrow()
	})
})

describe("ErrorKey's inline schemas", () => {
	it("declares a key's <Key>Data once when two operations declare it with an inline schema", () => {
		const inline = { schema: { type: "object", properties: { until: { type: "string" } } }, status: 423 }
		const twice = (operationId: string) => ({
			get: {
				operationId,
				responses: { 204: { description: "done" } },
				"x-honey-errors": { "item.locked": inline },
			},
		})
		const files = generateJavaSdk(doc({ "/a": twice("a.get"), "/b": twice("b.get") }, { servers })).files
		const data = Object.keys(files).filter((path) => path.endsWith("ItemLockedData.java"))
		expect(data).toHaveLength(1)
	})
})

/* the http document's operation types, each also declared as a component: params, response headers, multipart body, resource */
const SPELLED_LIKE_OPS = ["FilesUploadBody", "ItemsGetHeaders", "ItemsGetParams", "ItemsResource"]

/** The http document with each of `names` declared as a component of one string field, `zz`. */
function withComponents(names: readonly string[]): Record<string, unknown> {
	const document = structuredClone(FIXTURES.http.document()) as { components: { schemas: Record<string, unknown> } }
	for (const name of names)
		document.components.schemas[name] = { properties: { zz: { type: "string" } }, type: "object" }
	return document
}

describe("an operation's own types beside a component spelled like one (B3)", () => {
	it.skipIf(!JAVA)(
		"keeps each component's name and claims the operation's params, headers, body and resource as …2, and both compile",
		{ timeout: 600_000 },
		() => {
			const document = withComponents(SPELLED_LIKE_OPS)
			const files = generateJavaSdk(document).files
			const at = (name: string) => files[`src/main/java/ai/anyrow/${name}.java`] ?? ""
			const kinds = SPELLED_LIKE_OPS.map((name) => ({
				model: /\bzz\b/.test(at(name)),
				name,
				op: new RegExp(`\\b(?:class|record) ${name}2\\b`).test(at(`${name}2`)),
			}))
			expect(kinds).toEqual(SPELLED_LIKE_OPS.map((name) => ({ model: true, name, op: true })))
			const plan = javaCallPlans(document)["items.get"]
			expect({ headers: plan?.responseHeaders?.type, params: plan?.params }).toEqual({
				headers: "ItemsGetHeaders2",
				params: "ItemsGetParams2",
			})
			const sdk = compiledJavaSdk(files)
			expect(sdk.javac.diagnostics, sdk.javac.diagnostics.join("\n")).toEqual([])
		},
	)

	it("refuses a second declaration of one file, naming the path", () => {
		const files: Record<string, string> = {}
		putFile(files, "src/main/java/ai/anyrow/Item.java", "a")
		expect(() => putFile(files, "src/main/java/ai/anyrow/Item.java", "b")).toThrow(
			"two declarations claim src/main/java/ai/anyrow/Item.java",
		)
		expect(files).toEqual({ "src/main/java/ai/anyrow/Item.java": "a" })
	})
})

describe("a resource whose segment an Object member holds (B3)", () => {
	it("types the accessor `wait2` with the class its own file declares, WaitResource", () => {
		const document = doc(
			{ "/w": { get: { operationId: "wait.get", responses: { 204: { description: "done" } } } } },
			{ servers },
		)
		const files = generateJavaSdk(document).files
		const spelled = [...(files[CLIENT] ?? "").matchAll(/private final (\w+Resource) (\w+);/g)].map(
			([, type, field]) => ({ declared: files[`src/main/java/ai/anyrow/${type}.java`] !== undefined, field, type }),
		)
		expect(spelled).toEqual([{ declared: true, field: "wait2", type: "WaitResource" }])
	})
})
