import { describe, expect, expectTypeOf, it } from "vitest"
import type { ReadableStreamSchema } from "../../../src/input.ts"
import { readableStream } from "../../../src/input.ts"

const fakeSchema = {
	parse: (x: unknown) => x,
	"~standard": { vendor: "zod", version: 1 },
}

describe("readableStream", () => {
	it("returns object with _tag: readableStream and schema reference", () => {
		const result = readableStream(fakeSchema)
		expect(result._tag).toBe("readableStream")
		expect(result.schema).toBe(fakeSchema)
	})

	it("schema reference is same object (not cloned)", () => {
		const result = readableStream(fakeSchema)
		expect(result.schema).toBe(fakeSchema)
	})

	it("multiple calls return distinct wrapper objects", () => {
		const a = readableStream(fakeSchema)
		const b = readableStream(fakeSchema)
		expect(a).not.toBe(b)
	})
})

describe("type-level", () => {
	it("ReadableStreamSchema carries schema type", () => {
		const r = readableStream(fakeSchema)
		expectTypeOf(r).toMatchTypeOf<ReadableStreamSchema<typeof fakeSchema>>()
		expectTypeOf(r._tag).toEqualTypeOf<"readableStream">()
	})

	it("_tag is readonly", () => {
		expectTypeOf<ReadableStreamSchema<typeof fakeSchema>["_tag"]>().toEqualTypeOf<"readableStream">()
	})
})
