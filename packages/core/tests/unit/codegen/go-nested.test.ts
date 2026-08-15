import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoSDK } from "../../../src/codegen-go.ts"

/* ---- helpers ---- */

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`./fixtures/go/${name}.json`, import.meta.url)
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
describe("Go SDK codegen — nested operationId support (T33–T38)", () => {
	/* T33: nested struct fields on Client */
	it("T33 nested structs: Client has Checkout and Users fields; nested resource structs emitted", () => {
		const spec = loadFixture("nested")
		const result = generateGoSDK(spec, {})
		const client = result.files["client.go"]
		/* RED: current codegen emits single-level resource structs only */
		/* Client struct must have Checkout and Users pointer fields */
		expect(client).toMatch(/type Client struct[\s\S]*?Checkout\s+\*CheckoutResource/)
		expect(client).toMatch(/type Client struct[\s\S]*?Users\s+\*UsersResource/)
		/* CheckoutResource must have Sessions field */
		expect(client).toMatch(/type CheckoutResource struct[\s\S]*?Sessions\s+\*CheckoutSessionsResource/)
		/* CheckoutSessionsResource must be defined */
		expect(client).toContain("type CheckoutSessionsResource struct")
		/* Create method on CheckoutSessionsResource */
		expect(client).toMatch(/func\s*\(\s*\w+\s*\*CheckoutSessionsResource\s*\)\s*Create\s*\(/)
	})

	/* T34: mixed depth Go — UsersResource has both Profile field and List method */
	it("T34 mixed depth: UsersResource has Profile *UsersProfileResource field AND List method", () => {
		const spec = loadFixture("nested")
		const result = generateGoSDK(spec, {})
		const client = result.files["client.go"]
		/* RED: flat codegen has no Profile field on UsersResource */
		expect(client).toMatch(/type UsersResource struct[\s\S]*?Profile\s+\*UsersProfileResource/)
		expect(client).toMatch(/func\s*\(\s*\w+\s*\*UsersResource\s*\)\s*List\s*\(/)
	})

	/* T35: NewClient initializes nested fields */
	it("T35 NewClient body initializes Checkout and Sessions in a cascading pattern", () => {
		const spec = loadFixture("nested")
		const result = generateGoSDK(spec, {})
		const client = result.files["client.go"]
		/* RED: NewClient only sets single-level fields currently */
		/* Must initialize CheckoutResource with Sessions sub-field */
		expect(client).toMatch(/CheckoutSessionsResource|newCheckoutSessionsResource|CheckoutSessions/)
		/* NewClient must reference CheckoutResource initialization */
		expect(client).toMatch(/func NewClient[\s\S]*?Checkout/)
	})

	/* T36: single-segment Go top-level */
	it("T36 single-segment getUser produces func (c *Client) GetUser on *Client directly", () => {
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
		const result = generateGoSDK(singleSegSpec, {})
		const client = result.files["client.go"]
		/* RED: single-segment may be incorrectly wrapped in a resource struct */
		expect(client).toMatch(/func\s*\(\s*\w+\s*\*Client\s*\)\s*GetUser\s*\(/)
		/* must NOT produce a GetUserResource struct */
		expect(client).not.toMatch(/type GetUserResource struct/)
	})

	/* T37: existing Go fixture tests still pass */
	it("T37 existing 2-seg crud fixture still produces UsersResource and List method (regression)", () => {
		const crudSpec = loadFixture("crud")
		const result = generateGoSDK(crudSpec, {})
		const client = result.files["client.go"]
		/* existing behavior preserved */
		expect(client).toContain("UsersResource")
		expect(client).toMatch(/func\s*\(\s*\w+\s*\*UsersResource\s*\)\s*List\s*\(/)
	})

	/* T38: collision throws */
	it("T38 generateGoSDK on collision spec throws IR error with both ids", () => {
		expect(() => generateGoSDK(collisionSpec, {})).toThrow(
			/operationId conflict.*users\.create.*users\.create\.draft|operationId conflict.*users\.create\.draft.*users\.create/,
		)
	})
})
