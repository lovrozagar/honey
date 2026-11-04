/**
 * What the TanStack Query adapter's emitter writes (bit 22): the vendored source with its honey imports
 * pointed at the emitted runtime, and the two nested key trees the file's mapped types narrow by. The
 * adapter's behavior is `tanstack-query.behavior.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { tanstackQuerySource, tanstackQueryText } from "./tanstack-query.ts"

type Json = Record<string, unknown>

const ir = (paths: Json) =>
	toIR({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths } as OpenApiDocument, {
		deriveOperationIds: true,
	})

const json = () => ({ content: { "application/json": { schema: { type: "object" } } }, description: "" })
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

/* two deep on purpose: the trees and the mapped types both have to nest */
const document = {
	"/orgs": {
		get: { operationId: "org.list", responses: { 200: json() } },
		post: { operationId: "org.create", responses: { 201: json() }, "x-invalidate": ["GET /orgs"] },
	},
	"/orgs/{org_id}/members": {
		get: { operationId: "org.member.list", parameters: [param("org_id")], responses: { 200: json() } },
		post: {
			operationId: "org.member.add",
			parameters: [param("org_id")],
			responses: { 201: json() },
			"x-invalidate": ["GET /orgs/{org_id}/members"],
		},
	},
	/* an event stream is declared by its media type, which is how the IR reads one */
	"/events": {
		get: {
			operationId: "events.watch",
			responses: { 200: { content: { "text/event-stream": {} }, description: "" } },
		},
	},
}

describe("tanstackQuerySource: the vendored adapter, pointed at the emitted runtime", () => {
	const source = tanstackQuerySource("api.runtime.gen")

	it("rewrites honey's runtime imports to the emitted runtime module", () => {
		expect(source).toContain('from "./api.runtime.gen.js"')
		expect(source).not.toContain('from "../ts/sdk.ts"')
	})

	it("drops the imports its own modules make of each other, since they are now one file", () => {
		expect(source).not.toContain('from "./invalidate.ts"')
		expect(source).toContain("export function invalidatedBy")
		expect(source).toContain("export function queryHelpers")
	})

	it("leaves query-core alone, and type-only: an emitted file is loaded from the consumer's tree", () => {
		expect(source).toContain("import type {")
		expect(source).toContain('from "@tanstack/query-core"')
		expect(source).not.toMatch(/^import \{[^}]*\} from "@tanstack\/query-core"/m)
	})

	it("names each imported symbol once, however many modules asked for it", () => {
		const lines = source.split("\n").filter((line) => line.includes('from "@tanstack/query-core"'))
		expect(lines).toHaveLength(1)
		const runtime = source.split("\n").filter((line) => line.includes('from "./api.runtime.gen.js"'))
		expect(runtime).toHaveLength(1)
		expect(runtime[0]).toContain("ServiceEntry")
		expect(runtime[0]).toContain("ServiceMap")
	})
})

describe("tanstackQueryText: the key trees come from the service map, not from method names", () => {
	const text = tanstackQueryText(ir(document), "Shop", "api")

	it("puts every GET in the query tree, nested as the client nests", () => {
		expect(text).toContain("type TanstackQueryTree = {")
		expect(text).toMatch(/org: \{[^}]*list: 1/s)
		expect(text).toMatch(/member: \{[^}]*list: 1/s)
	})

	it("puts every write in the mutation tree", () => {
		expect(text).toContain("type TanstackMutationTree = {")
		expect(text).toMatch(/TanstackMutationTree = \{[\s\S]*?create: 1/)
		expect(text).toMatch(/TanstackMutationTree = \{[\s\S]*?add: 1/)
	})

	it("leaves an event stream out of both trees", () => {
		const trees = text.slice(text.indexOf("type TanstackQueryTree"))
		expect(trees).not.toContain("watch")
	})

	it("leaves a resource with no write of its own out of the mutation tree, not in it and empty", () => {
		const mutations = text.slice(text.indexOf("type TanstackMutationTree"))
		const onlyRead = tanstackQueryText(
			ir({ "/ping": { get: { operationId: "health.ping", responses: { 200: json() } } } }),
			"Shop",
			"api",
		)
		expect(mutations).toContain("create: 1")
		/* no write anywhere: the tree is empty rather than a shell of empty resources */
		expect(onlyRead).toContain("type TanstackMutationTree = {}")
		expect(onlyRead).not.toMatch(/TanstackMutationTree = \{\s*health/)
	})

	it("imports the client's own map and class, and exports the one entry point", () => {
		expect(text).toContain('import { serviceMap } from "./api.map.gen.js"')
		expect(text).toContain('from "./api.client.gen.js"')
		expect(text).toContain("export function createQueryHelpers")
		/* the name heads every key, so it is baked in rather than passed */
		expect(text).toContain('"Shop"')
	})
})
