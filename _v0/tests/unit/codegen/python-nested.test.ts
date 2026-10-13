import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generatePythonSDK } from "../../../src/codegen-python.ts"

/* ---- helpers ---- */

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`./fixtures/python/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

const collisionSpec = makeSpec({
	"/users": {
		post: {
			operationId: "users.create",
			responses: { "200": { description: "ok" } },
		},
	},
	"/users/draft": {
		post: {
			operationId: "users.create.draft",
			responses: { "200": { description: "ok" } },
		},
	},
})

/* ======================================================= */
describe("Python SDK codegen — nested operationId support (T27–T32)", () => {
	/* T27: nested class hierarchy emitted */
	it("T27 nested class hierarchy: _CheckoutResource, _CheckoutSessionsResource, _UsersResource all emitted", () => {
		const spec = loadFixture("nested")
		const result = generatePythonSDK(spec, { name: "NestedSDK" })
		const client = result.files["client.py"]
		/* RED: current codegen emits single-level resource classes only */
		expect(client).toContain("class _CheckoutResource")
		expect(client).toContain("class _CheckoutSessionsResource")
		expect(client).toContain("class _UsersResource")
		/* _CheckoutResource.__init__ assigns self.sessions */
		expect(client).toMatch(/class _CheckoutResource[\s\S]*?self\.sessions\s*=\s*_CheckoutSessionsResource/)
		/* _CheckoutSessionsResource has create method */
		expect(client).toMatch(/class _CheckoutSessionsResource[\s\S]*?def create\s*\(/)
	})

	/* T28: mixed depth class — _UsersResource has both list method and profile attribute */
	it("T28 mixed depth: _UsersResource exposes both list() method and profile sub-resource", () => {
		const spec = loadFixture("nested")
		const result = generatePythonSDK(spec, { name: "NestedSDK" })
		const client = result.files["client.py"]
		/* RED: flat codegen has no profile attribute on _UsersResource */
		expect(client).toMatch(/class _UsersResource[\s\S]*?self\.profile\s*=\s*_UsersProfileResource/)
		expect(client).toMatch(/class _UsersResource[\s\S]*?def list\s*\(/)
	})

	/* T29: single-segment Python top-level */
	it("T29 single-segment getUser produces def get_user directly on AsyncSDK and SDK", () => {
		const singleSegSpec = makeSpec({
			"/users/{id}": {
				get: {
					operationId: "getUser",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: { type: "object" } } } },
					},
				},
			},
		})
		const result = generatePythonSDK(singleSegSpec, { name: "TestSDK" })
		const client = result.files["client.py"]
		/* RED: single-segment may be placed incorrectly or wrapped in resource class */
		/* AsyncSDK class must contain def get_user directly */
		expect(client).toMatch(/class AsyncSDK[\s\S]*?def get_user\s*\(/)
		/* SDK sync class must also contain it */
		expect(client).toMatch(/class SDK[\s\S]*?def get_user\s*\(/)
		/* must NOT be inside a resource class wrapper */
		expect(client).not.toMatch(/class _GetUserResource/)
	})

	/* T30: AsyncSDK / SDK init cascade */
	it("T30 AsyncSDK.__init__ assigns self.checkout = _CheckoutResource; cascade happens inside that class", () => {
		const spec = loadFixture("nested")
		const result = generatePythonSDK(spec, { name: "NestedSDK" })
		const client = result.files["client.py"]
		/* RED: current init only sets top-level 2-seg resources */
		/* AsyncSDK sets top-level namespace only */
		expect(client).toMatch(/class AsyncSDK[\s\S]*?self\.checkout\s*=\s*_CheckoutResource\s*\(/)
		/* cascade: _CheckoutResource sets self.sessions */
		expect(client).toMatch(/class _CheckoutResource[\s\S]*?self\.sessions\s*=\s*_CheckoutSessionsResource\s*\(/)
	})

	/* T31: existing Python fixture tests still pass — regression guard */
	it("T31 existing 2-seg crud fixture still produces _UsersResource (regression guard)", () => {
		const crudSpec = loadFixture("crud")
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		/* existing behavior: _UsersResource class must still be emitted */
		expect(client).toContain("class _UsersResource")
	})

	/* T32: collision throws */
	it("T32 generatePythonSDK on collision spec throws IR error with both ids", () => {
		expect(() => generatePythonSDK(collisionSpec, { name: "TestSDK" })).toThrow(
			/operationId conflict.*users\.create.*users\.create\.draft|operationId conflict.*users\.create\.draft.*users\.create/,
		)
	})
})
