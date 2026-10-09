import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import { bodyKind } from "../../../src/body-kind.ts"
import { HoneyRes } from "../../../src/response.ts"
import { timeout } from "../../../src/timeout.ts"

const decoder = new TextDecoder()
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const { value } = await reader.read()
	return decoder.decode(value)
}

describe("streams start on the first read", () => {
	it("sse, stream and generate run nothing until the body is read", async () => {
		const res = new HoneyRes()
		const ran: string[] = []
		const sse = res.sse(async () => {
			ran.push("sse")
		})
		const stream = res.stream(async () => {
			ran.push("stream")
		})
		function* gen() {
			ran.push("gen")
			yield "x"
		}
		const generated = res.generate(gen())
		await tick(5)
		expect(ran).toEqual([])
		await Promise.all([sse.text(), stream.text(), generated.text()])
		expect(ran.sort()).toEqual(["gen", "sse", "stream"])
	})

	it("HEAD on an SSE route never runs the callback and sends no body", async () => {
		const app = honey()
		let ran = false
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async () => {
				ran = true
			}),
		)
		const res = await app.fetch(new Request("http://localhost/events", { method: "HEAD" }), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/event-stream")
		expect(res.body).toBeNull()
		await tick(5)
		expect(ran).toBe(false)
	})

	it("HEAD keeps the content-length GET would send", async () => {
		const app = honey()
		app.get("/doc").handler((ctx) => ctx.res.json("ok", { hello: "wörld" }))
		const get = await app.fetch(new Request("http://localhost/doc"), {})
		const bytes = (await get.arrayBuffer()).byteLength
		const head = await app.fetch(new Request("http://localhost/doc", { method: "HEAD" }), {})
		expect(head.headers.get("content-length")).toBe(String(bytes))
		expect(head.body).toBeNull()
	})

	it("responses carry their body kind from creation", () => {
		const res = new HoneyRes()
		expect(bodyKind(res.json("ok", {}))).toBe("buffered")
		expect(bodyKind(res.noContent())).toBe("empty")
		expect(bodyKind(res.sse(async () => {}, { headers: { "content-length": "5" } }))).toBe("stream")
		expect(bodyKind(res.generate((function* () {})(), { contentType: "application/json" }))).toBe("stream")
		expect(bodyKind(res.stream(async () => {}))).toBe("stream")
		expect(bodyKind(new Response("x", { headers: { "content-length": "1" } }))).toBe("buffered")
		expect(bodyKind(new Response(new ReadableStream()))).toBe("stream")
	})
})

describe("cancellation reaches the producer", () => {
	it("cancelling an SSE body ends the callback's loop and clears keepalive", async () => {
		const res = new HoneyRes()
		const clear = vi.spyOn(globalThis, "clearInterval")
		let finished = false
		let signal: AbortSignal | undefined
		const response = res.sse(
			async (stream) => {
				signal = stream.signal
				try {
					for (;;) {
						await stream.send({ data: "x", event: "tick" })
						await tick(1)
					}
				} finally {
					finished = true
				}
			},
			{ defaultRetry: 1000, keepalive: 5 },
		)
		const reader = (response.body as ReadableStream<Uint8Array>).getReader()
		expect(await readChunk(reader)).toContain("retry: 1000")
		await reader.cancel()
		await tick(20)
		expect(finished).toBe(true)
		expect(signal?.aborted).toBe(true)
		expect(clear).toHaveBeenCalled()
		clear.mockRestore()
	})

	it("send() after the end rejects for an awaiting loop and never as an unhandled rejection", async () => {
		const res = new HoneyRes()
		let late: Promise<void> | undefined
		const response = res.sse(async (stream) => {
			await stream.send({ data: "first", event: "m" })
			await tick(10)
			/* the README pattern: close in a finally, then a stray unawaited send */
			stream.close()
			stream.close()
			late = stream.send({ data: "late", event: "m" })
		})
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		try {
			expect(await response.text()).toContain("data: first")
			await tick(20)
			await expect(late).rejects.toMatchObject({ name: "AbortError" })
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})

	it("cancelling a generate() body runs the generator's finally", async () => {
		const res = new HoneyRes()
		let finished = false
		async function* ticks() {
			try {
				for (let i = 0; ; i++) {
					yield `${i}\n`
					await tick(1)
				}
			} finally {
				finished = true
			}
		}
		const response = res.generate(ticks())
		const reader = (response.body as ReadableStream<Uint8Array>).getReader()
		expect(await readChunk(reader)).toBe("0\n")
		await reader.cancel()
		await tick(10)
		expect(finished).toBe(true)
	})

	it("cancelling a stream() body aborts the callback's signal and rejects its writes", async () => {
		const res = new HoneyRes()
		let aborted = false
		let writeError: unknown
		const response = res.stream(async (writable, signal) => {
			const writer = writable.getWriter()
			signal.addEventListener("abort", () => {
				aborted = true
			})
			try {
				for (;;) await writer.write("x")
			} catch (err) {
				writeError = err
				throw err
			}
		})
		const reader = (response.body as ReadableStream<Uint8Array>).getReader()
		expect(await readChunk(reader)).toBe("x")
		await reader.cancel()
		await tick(10)
		expect(aborted).toBe(true)
		expect(writeError).toBeDefined()
	})

	it("stream() flushes queued writes when the callback returns without closing", async () => {
		const res = new HoneyRes()
		const response = res.stream(async (writable) => {
			const writer = writable.getWriter()
			void writer.write("a")
			void writer.write("b")
			void writer.write("c")
		})
		expect(await response.text()).toBe("abc")
	})

	it("ctx.signal ending the request ends a running SSE stream", async () => {
		const app = honey()
		const ac = new AbortController()
		let finished = false
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				try {
					while (!stream.signal.aborted) {
						await stream.send({ data: "x", event: "t" })
						await tick(1)
					}
				} finally {
					finished = true
				}
			}),
		)
		const res = await app.fetch(new Request("http://localhost/events", { signal: ac.signal }), {})
		const reader = (res.body as ReadableStream<Uint8Array>).getReader()
		await readChunk(reader)
		ac.abort()
		/* the body ends cleanly: the client is gone, nothing failed */
		for (;;) {
			const { done } = await reader.read()
			if (done) break
		}
		await tick(5)
		expect(finished).toBe(true)
	})
})

describe("producer errors", () => {
	it("an SSE callback error is reported to the app logger and breaks the body", async () => {
		const app = honey()
		const error = vi.fn()
		app.logger({ debug() {}, error, info() {}, warn() {} } as never)
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "one", event: "m" })
				throw new Error("producer broke")
			}),
		)
		const res = await app.fetch(new Request("http://localhost/events"), {})
		const reader = (res.body as ReadableStream<Uint8Array>).getReader()
		expect(await readChunk(reader)).toContain("data: one")
		await expect(reader.read()).rejects.toThrow("producer broke")
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.objectContaining({ message: "producer broke" }) }),
			"stream producer failed",
		)
	})

	it("an abort the producer rethrows is not reported", async () => {
		const app = honey()
		const error = vi.fn()
		app.logger({ debug() {}, error, info() {}, warn() {} } as never)
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				for (;;) await stream.send({ data: "x", event: "t" })
			}),
		)
		const res = await app.fetch(new Request("http://localhost/events"), {})
		const reader = (res.body as ReadableStream<Uint8Array>).getReader()
		await readChunk(reader)
		await reader.cancel()
		await tick(10)
		expect(error).not.toHaveBeenCalled()
	})
})

describe("ctx.signal", () => {
	it("follows the request signal", async () => {
		const app = honey()
		const ac = new AbortController()
		let seen: AbortSignal | undefined
		app.get("/x").handler((ctx) => {
			seen = ctx.signal
			return ctx.res.text("ok", "hi")
		})
		await app.fetch(new Request("http://localhost/x", { signal: ac.signal }), {})
		expect(seen?.aborted).toBe(false)
		ac.abort(new Error("gone"))
		expect(seen?.aborted).toBe(true)
	})

	it("timeout() aborts it, so the handler can stop", async () => {
		const app = honey()
		let reason: unknown
		app
			.get("/slow")
			.use(timeout({ duration: 20 }))
			.handler(async (ctx) => {
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()))
				reason = ctx.signal.reason
				return ctx.res.text("ok", "late")
			})
		const res = await app.fetch(new Request("http://localhost/slow"), {})
		expect(res.status).toBe(504)
		await tick(5)
		expect(reason).toMatchObject({ name: "TimeoutError" })
	})

	it("is a reserved context key", () => {
		const app = honey()
		expect(() => app.context({ signal: 1 } as never)).toThrow(/reserved/)
	})
})

describe("ctx.res options", () => {
	it("a body on a null-body status throws on every path", async () => {
		const res = new HoneyRes()
		expect(() => res.json("no_content" as never, { a: 1 })).toThrow(TypeError)
		const app = honey()
		app.get("/x").handler((ctx) => ctx.res.json("no_content" as never, { a: 1 }))
		const out = await app.fetch(new Request("http://localhost/x"), {})
		expect(out.status).toBe(500)
	})

	it("ResponseOptions.status wins over the status key", () => {
		const res = new HoneyRes()
		expect(res.json("ok", {}, { status: 299 }).status).toBe(299)
		expect(res.text("ok", "x", { status: 203 }).status).toBe(203)
		expect(res.html("ok", "x", { status: 203 }).status).toBe(203)
	})

	it("cookies are appended to a set-cookie header on both paths", () => {
		const opts = { cookies: { b: { value: "2" } }, headers: { "set-cookie": "a=1" } }
		const native = new HoneyRes(false).json("ok", {}, opts)
		const node = new HoneyRes(true).json("ok", {}, opts)
		expect(native.headers.getSetCookie()).toEqual(["a=1", expect.stringContaining("b=2")])
		expect(node.headers.getSetCookie()).toEqual(["a=1", expect.stringContaining("b=2")])
	})
})
