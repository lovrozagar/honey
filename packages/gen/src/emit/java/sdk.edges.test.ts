/**
 * The Java emitter's edge shapes (bit 16 phase c1): the branches the c1 legs' documents do not reach, each with its
 * own minimal OpenAPI document. A document with no servers builds its client on a null base; an operation whose id
 * has no resource sits on the client itself; a JSON answer with no schema is untyped; and a key whose inline schema
 * two operations declare is declared once.
 */
import { describe, expect, it } from "vitest"
import { generateJavaSdk, javaCallPlans } from "./sdk.ts"

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
