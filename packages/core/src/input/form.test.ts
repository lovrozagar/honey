import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
import { formInput } from "./form.ts"

/** A POST carrying `body` as an urlencoded form. */
const urlencoded = (body: string) =>
	new Request("http://localhost/", {
		body,
		headers: { "content-type": "application/x-www-form-urlencoded" },
		method: "POST",
	})

/** A POST carrying `form` as multipart. */
const multipart = (form: FormData) => new Request("http://localhost/", { body: form, method: "POST" })

/** A schema that accepts anything and returns it. */
const passing = { "~standard": { validate: (value: unknown) => ({ value }), vendor: "test", version: 1 } }

/** The error `run` rejects with. */
async function rejected(run: () => Promise<unknown>): Promise<HoneyError> {
	try {
		await run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not reject")
}

describe("formInput: an urlencoded body", () => {
	// v0: e1bda06bdf
	// v0: 188da40a3f
	// v0: 4874856aca
	it("is read as fields: + is a space, an empty key kept", async () => {
		expect({
			...((await formInput(
				passing,
				urlencoded("name=hello&age=25&greeting=hello+world&=emptykey"),
				"urlencoded",
			)) as object),
		}).toEqual({
			"": "emptykey",
			age: "25",
			greeting: "hello world",
			name: "hello",
		})
	})

	// v0: aeed03b696
	// v0: e0ef139acb
	it("follows the search policy for repeated keys", async () => {
		const schema = z.object({ role: z.string(), tags: z.array(z.string()) })
		expect([
			await formInput(schema, urlencoded("role=user&role=admin&tags=a"), "urlencoded"),
			{ ...((await formInput(passing, urlencoded("tag=first&tag=second"), "urlencoded")) as object) },
		]).toEqual([{ role: "user", tags: ["a"] }, { tag: ["first", "second"] }])
	})

	// v0: faf85a3afa
	it("reads 5000 fields", async () => {
		const body = Array.from({ length: 5000 }, (_, i) => `f${i}=v${i}`).join("&")
		expect(Object.keys((await formInput(passing, urlencoded(body), "urlencoded")) as object)).toHaveLength(5000)
	})
})

describe("formInput: a multipart body", () => {
	// v0: 4fce27d6f8
	// v0: b32135787a
	it("is read as fields and files; an array field gets an array for one file or many", async () => {
		const schema = z.object({ files: z.array(z.instanceof(File)), name: z.string() })
		const one = new FormData()
		one.append("name", "Alice")
		one.append("files", new File(["a"], "a.txt"))
		const two = new FormData()
		two.append("name", "Bob")
		two.append("files", new File(["a"], "a.txt"))
		two.append("files", new File(["b"], "b.txt"))
		const [first, second] = [
			(await formInput(schema, multipart(one), "multipart")) as { files: File[]; name: string },
			(await formInput(schema, multipart(two), "multipart")) as { files: File[]; name: string },
		]
		expect([first.name, first.files.map((f) => f.name), second.files.map((f) => f.name)]).toEqual([
			"Alice",
			["a.txt"],
			["a.txt", "b.txt"],
		])
	})

	// v0: f1513012e5
	it("a broken multipart body is a 400 malformed_body", async () => {
		const broken = new Request("http://localhost/", {
			body: "--x\r\nnot a part",
			headers: { "content-type": "multipart/form-data; boundary=x" },
			method: "POST",
		})
		const error = await rejected(() => formInput(passing, broken, "multipart"))
		expect([error.status, error.errorKey, error.vars]).toEqual([400, "malformed_body", { format: "multipart" }])
	})
})

describe("formInput: dangerous keys", () => {
	// v0: 21c0fcb869
	// v0: 815fdb0bc2
	// v0: 1e48af5c6f
	// v0: 456f94cfeb
	// v0: dbf8eabd0b
	// v0: 625e8203d5
	// v0: 42722b87d7
	// v0: 316b370201
	// v0: 7e590cf653
	// v0: a8866954c8
	// v0: 4f4ef87777
	it("drops __proto__, constructor and prototype from either encoding, keeps everything else, pollutes nothing", async () => {
		const fd = new FormData()
		for (const [key, value] of [
			["__proto__", '{"polluted":true}'],
			["constructor", "evil"],
			["prototype", "x"],
			["my__proto__field", "safe"],
			["name", "Alice"],
		])
			fd.append(key as string, value as string)
		const parts = (await formInput(passing, multipart(fd), "multipart")) as object
		const encoded = (await formInput(
			passing,
			urlencoded("__proto__=a&constructor=b&prototype=c&normal=value"),
			"urlencoded",
		)) as object
		expect([
			Object.keys(parts),
			Object.keys(encoded),
			Object.getPrototypeOf(parts),
			({} as Record<string, unknown>).polluted,
		]).toEqual([["my__proto__field", "name"], ["normal"], null, undefined])
	})
})
