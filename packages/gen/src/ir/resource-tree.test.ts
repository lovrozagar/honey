import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "./build.ts"
import type { IRNamespace, IROperation } from "./model.ts"
import { buildResourceTree, methodsOf, namespacesOf } from "./resource-tree.ts"

/** An operation with id `id`; the tree reads nothing else. */
const op = (id: string): IROperation => ({
	extensions: {},
	id,
	method: "GET",
	params: { header: [], path: [], query: [] },
	path: "/",
	responses: {},
})

/** The tree as nested plain objects: a method is its operation id, a namespace its entries. */
function shape(ns: IRNamespace): Record<string, unknown> {
	return Object.fromEntries([
		...methodsOf(ns).map(([key, operation]) => [key, operation.id]),
		...namespacesOf(ns).map(([key, child]) => [key, shape(child)]),
	])
}

/** A document of `paths`. */
function doc(paths: Record<string, unknown>): OpenApiDocument {
	return { info: { title: "T", version: "1" }, openapi: "3.1.0", paths } as OpenApiDocument
}

describe("buildResourceTree: a namespace per dotted operationId segment", () => {
	// v0: d5da400534
	// v0: 4f267f5f75
	// v0: e9d5111eb1
	// v0: 6e2f59a5b9
	// v0: 7a491d2d89
	// v0: 0176a52d2e
	// v0: 8dc989113b
	it("nests each id by its segments at any depth, mixed depths and siblings side by side", () => {
		const ids = [
			"health",
			"users.list",
			"users.profile.update",
			"checkout.sessions.create",
			"foo.a.b.c",
			"a.b.c",
			"a.b.d",
		]
		expect([shape(buildResourceTree(ids.map(op))), shape(buildResourceTree([]))]).toEqual([
			{
				a: { b: { c: "a.b.c", d: "a.b.d" } },
				checkout: { sessions: { create: "checkout.sessions.create" } },
				foo: { a: { b: { c: "foo.a.b.c" } } },
				health: "health",
				users: { list: "users.list", profile: { update: "users.profile.update" } },
			},
			{},
		])
	})

	// v0: 8ef28bd1c7
	it("lists methods and namespaces in code-unit order, upper case first", () => {
		const root = buildResourceTree(["b", "B", "a", "z.x", "Z.x", "_.x"].map(op))
		expect([methodsOf(root).map(([key]) => key), namespacesOf(root).map(([key]) => key)]).toEqual([
			["B", "a", "b"],
			["Z", "_", "z"],
		])
	})
})

describe("buildResourceTree: one name, one meaning", () => {
	// v0: c943f12cfc
	// v0: ab08b4ab67
	// v0: f005ee4de4
	// v0: 05fc30f534
	it("refuses an id that is also another's namespace, in either order, naming both and a fix", () => {
		expect(() => buildResourceTree(["users.create", "users.create.draft"].map(op))).toThrow(
			'operationId conflict: "users.create" is callable but also a namespace prefix of "users.create.draft".\nRename one. Suggested: "users.create" → "users.createOne" or drop "users.create.draft".',
		)
		expect(() => buildResourceTree(["users.create.draft", "users.create"].map(op))).toThrow(
			'operationId conflict: "users.create" is callable but also a namespace prefix of "users.create.draft".',
		)
		expect(() => buildResourceTree(["a.b.c.d", "a.b"].map(op))).toThrow(
			'"a.b" is callable but also a namespace prefix of "a.b.c.d"',
		)
		expect(() => buildResourceTree(["a.b.c.d", "a.x", "a.b.c"].map(op))).toThrow(
			'"a.b.c" is callable but also a namespace prefix of "a.b.c.d"',
		)
	})

	// v0: 05ab06f1d2
	// v0: 14fdbceab5
	it("is the tree toIR builds over its operations, after refusing a duplicate id", () => {
		const ir = toIR(
			doc({
				"/a": {
					get: { operationId: "users.list", responses: {} },
					post: { operationId: "users.create", responses: {} },
				},
			}),
		)
		expect(shape(ir.tree)).toEqual({ users: { create: "users.create", list: "users.list" } })
		expect(() =>
			toIR(doc({ "/a": { get: { operationId: "x", responses: {} }, post: { operationId: "x", responses: {} } } })),
		).toThrow('Duplicate operationId: "x"')
	})
})
