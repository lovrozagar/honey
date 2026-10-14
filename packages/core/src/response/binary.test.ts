import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type HoneyServer, serve } from "../adapters/node/serve.ts"
import { honey } from "../routing/app.ts"
import { isHoneyResponse, rawBodyOf } from "./builder.ts"
import { HoneyRes } from "./response.ts"

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

/** Serve `app` on a free loopback port; the base URL to reach it. */
async function listen(app: { fetch(request: Request, env: {}): Response | Promise<Response> }): Promise<string> {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** `n` bytes counting up from 0, wrapping at 256. */
const counting = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 256)

/** The status, content type and bytes of an answer. */
async function bytesOf(response: Response): Promise<[number, string | null, number[]]> {
	return [response.status, response.headers.get("content-type"), [...new Uint8Array(await response.arrayBuffer())]]
}

describe("ctx.res.binary: bytes as they were given", () => {
	// v0: 8ed9b6b01a
	// v0: 6e390a38f0
	// v0: 90e66edc0c
	// v0: f6d5e7fc0f
	// v0: dacab447be
	// v0: 79d2385579
	it("answers application/octet-stream with the exact bytes of a Uint8Array, an ArrayBuffer or none", async () => {
		for (const res of [new HoneyRes(), new HoneyRes(true)]) {
			const answers = await Promise.all(
				[res.binary("ok", counting(3)), res.binary("ok", counting(4).buffer), res.binary("ok", new Uint8Array(0))].map(
					bytesOf,
				),
			)
			expect(answers).toEqual([
				[200, "application/octet-stream", [0, 1, 2]],
				[200, "application/octet-stream", [0, 1, 2, 3]],
				[200, "application/octet-stream", []],
			])
		}
	})

	it("keeps the bytes as its raw body, without a copy, on the native and the Node path", () => {
		const bytes = counting(8)
		const [native, node] = [new HoneyRes().binary("ok", bytes), new HoneyRes(true).binary("ok", bytes)]
		expect([rawBodyOf(native) === bytes, rawBodyOf(node) === bytes, isHoneyResponse(node)]).toEqual([true, true, true])
	})

	// v0: b984675043
	it("answers each status key's code", () => {
		const res = new HoneyRes()
		expect(
			(["ok", "created", "accepted", "bad_request"] as const).map((key) => res.binary(key, counting(1)).status),
		).toEqual([200, 201, 202, 400])
	})
})

describe("ctx.res.binary: the content type and the options", () => {
	it("answers the content type it is given, a declared open media type", async () => {
		for (const res of [new HoneyRes(), new HoneyRes(true)]) {
			const gif = res.binary("ok", counting(2), { contentType: "image/gif" })
			expect(await bytesOf(gif)).toEqual([200, "image/gif", [0, 1]])
		}
	})

	// v0: 1343f7a649
	// v0: 3b3a3b34f5
	it("adds headers and cookies beside its content type; one answer's options never reach the next", async () => {
		for (const res of [new HoneyRes(), new HoneyRes(true)]) {
			const dressed = res.binary("ok", counting(3), {
				contentType: "font/woff2",
				cookies: { token: { value: "abc" } },
				headers: { "x-req-id": "42" },
			})
			const plain = res.binary("ok", counting(1))
			expect([
				dressed.headers.get("content-type"),
				dressed.headers.get("x-req-id"),
				dressed.headers.getSetCookie(),
				(await bytesOf(dressed))[2],
				Object.fromEntries(plain.headers),
			]).toEqual(["font/woff2", "42", ["token=abc"], [0, 1, 2], { "content-type": "application/octet-stream" }])
		}
	})
})

describe("ctx.res.binary on the wire", () => {
	// v0: 2b6091c2f4
	// v0: 56a59c4e16
	// v0: 53d0c13436
	it("1MB arrives byte for byte, its content length the byte length, beside every other helper", async () => {
		const megabyte = counting(1024 * 1024)
		const app = honey<{}>()
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", megabyte))
		app.get("/gif").handler((ctx) => ctx.res.binary("created", counting(5), { contentType: "image/gif" }))
		app.get("/json").handler((ctx) => ctx.res.json("ok", { type: "json" }))
		app.get("/text").handler((ctx) => ctx.res.text("ok", "plain text"))
		app.get("/html").handler((ctx) => ctx.res.html("ok", "<b>bold</b>"))
		app.get("/csv").handler((ctx) => ctx.res.csv("ok", "a,b\n1,2"))
		app.get("/xml").handler((ctx) => ctx.res.xml("ok", "<root/>"))
		const base = await listen(app)
		const [bin, gif] = await Promise.all([fetch(`${base}/bin`), fetch(`${base}/gif`)])
		const others = await Promise.all(
			["/json", "/text", "/html", "/csv", "/xml"].map(async (path) => {
				const res = await fetch(`${base}${path}`)
				return [res.headers.get("content-type"), await res.text()]
			}),
		)
		const received = new Uint8Array(await bin.arrayBuffer())
		expect([
			bin.status,
			bin.headers.get("content-length"),
			received.length,
			received.every((byte, i) => byte === i % 256),
			await bytesOf(gif),
			others,
		]).toEqual([
			200,
			"1048576",
			1024 * 1024,
			true,
			[201, "image/gif", [0, 1, 2, 3, 4]],
			[
				["application/json", '{"type":"json"}'],
				["text/plain; charset=utf-8", "plain text"],
				["text/html; charset=utf-8", "<b>bold</b>"],
				["text/csv; charset=utf-8", "a,b\n1,2"],
				["application/xml", "<root/>"],
			],
		])
	})
})

describe("ctx.res.binary under .output() with outputValidation on", () => {
	// v0: 2f87e31195
	it("bytes are a type contract: a declared schema never runs, and the declared type is what is answered", async () => {
		const validate = vi.fn(() => ({ issues: [{ message: "never" }] }))
		const app = honey<{}>().logger(false).outputValidation("always")
		app
			.get("/bin")
			.output({ "application/octet-stream": { ok: { "~standard": { validate, vendor: "test", version: 1 } } } })
			.handler((ctx) => ctx.res.binary("ok", counting(2)))
		app
			.get("/gif")
			.output({ "image/gif": { ok: true } })
			.handler((ctx) => ctx.res.binary("ok", counting(2), { contentType: "image/gif" }))
		app
			.get("/wrong")
			.output({ "image/gif": { ok: true } })
			.handler((ctx) => ctx.res.binary("ok", counting(2), { contentType: "image/png" as "image/gif" }))
		const wrong = await app.fetch(new Request("http://localhost/wrong"), {})
		expect([
			await bytesOf(await app.fetch(new Request("http://localhost/bin"), {})),
			await bytesOf(await app.fetch(new Request("http://localhost/gif"), {})),
			[wrong.status, ((await wrong.json()) as { error_key: string }).error_key],
			validate.mock.calls.length,
		]).toEqual([
			[200, "application/octet-stream", [0, 1]],
			[200, "image/gif", [0, 1]],
			[500, "output_content_type_mismatch"],
			0,
		])
	})
})
