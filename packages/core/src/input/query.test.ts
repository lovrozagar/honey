import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
import { searchInput } from "./query.ts"

/** ctx.searchAll for `query`: every value per key, in request order, on a record with no prototype. */
function searchAll(query: string): Record<string, string[]> {
	const all: Record<string, string[]> = Object.create(null)
	for (const [key, value] of new URLSearchParams(query)) (all[key] ??= []).push(value)
	return all
}

/** A schema that accepts anything and returns it. */
const passing = { "~standard": { validate: (value: unknown) => ({ value }), vendor: "test", version: 1 } }

describe("searchInput: the query, validated", () => {
	// v0: 6486eadcb6
	// v0: 688483188e
	// v0: 4382026739
	it("hands the schema each key's value", () => {
		expect(searchInput(passing, searchAll("name=hello&q=1"))).toEqual({ name: "hello", q: "1" })
	})

	// v0: 001353fae8
	// v0: 911d808513
	// v0: 0dcd4a2d46
	// v0: ff232cfaf7
	it("an array key gets every value; coercion and defaults apply", () => {
		const schema = z.object({
			active: z.stringbool(),
			page: z.coerce.number().default(1),
			tags: z.string().array(),
		})
		expect([
			searchInput(schema, searchAll("tags=a&tags=b&tags=c&active=false")),
			searchInput(schema, searchAll("tags=x&active=true")),
		]).toEqual([
			{ active: false, page: 1, tags: ["a", "b", "c"] },
			{ active: true, page: 1, tags: ["x"] },
		])
	})

	// v0: 885d0ec225
	it("a missing required key is a 400 naming search.<name>", () => {
		let error: HoneyError | undefined
		try {
			searchInput(z.object({ q: z.string() }), searchAll(""))
		} catch (thrown) {
			error = thrown as HoneyError
		}
		expect([error?.status, error?.fields.q?.[0]?.path]).toEqual([400, "search.q"])
	})
})

describe("searchInput: dangerous keys and readableStream entries", () => {
	// v0: 4259eb4c23
	it("never hands the schema __proto__, constructor or prototype (H18.13), and keeps its prototype", () => {
		const seen: unknown[] = []
		const recording = {
			"~standard": {
				validate: (value: unknown) => {
					seen.push(value)
					return { value }
				},
				vendor: "test",
				version: 1,
			},
		}
		const out = searchInput(recording, searchAll("__proto__=a&__proto__=b&constructor=x&prototype=y&ok=1")) as object
		expect([Object.keys(seen[0] as object), Object.getPrototypeOf(out), ({} as Record<string, unknown>).a]).toEqual([
			["ok"],
			null,
			undefined,
		])
	})

	// v0: 17a60fd180
	// v0: 5ad44d5815
	it("without a schema (a readableStream entry) the parsed query passes unvalidated", () => {
		expect({ ...(searchInput(null, searchAll("tag=a&tag=b&x=1")) as object) }).toEqual({ tag: ["a", "b"], x: "1" })
	})
})
