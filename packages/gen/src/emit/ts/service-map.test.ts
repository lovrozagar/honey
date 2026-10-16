import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { memberTree, serviceMapOf, serviceMapText } from "./service-map.ts"

type Json = Record<string, unknown>

/** The IR of a document of `paths`, every operation with an id. */
const ir = (paths: Json) =>
	toIR({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths } as OpenApiDocument, { deriveOperationIds: true })

const json = (schema: Json = { type: "object" }) => ({ content: { "application/json": { schema } }, description: "" })
const STRING = { type: "string" }

describe("serviceMapOf: what an entry carries, each only when set", () => {
	it("carries the declared non-JSON media type as accept, the success answer's headers lower case, and idempotency", () => {
		const map = structuredClone(
			serviceMapOf(
				ir({
					"/a": {
						post: {
							operationId: "a",
							responses: {
								201: { ...json(), headers: { "X-Rate": { schema: STRING }, "x-cursor": { schema: STRING } } },
							},
							"x-idempotency-key": true,
						},
					},
					"/pdf": {
						get: { operationId: "pdf", responses: { 200: { content: { "application/pdf": {} }, description: "" } } },
					},
					"/plain": { get: { operationId: "plain", responses: { 200: json() } } },
				}),
			),
		)
		expect(map).toEqual({
			a: { headers: ["x-cursor", "x-rate"], idempotent: true, method: "POST", path: "/a" },
			pdf: { accept: "application/pdf", method: "GET", path: "/pdf" },
			plain: { method: "GET", path: "/plain" },
		})
	})

	it("names a wildcard param, and leaves accept off an event stream", () => {
		const map = structuredClone(
			serviceMapOf(
				ir({
					"/files/{path}": {
						get: {
							operationId: "files.get",
							parameters: [{ in: "path", name: "path", required: true, schema: STRING, "x-honey-wildcard": true }],
							responses: { 200: json() },
						},
					},
					"/live": {
						get: { operationId: "live", responses: { 200: { content: { "text/event-stream": {} }, description: "" } } },
					},
				}),
			),
		) as Record<string, Json>
		expect([map.files, map.live]).toEqual([
			{ get: { method: "GET", params: ["path"], path: "/files/{path}", wildcard: "path" } },
			{ method: "GET", path: "/live", sse: true },
		])
	})
})

describe("memberTree: names a client cannot expose", () => {
	it("renames an Object.prototype name at any depth, and a client member only at the root", () => {
		const tree = memberTree(
			ir({
				"/a": { get: { operationId: "users.toString", responses: { 200: json() } } },
				"/b": { get: { operationId: "users.state", responses: { 200: json() } } },
				"/c": { get: { operationId: "dispose", responses: { 200: json() } } },
			}).tree,
		)
		const users = tree.entries.get("users")
		const inner = users?.kind === "namespace" ? [...users.ns.entries.keys()] : []
		expect([[...tree.entries.keys()], inner]).toEqual([
			["dispose_", "users"],
			["state", "toString_"],
		])
	})
})

describe("serviceMapText: the map module", () => {
	it("writes the map as a typed const, keys in code-unit order, a non-identifier key quoted", () => {
		const text = serviceMapText(
			ir({
				"/b": { get: { operationId: "b-c", responses: { 200: json() } } },
				"/z": { get: { operationId: "Z", responses: { 200: json() } } },
			}),
			"sdk.runtime.gen",
		)
		expect(text).toBe(`import type { ServiceMap } from "./sdk.runtime.gen"

export const serviceMap: ServiceMap = {
	Z: {
		method: "GET",
		path: "/z",
	},
	"b-c": {
		method: "GET",
		path: "/b",
	},
}
`)
	})

	it("writes an empty map for a document without operations", () => {
		expect(serviceMapText(ir({}), "r")).toContain("export const serviceMap: ServiceMap = {}")
	})
})
