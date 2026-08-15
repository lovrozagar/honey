import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateRustSDK } from "../../../src/codegen-rust.ts"

/* ---- helpers ---- */

function loadFixture(name: string, dir = "rust"): Record<string, unknown> {
	const url = new URL(`./fixtures/${dir}/${name}.json`, import.meta.url)
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
describe("Rust SDK codegen — nested operationId support (T39–T44)", () => {
	/* T39: nested mod hierarchy */
	it("T39 nested mod hierarchy: resources/mod.rs has pub mod checkout and pub mod users", () => {
		const spec = loadFixture("nested")
		const result = generateRustSDK(spec, {})
		const files = result.files
		/* RED: current codegen emits single-level resource mods only */
		const resourcesMod = files["src/resources/mod.rs"]
		expect(resourcesMod).toBeDefined()
		expect(resourcesMod).toContain("pub mod checkout")
		expect(resourcesMod).toContain("pub mod users")

		/* checkout namespace must declare sessions sub-mod */
		const checkoutMod =
			files["src/resources/checkout/mod.rs"] ?? files["src/resources/checkout.rs"]
		expect(checkoutMod).toBeDefined()
		expect(checkoutMod).toMatch(/pub mod sessions|pub struct CheckoutResource/)

		/* sessions resource must expose create method */
		const sessionsMod =
			files["src/resources/checkout/sessions.rs"] ??
			files["src/resources/checkout_sessions.rs"]
		expect(sessionsMod).toBeDefined()
		expect(sessionsMod).toMatch(/pub fn create\s*\(|pub async fn create\s*\(/)
	})

	/* T40: mixed depth Rust */
	it("T40 mixed depth: UsersResource has pub fn list and pub fn profile accessor returning UsersProfileResource", () => {
		const spec = loadFixture("nested")
		const result = generateRustSDK(spec, {})
		const files = result.files

		/* RED: flat codegen has no profile accessor on UsersResource */
		const usersMod =
			files["src/resources/users/mod.rs"] ?? files["src/resources/users.rs"]
		expect(usersMod).toBeDefined()
		/* list method directly on UsersResource */
		expect(usersMod).toMatch(/pub fn list\s*\(|pub async fn list\s*\(/)
		/* profile accessor returning UsersProfileResource (or field) */
		expect(usersMod).toMatch(/UsersProfileResource|users_profile/)
	})

	/* T41: Client struct holds top-level fields */
	it("T41 Client struct holds checkout and users fields with accessor methods", () => {
		const spec = loadFixture("nested")
		const result = generateRustSDK(spec, {})
		const clientRs = result.files["src/client.rs"] ?? result.files["src/lib.rs"]
		expect(clientRs).toBeDefined()
		/* RED: single-level codegen only emits top-level 2-seg resources */
		/* Client must have checkout and users fields or accessor methods */
		expect(clientRs).toMatch(/checkout\s*:|pub fn checkout|CheckoutResource/)
		expect(clientRs).toMatch(/users\s*:|pub fn users|UsersResource/)
	})

	/* T42: single-segment Rust top-level */
	it("T42 single-segment getUser produces pub fn get_user on impl Client directly", () => {
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
		const result = generateRustSDK(singleSegSpec, {})
		const allSrc = Object.values(result.files).join("\n")
		/* RED: single-segment may be wrapped in a resource mod */
		expect(allSrc).toMatch(/pub fn get_user\s*\(|pub async fn get_user\s*\(/)
		/* must NOT produce a get_user module */
		expect(allSrc).not.toMatch(/pub mod get_user/)
	})

	/* T43: existing Rust fixture tests still pass */
	it("T43 existing 2-seg realtime fixture still produces UsersResource (regression)", () => {
		const realtimeSpec = loadFixture("realtime")
		const result = generateRustSDK(realtimeSpec, {})
		const allSrc = Object.values(result.files).join("\n")
		/* realtime.json has users.list — UsersResource must still be produced */
		expect(allSrc).toMatch(/UsersResource/)
	})

	/* T44: collision throws */
	it("T44 generateRustSDK on collision spec throws IR error with both ids", () => {
		expect(() => generateRustSDK(collisionSpec, {})).toThrow(
			/operationId conflict.*users\.create.*users\.create\.draft|operationId conflict.*users\.create\.draft.*users\.create/,
		)
	})
})
