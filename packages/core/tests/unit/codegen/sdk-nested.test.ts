import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ---- helpers ---- */

function loadFixture(lang: string, name: string): Record<string, unknown> {
	const url = new URL(`./fixtures/${lang}/${name}.json`, import.meta.url)
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
describe("SDK codegen — nested operationId support (T13–T19)", () => {
	/* T13: nested serviceMap object literal — 3-segment */
	it("T13 nested serviceMap contains checkout.sessions.create nested literal", () => {
		const spec = loadFixture("sdk", "nested")
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/* RED: current codegen emits flat byResource; nested literal does not exist */
		/* Assert structural shape: checkout: { sessions: { create: { method: "POST" ... } } } */
		expect(files.map).toMatch(
			/checkout\s*:\s*\{[^}]*sessions\s*:\s*\{[^}]*create\s*:\s*\{[^}]*method\s*:\s*["']POST["']/s,
		)
	})

	/* T14: mixed depth in serviceMap — users has both list leaf and profile sub-namespace */
	it("T14 mixed depth serviceMap: users has both list leaf and profile sub-namespace", () => {
		const spec = loadFixture("sdk", "nested")
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/* RED: flat codegen cannot produce nested profile namespace */
		expect(files.map).toMatch(/users\s*:\s*\{[^}]*list\s*:\s*\{[^}]*method\s*:\s*["']GET["']/s)
		expect(files.map).toMatch(/profile\s*:\s*\{[^}]*update\s*:\s*\{[^}]*method\s*:\s*["']PATCH["']/s)
	})

	/* T15: single-segment top-level in serviceMap */
	it("T15 single-segment getStatus appears at root of serviceMap without resource wrapper", () => {
		const spec = loadFixture("sdk", "nested")
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/* RED: getStatus has no dot → must be a direct leaf at root, not nested under resource */
		expect(files.map).toMatch(/getStatus\s*:\s*\{[^}]*method\s*:\s*["']GET["']/s)
	})

	/* T16: recursive interface emission — nested interface bodies */
	it("T16 types file contains nested interface bodies for 3-segment and mixed depth ops", () => {
		const spec = loadFixture("sdk", "nested")
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/* RED: flat codegen emits top-level resource interfaces only */
		/* 3-segment: checkout.sessions interface nesting */
		expect(files.types).toMatch(/checkout\s*:\s*\{/s)
		expect(files.types).toMatch(/sessions\s*:\s*\{/s)
		/* mixed depth: profile sub-namespace within users */
		expect(files.types).toMatch(/profile\s*:\s*\{/s)
		/* single-segment: getStatus directly callable, not under resource wrapper */
		expect(files.types).toMatch(/getStatus\s*\(/)
	})

	/* T17: re-throws IR collision */
	it("T17 generateSDK re-throws IR collision error with both opIds named", () => {
		expect(() => generateSDK(collisionSpec, { name: "TestSDK" })).toThrow(
			/operationId conflict.*users\.create.*users\.create\.draft|operationId conflict.*users\.create\.draft.*users\.create/,
		)
	})

	/* T18: existing 2-seg fixtures still produce correct serviceMap */
	it("T18 existing 2-segment spec serviceMap shape is unchanged (regression guard)", () => {
		const twoSegSpec = makeSpec({
			"/v1/items": {
				get: {
					operationId: "items.list",
					responses: {
						"200": { content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } },
					},
				},
			},
		})
		const { files } = generateSDK(twoSegSpec, { name: "TestSDK" })
		/* items resource must still exist at top level of serviceMap */
		expect(files.map).toMatch(/items\s*:\s*\{/)
		/* list method entry must exist */
		expect(files.map).toMatch(/list\s*:\s*\{[^}]*method\s*:\s*["']GET["']/s)
	})

	/* T19: single-segment _call promotion preserved */
	it("T19 single-segment operationId getUser produces top-level callable in types (no resource wrapper)", () => {
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
		const { files } = generateSDK(singleSegSpec, { name: "TestSDK" })
		/* getUser must be a method directly on the SDK interface, not sdk.getUser.something */
		expect(files.types).toMatch(/getUser\s*\(/)
		/* must NOT be wrapped in a resource namespace object */
		expect(files.types).not.toMatch(/getUser\s*:\s*\{/)
	})
})
