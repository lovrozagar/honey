import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../routing/app.ts"
import { bodyLimit } from "./body-limit.ts"
import { binaryInput } from "./binary.ts"

/** A POST of `body` to `path` with `type` as its Content-Type, or none. */
function post(path: string, body: BodyInit | null, type?: string): Request {
	return new Request(`http://localhost${path}`, {
		body,
		headers: type === undefined ? {} : { "content-type": type },
		method: "POST",
	})
}

/** Bytes 0, 1, … 255, 0, 1, … for `size` bytes. */
function counting(size: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(size)
	for (let i = 0; i < size; i++) bytes[i] = i % 256
	return bytes
}

/** An app whose /upload takes `types` as binary and answers the size, a checksum and the type it got. */
function uploads(types: string | readonly string[]) {
	const app = honey<{}>()
	app
		.post("/upload")
		.input({ binary: types as never })
		.handler((ctx) => {
			const { bytes, type } = (ctx.input as { binary: { bytes: Uint8Array; type: string } }).binary
			return ctx.res.json("ok", { size: bytes.byteLength, sum: bytes.reduce((s, b) => (s + b) % 65_521, 0), type })
		})
	return app
}

/** The status and JSON body of an answer. */
async function answer(res: Response | Promise<Response>): Promise<[number, unknown]> {
	const r = await res
	return [r.status, await r.json()]
}

describe("binaryInput: the body read once as bytes", () => {
	it("hands over every byte as sent, with the media type the request carried", async () => {
		const sent = counting(70_000)
		const got = await binaryInput(post("/u", sent, "image/png"), "image/png")
		expect([
			got.type,
			got.bytes instanceof Uint8Array,
			got.bytes.byteLength,
			got.bytes.every((b, i) => b === i % 256),
		]).toEqual(["image/png", true, 70_000, true])
	})

	it("an empty body is zero bytes, not a failure", async () => {
		expect(
			(await binaryInput(post("/u", null, "application/octet-stream"), "application/octet-stream")).bytes.byteLength,
		).toBe(0)
	})
})

describe(".input({ binary }): the declared media types", () => {
	it("takes a body of a declared type, matched by essence whatever its case or parameters", async () => {
		const app = uploads(["image/png", "image/jpeg"])
		const bytes = counting(1000)
		const sum = bytes.reduce((s, b) => (s + b) % 65_521, 0)
		expect([
			await answer(app.fetch(post("/upload", bytes, "image/png"), {})),
			await answer(app.fetch(post("/upload", bytes, "Image/JPEG; quality=90"), {})),
		]).toEqual([
			[200, { size: 1000, sum, type: "image/png" }],
			[200, { size: 1000, sum, type: "image/jpeg" }],
		])
	})

	it("a type/* range takes any subtype of its type, and ctx.input names the one sent", async () => {
		const app = uploads("image/*")
		expect([
			(await answer(app.fetch(post("/upload", counting(3), "image/gif"), {})))[1],
			(await app.fetch(post("/upload", counting(3), "text/plain"), {})).status,
		]).toEqual([{ size: 3, sum: 3, type: "image/gif" }, 415])
	})

	it("answers 415 for another type, a malformed one, or none, before reading the body", async () => {
		const app = uploads(["image/png"])
		const statuses = await Promise.all(
			[
				post("/upload", "x", "image/jpeg"),
				post("/upload", "x", "image/pngx"),
				post("/upload", "x", "png"),
				post("/upload", "x"),
			].map(async (req) => {
				const res = await app.fetch(req, {})
				return [res.status, req.bodyUsed]
			}),
		)
		expect(statuses).toEqual([
			[415, false],
			[415, false],
			[415, false],
			[415, false],
		])
	})
})

describe(".input({ binary }): at registration", () => {
	it("refuses a binary body on a route only GET or HEAD reach", () => {
		expect(() => honey<{}>().get("/x").input({ binary: "image/png" })).toThrow(/GET \/x declares a binary body schema/)
	})

	it("refuses binary beside json or form: a request carries one body", () => {
		expect(() =>
			honey<{}>()
				.post("/x")
				.input({ binary: "image/png", json: z.object({}) } as never),
		).toThrow("POST /x declares more than one body (binary, json); a request carries one body.")
	})

	it.each(["png", "image/", "*/png", "*/*", "image/png; q=1", "", "image/png/x"])(
		"refuses %j as a declared type",
		(type) => {
			expect(() =>
				honey<{}>()
					.post("/x")
					.input({ binary: type as never }),
			).toThrow(/declares binary type/)
		},
	)
})

describe(".input({ binary }) beside the rest of the request", () => {
	it("is limited by bodyLimit like any body", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 100 }))
		app
			.post("/upload")
			.input({ binary: "application/octet-stream" })
			.handler((ctx) => ctx.res.json("ok", { size: ctx.input.binary.bytes.byteLength }))
		const send = (size: number) => app.fetch(post("/upload", counting(size), "application/octet-stream"), {})
		expect([await answer(send(100)), (await send(101)).status]).toEqual([[200, { size: 100 }], 413])
	})

	it("sits beside the non-body sources, and the handler finds the body already read", async () => {
		const app = honey<{}>()
		app
			.post("/upload/:name")
			.input({
				binary: "image/png",
				params: z.object({ name: z.string() }),
				search: z.object({ v: z.coerce.number() }),
			})
			.handler((ctx) =>
				ctx.res.json("ok", {
					name: ctx.input.params.name,
					size: ctx.input.binary.bytes.byteLength,
					used: ctx.req.bodyUsed,
					v: ctx.input.search.v,
				}),
			)
		expect(await answer(app.fetch(post("/upload/logo?v=2", counting(5), "image/png"), {}))).toEqual([
			200,
			{ name: "logo", size: 5, used: true, v: 2 },
		])
	})
})
