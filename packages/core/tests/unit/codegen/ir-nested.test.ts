import { describe, expect, it } from "vitest"
/* RED: buildResourceTree, methodsOf, namespacesOf do not exist yet in codegen-ir.ts */
import { buildResourceTree, methodsOf, namespacesOf, toIR } from "../../../src/codegen-ir.ts"

/* ---- helpers ---- */

function minimalSpec(
	overrides: Record<string, unknown> = {},
): Parameters<typeof toIR>[0] {
	return {
		info: { title: "T", version: "1" },
		openapi: "3.0.0",
		paths: {},
		...overrides,
	} as Parameters<typeof toIR>[0]
}

function specWithOps(
	ops: Array<{ path: string; method: string; operationId: string }>,
): Parameters<typeof toIR>[0] {
	const paths: Record<string, Record<string, unknown>> = {}
	for (const { path, method, operationId } of ops) {
		paths[path] ??= {}
		paths[path][method] = { operationId, responses: {} }
	}
	return minimalSpec({ paths })
}

/* ======================================================= */
describe("buildResourceTree — T1–T12", () => {
	/* T1: single-segment top-level method */
	it("T1 single-segment top-level method produces method entry at root", () => {
		const spec = specWithOps([{ method: "get", operationId: "getUser", path: "/users" }])
		const ir = toIR(spec)
		/* RED: IR.tree does not exist yet */
		const tree = ir.tree
		expect(tree).toBeDefined()
		const entry = tree.entries.get("getUser")
		expect(entry).toBeDefined()
		expect(entry?.kind).toBe("method")
		if (entry?.kind === "method") {
			expect(entry.op.id).toBe("getUser")
		}
		/* no namespace entries */
		expect(namespacesOf(tree)).toHaveLength(0)
		expect(methodsOf(tree)).toHaveLength(1)
	})

	/* T2: 2-segment baseline */
	it("T2 2-segment operationId produces namespace entry with method children", () => {
		const spec = specWithOps([
			{ method: "post", operationId: "users.create", path: "/users" },
			{ method: "get", operationId: "users.list", path: "/users/list" },
		])
		const ir = toIR(spec)
		const tree = ir.tree
		const usersEntry = tree.entries.get("users")
		expect(usersEntry).toBeDefined()
		expect(usersEntry?.kind).toBe("namespace")
		if (usersEntry?.kind === "namespace") {
			expect(usersEntry.ns.entries.get("create")?.kind).toBe("method")
			expect(usersEntry.ns.entries.get("list")?.kind).toBe("method")
		}
		/* root has no method entries, only the users namespace */
		expect(methodsOf(tree)).toHaveLength(0)
		expect(namespacesOf(tree)).toHaveLength(1)
	})

	/* T3: 3-segment nested */
	it("T3 3-segment checkout.sessions.create produces checkout→sessions→create chain", () => {
		const spec = specWithOps([
			{ method: "post", operationId: "checkout.sessions.create", path: "/checkout/sessions" },
		])
		const ir = toIR(spec)
		const tree = ir.tree

		const nses = namespacesOf(tree)
		expect(nses).toHaveLength(1)
		const checkoutPair = nses[0]
		expect(checkoutPair).toBeDefined()
		const checkoutNs = checkoutPair?.[1]
		if (!checkoutNs) throw new Error("checkoutNs missing")
		expect(namespacesOf(checkoutNs)).toHaveLength(1)
		const sessionsPair = namespacesOf(checkoutNs)[0]
		if (!sessionsPair) throw new Error("sessionsPair missing")
		const sessionsNs = sessionsPair[1]
		expect(methodsOf(sessionsNs)).toHaveLength(1)
		const leafPair = methodsOf(sessionsNs)[0]
		if (!leafPair) throw new Error("leafPair missing")
		const [leafName, leafOp] = leafPair
		expect(leafName).toBe("create")
		expect(leafOp.id).toBe("checkout.sessions.create")
	})

	/* T4: 4-segment deep */
	it("T4 4-segment foo.a.b.c produces foo→a→b (all namespaces) →c (method)", () => {
		const spec = specWithOps([
			{ method: "get", operationId: "foo.a.b.c", path: "/foo/a/b/c" },
		])
		const ir = toIR(spec)
		const tree = ir.tree

		const fooEntry = tree.entries.get("foo")
		expect(fooEntry?.kind).toBe("namespace")
		if (fooEntry?.kind !== "namespace") return
		const aEntry = fooEntry.ns.entries.get("a")
		expect(aEntry?.kind).toBe("namespace")
		if (aEntry?.kind !== "namespace") return
		const bEntry = aEntry.ns.entries.get("b")
		expect(bEntry?.kind).toBe("namespace")
		if (bEntry?.kind !== "namespace") return
		const cEntry = bEntry.ns.entries.get("c")
		expect(cEntry?.kind).toBe("method")
		if (cEntry?.kind === "method") {
			expect(cEntry.op.id).toBe("foo.a.b.c")
		}
	})

	/* T5: mixed depth siblings */
	it("T5 mixed depth: users.list (2-seg) and users.profile.update (3-seg) coexist under users", () => {
		const spec = specWithOps([
			{ method: "get", operationId: "users.list", path: "/users" },
			{ method: "patch", operationId: "users.profile.update", path: "/users/profile" },
		])
		const ir = toIR(spec)
		const tree = ir.tree

		const usersEntry = tree.entries.get("users")
		expect(usersEntry?.kind).toBe("namespace")
		if (usersEntry?.kind !== "namespace") return
		const listEntry = usersEntry.ns.entries.get("list")
		expect(listEntry?.kind).toBe("method")
		const profileEntry = usersEntry.ns.entries.get("profile")
		expect(profileEntry?.kind).toBe("namespace")
		if (profileEntry?.kind === "namespace") {
			const updateEntry = profileEntry.ns.entries.get("update")
			expect(updateEntry?.kind).toBe("method")
			if (updateEntry?.kind === "method") {
				expect(updateEntry.op.id).toBe("users.profile.update")
			}
		}
	})

	/* T6: deterministic key order */
	it("T6 methodsOf and namespacesOf return entries sorted by key", () => {
		/* intentionally out of alphabetical order: zebra, apple, mango */
		const spec = specWithOps([
			{ method: "get", operationId: "res.zebra", path: "/res/zebra" },
			{ method: "get", operationId: "res.apple", path: "/res/apple" },
			{ method: "get", operationId: "res.mango", path: "/res/mango" },
		])
		const ir = toIR(spec)
		const resEntry = ir.tree.entries.get("res")
		expect(resEntry?.kind).toBe("namespace")
		if (resEntry?.kind !== "namespace") return
		const methods = methodsOf(resEntry.ns)
		expect(methods.map(([k]) => k)).toEqual(["apple", "mango", "zebra"])
	})

	/* T7: collision — shallower opId is also namespace prefix */
	it("T7 collision: users.create and users.create.draft throws with both ids in message", () => {
		const spec = specWithOps([
			{ method: "post", operationId: "users.create", path: "/users" },
			{ method: "post", operationId: "users.create.draft", path: "/users/draft" },
		])
		expect(() => toIR(spec)).toThrow(
			/operationId conflict.*users\.create.*users\.create\.draft|operationId conflict.*users\.create\.draft.*users\.create/,
		)
	})

	/* T8: collision — deeper opId arrives first */
	it("T8 collision: users.create.draft declared before users.create still throws", () => {
		const spec = specWithOps([
			{ method: "post", operationId: "users.create.draft", path: "/users/draft" },
			{ method: "post", operationId: "users.create", path: "/users" },
		])
		expect(() => toIR(spec)).toThrow(/operationId conflict/)
	})

	/* T9: deep collision */
	it("T9 deep collision: a.b.c and a.b.c.d together throw with both ids in error", () => {
		const spec = specWithOps([
			{ method: "get", operationId: "a.b.c", path: "/a/b/c" },
			{ method: "get", operationId: "a.b.c.d", path: "/a/b/c/d" },
		])
		expect(() => toIR(spec)).toThrow(
			/operationId conflict.*a\.b\.c.*a\.b\.c\.d|operationId conflict.*a\.b\.c\.d.*a\.b\.c/,
		)
	})

	/* T10: sibling leaves — no throw */
	it("T10 a.b.c and a.b.d are siblings and do not throw", () => {
		const spec = specWithOps([
			{ method: "get", operationId: "a.b.c", path: "/a/b/c" },
			{ method: "get", operationId: "a.b.d", path: "/a/b/d" },
		])
		let ir: ReturnType<typeof toIR> | undefined
		expect(() => {
			ir = toIR(spec)
		}).not.toThrow()
		const abEntry = ir?.tree.entries.get("a")
		expect(abEntry?.kind).toBe("namespace")
		if (abEntry?.kind !== "namespace") return
		const bEntry = abEntry.ns.entries.get("b")
		expect(bEntry?.kind).toBe("namespace")
		if (bEntry?.kind !== "namespace") return
		expect(methodsOf(bEntry.ns)).toHaveLength(2)
	})

	/* T11: pre-existing duplicate-id check still works */
	it("T11 duplicate operationId still throws Duplicate operationId (existing behavior)", () => {
		const spec = minimalSpec({
			paths: {
				"/a": { get: { operationId: "same", responses: {} } },
				"/b": { get: { operationId: "same", responses: {} } },
			},
		})
		expect(() => toIR(spec)).toThrow(/Duplicate operationId/)
	})

	/* T12: IR.tree exposed on toIR output */
	it("T12 toIR output has .tree property consistent with .operations", () => {
		const spec = specWithOps([
			{ method: "get", operationId: "items.list", path: "/items" },
			{ method: "post", operationId: "items.create", path: "/items/create" },
		])
		const ir = toIR(spec)
		/* tree must be non-null IRNamespace */
		expect(ir.tree).toBeDefined()
		expect(ir.tree.entries).toBeInstanceOf(Map)
		/* methodsOf on the items sub-namespace matches operations count */
		const itemsEntry = ir.tree.entries.get("items")
		expect(itemsEntry?.kind).toBe("namespace")
		if (itemsEntry?.kind === "namespace") {
			expect(methodsOf(itemsEntry.ns)).toHaveLength(ir.operations.length)
		}
	})
})

/* Also validate that buildResourceTree can be called standalone */
describe("buildResourceTree — standalone helper", () => {
	it("buildResourceTree on empty array returns empty root namespace", () => {
		const root = buildResourceTree([])
		expect(root.entries.size).toBe(0)
		expect(methodsOf(root)).toHaveLength(0)
		expect(namespacesOf(root)).toHaveLength(0)
	})

	it("buildResourceTree throws on collision without going through toIR", () => {
		/* oxlint-disable-next-line sort-keys */
		const fakeOps = [
			{
				extensions: {},
				id: "a.b",
				method: "POST" as const,
				params: { header: [], path: [], query: [] },
				path: "/a/b",
				responses: {},
			},
			{
				extensions: {},
				id: "a.b.c",
				method: "POST" as const,
				params: { header: [], path: [], query: [] },
				path: "/a/b/c",
				responses: {},
			},
		]
		expect(() => buildResourceTree(fakeOps)).toThrow(/operationId conflict/)
	})
})
