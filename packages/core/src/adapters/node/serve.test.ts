import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createHoneyResponse, isHoneyResponse, withRawBody } from "../../response/builder.ts"
import type { HeaderMap } from "../../response/out-headers.ts"
import { honey } from "../../routing/app.ts"
import { DEFAULT_MAX_REQUEST_BODY } from "../serve.ts"
import { type HoneyServer, type NodeServeOptions, serve } from "./serve.ts"

type FetchApp = { fetch(request: Request, env: unknown): Response | Promise<Response> }

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections()
					server.close(() => resolve())
				}),
		),
	)
	vi.restoreAllMocks()
})

/** Serve `app` on a free loopback port. */
async function listen(app: FetchApp, options: Partial<NodeServeOptions<unknown>> = {}) {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0, ...options })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo
	return { base: `http://127.0.0.1:${port}`, port, server }
}

/** An app answering every request with `answer(request, env)`. */
const answering = (answer: FetchApp["fetch"]): FetchApp => ({ fetch: answer })

/** An app that throws each of `errors` in turn. */
const throwing = (...errors: unknown[]): FetchApp =>
	answering(() => {
		throw errors.shift()
	})

/** Raw bytes in, every byte the server wrote until it closed the connection out. */
function exchange(port: number, bytes: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let out = ""
		socket.on("data", (chunk) => (out += chunk.toString("latin1")))
		socket.on("close", () => resolve(out))
		socket.on("error", () => {})
		socket.write(bytes)
	})
}

const GET = (path: string) => `GET ${path} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`

/** The header block of a raw response, lowercased names, in wire order. */
function headerLines(raw: string): string[] {
	return (raw.split("\r\n\r\n")[0] as string)
		.split("\r\n")
		.slice(1)
		.map((line) => line.replace(/^[^:]+/, (name) => name.toLowerCase()))
}

/** A promise and the function that settles it. */
function gate<T = void>() {
	let open!: (value: T) => void
	const shut = new Promise<T>((resolve) => (open = resolve))
	return { open, shut }
}

const encode = (text: string) => new TextEncoder().encode(text)

/** `parts`, then the end. */
function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(encode(part))
			controller.close()
		},
	})
}

/** A native response whose body stream sends "partial", then fails. */
function failingAfterHeaders(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encode("partial"))
			},
			async pull(controller) {
				await new Promise((resolve) => setTimeout(resolve, 20))
				controller.error(new Error("source died"))
			},
		}),
	)
}

/** A Honey response whose header value tries to start a second header. */
function headerInjection(): Response {
	return createHoneyResponse({ headers: { "x-a": "1\r\nset-cookie: pwned=1" }, raw: "x", status: 200 })
}

/** A native response of `size` bytes that declares its length. */
function declaredOf(size: number): Response {
	return new Response(new Blob([new Uint8Array(size).fill(97)]).stream(), {
		headers: { "content-length": String(size) },
	})
}

/** An app that records each path, then holds its answer until `release` opens. */
function holding() {
	const arrived = gate()
	const release = gate()
	const seen: string[] = []
	const app = answering(async (req) => {
		seen.push(new URL(req.url).pathname)
		arrived.open()
		await release.shut
		return new Response("finished")
	})
	return { app, arrived, release, seen }
}

/** An app whose answer comes only once the request's signal aborts; the reasons are kept. */
function untilAborted() {
	const reasons: unknown[] = []
	const arrived = gate()
	const app = answering(
		(req) =>
			new Promise((resolve) => {
				req.signal.addEventListener("abort", () => {
					reasons.push(req.signal.reason)
					resolve(new Response("aborted"))
				})
				arrived.open()
			}),
	)
	return { app, arrived, reasons }
}

describe("writing Honey's own responses", () => {
	// v0: e10dc5cd9b
	// v0: 03a50e035a
	it("the app answers Node with a HoneyResponse, written without a Fetch Response; fetch() still gets a native one", async () => {
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { a: "é" }))
		const answers: Response[] = []
		const { base } = await listen(
			answering(async (req, env) => {
				answers.push(await app.fetch(req, env as {}))
				return answers[0] as Response
			}),
		)
		const res = await fetch(`${base}/json`)
		expect([res.status, res.headers.get("content-length"), await res.json()]).toEqual([200, "10", { a: "é" }])
		const native = await app.fetch(new Request("http://h/json"), {})
		expect([isHoneyResponse(answers[0]), native instanceof Response]).toEqual([true, true])
	})

	it.each([
		["text", { raw: "héllo" }, "héllo", "6"],
		["bytes", { raw: encode("bytes") }, "bytes", "5"],
		["no body", { raw: null }, "", null],
	])("%s: the status, its headers and a content-length that counts bytes", async (_kind, body, text, length) => {
		const { base } = await listen(
			answering(() => createHoneyResponse({ headers: { "x-a": "1" }, status: 201, ...body })),
		)
		const res = await fetch(base)
		const seen = [res.status, res.headers.get("x-a"), res.headers.get("content-length"), await res.text()]
		expect(seen).toEqual([201, "1", length, text])
	})

	it("streams a body it has no bytes for, chunked", async () => {
		const { port } = await listen(
			answering(() => createHoneyResponse({ headers: {}, status: 200, stream: streamOf("a", "b") })),
		)
		const raw = await exchange(port, GET("/"))
		const framing = [
			headerLines(raw).includes("transfer-encoding: chunked"),
			raw.endsWith("1\r\na\r\n1\r\nb\r\n0\r\n\r\n"),
		]
		expect(framing).toEqual([true, true])
	})

	it.each([
		["with a Connection header naming another", { connection: "x-secret", "x-secret": "1" }],
		["without a Connection header", {}],
	])("keeps every Set-Cookie and drops the hop-by-hop headers a handler set, %s", async (_case, extra) => {
		const headers: HeaderMap = { "set-cookie": ["a=1", "b=2"], "transfer-encoding": "chunked", "x-kept": "1", ...extra }
		const { port } = await listen(answering(() => createHoneyResponse({ headers, raw: "abc", status: 200 })))
		const raw = await exchange(port, GET("/"))
		const kept = headerLines(raw).filter((l) => /^(set-cookie|x-|transfer-encoding|content-length)/.test(l))
		expect([kept, raw.endsWith("\r\n\r\nabc")]).toEqual([
			["set-cookie: a=1", "set-cookie: b=2", "x-kept: 1", "content-length: 3"],
			true,
		])
	})
})

describe("writing a native Response: status and headers", () => {
	// v0: 14d19403dd
	it("keeps the status text, every Set-Cookie and the buffered body Honey recorded", async () => {
		const cookies = new Headers([
			["set-cookie", "a=1"],
			["set-cookie", "b=2"],
		])
		const recorded = () =>
			withRawBody(new Response("raw", { headers: cookies, status: 299, statusText: "Custom" }), "raw")
		const { base } = await listen(answering(recorded))
		const res = await fetch(base)
		const seen = [res.status, res.statusText, res.headers.getSetCookie(), res.headers.get("content-length")]
		expect([...seen, await res.text()]).toEqual([299, "Custom", ["a=1", "b=2"], "3", "raw"])
	})

	// v0: f590ca219b
	// v0: 9983e44d3f
	it("drops hop-by-hop headers and the ones Connection names: they described another connection", async () => {
		const headers = {
			connection: "x-secret, Keep-Alive",
			"keep-alive": "timeout=99",
			"proxy-connection": "keep-alive",
			te: "trailers",
			trailer: "x-t",
			"transfer-encoding": "chunked",
			upgrade: "h2c",
			"x-kept": "1",
			"x-secret": "1",
		}
		const { port } = await listen(answering(() => new Response("abc", { headers })))
		const raw = await exchange(port, GET("/"))
		const lines = headerLines(raw).filter((l) => !/^(date|content-type):/.test(l))
		/* the body is an untagged stream: Node frames it, once */
		expect([lines, raw.endsWith("\r\n\r\n3\r\nabc\r\n0\r\n\r\n")]).toEqual([
			["x-kept: 1", "connection: close", "transfer-encoding: chunked"],
			true,
		])
	})
})

describe("writing a native Response: the body", () => {
	it("answers a response without a body with no body", async () => {
		const { base } = await listen(answering(() => new Response(null, { status: 204 })))
		const res = await fetch(base)
		expect([res.status, await res.text()]).toEqual([204, ""])
	})

	// v0: 1500e61168
	it("never trusts a stream's declared length: it chunks the bytes, and keep-alive stays in sync", async () => {
		const lying = () => new Response(streamOf("abc"), { headers: { "content-length": "999999" } })
		const { port } = await listen(answering(lying))
		const raw = await exchange(port, `GET / HTTP/1.1\r\nHost: h\r\n\r\n${GET("/")}`)
		const count = (part: string) => raw.split(part).length - 1
		expect([count("HTTP/1.1 200"), raw.includes("999999"), count("3\r\nabc\r\n0\r\n\r\n")]).toEqual([2, false, 2])
	})

	it("buffers a small body of declared length, and streams one over 256 KiB", async () => {
		const { base } = await listen(answering((req) => declaredOf(new URL(req.url).pathname === "/big" ? 300_000 : 10)))
		const [small, big] = await Promise.all([fetch(base), fetch(`${base}/big`)])
		expect([
			small.headers.get("content-length"),
			(await small.text()).length,
			big.headers.get("content-length"),
			big.headers.get("transfer-encoding"),
			(await big.text()).length,
		]).toEqual(["10", 10, null, "chunked", 300_000])
	})
})

describe("when the app or the write fails", () => {
	// v0: dc0a613ae9
	it("reports an error the app could not answer, then sends 500", async () => {
		const onError = vi.fn()
		const boom = new Error("boom")
		const { base } = await listen(throwing(boom), { onError })
		const res = await fetch(base)
		expect([res.status, await res.text(), onError.mock.calls]).toEqual([500, "Internal Server Error", [[boom]]])
	})

	it("refuses a header value carrying CR/LF: 500, never a split response", async () => {
		const onError = vi.fn()
		const { port } = await listen(answering(headerInjection), { onError })
		const raw = await exchange(port, GET("/"))
		expect([raw.split("\r\n")[0], raw.includes("pwned"), onError.mock.calls.length]).toEqual([
			"HTTP/1.1 500 Internal Server Error",
			false,
			1,
		])
	})

	it("cuts the connection when a stream fails after the headers went out", async () => {
		const onError = vi.fn()
		const { base } = await listen(answering(failingAfterHeaders), { onError })
		const res = await fetch(base)
		expect(res.status).toBe(200)
		await expect(res.text()).rejects.toThrow()
		expect(onError).not.toHaveBeenCalled()
	})

	it("reports through a process warning when no onError is given, a thrown non-Error as text", async () => {
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {})
		const boom = new Error("boom")
		const { base } = await listen(throwing(boom, "plain"))
		expect([(await fetch(base)).status, (await fetch(base)).status]).toEqual([500, 500])
		expect(warn.mock.calls).toEqual([
			[boom, "HoneyAdapterError"],
			["plain", "HoneyAdapterError"],
		])
	})
})

describe("requests the adapter refuses itself", () => {
	it.each([
		["a target that is not origin- or absolute-form", "GET * HTTP/1.1\r\nHost: h\r\n\r\n"],
		["a Host no URL holds", "GET / HTTP/1.1\r\nHost: 1.2.3.256\r\n\r\n"],
	])("%s: 400 and the connection closes; the app never runs", async (_case, bytes) => {
		const app = vi.fn(() => new Response("app"))
		const { port } = await listen(answering(app))
		const raw = await exchange(port, bytes)
		const seen = [raw.split("\r\n")[0], headerLines(raw).includes("connection: close"), raw.endsWith("Bad Request")]
		expect(seen).toEqual(["HTTP/1.1 400 Bad Request", true, true])
		expect(app).not.toHaveBeenCalled()
	})

	// v0: 8926c4a24f
	it.each([
		["the configured cap", { maxRequestBodySize: 10 }, 20],
		["the default cap of 128 MiB", {}, DEFAULT_MAX_REQUEST_BODY + 1],
	])("a body over %s: the read fails with 413 and the connection is not reused", async (_case, options, length) => {
		const reading = answering(async (req) => {
			const status = await req.text().then(
				() => 200,
				(error: { status: number }) => error.status,
			)
			return new Response(null, { status })
		})
		const { port } = await listen(reading, options)
		const raw = await exchange(port, `POST / HTTP/1.1\r\nHost: h\r\nContent-Length: ${length}\r\n\r\n${"x".repeat(20)}`)
		const seen = [raw.split("\r\n")[0], headerLines(raw).includes("connection: close")]
		expect(seen).toEqual(["HTTP/1.1 413 Payload Too Large", true])
	})
})

describe("what the app receives", () => {
	// v0: 26020e7d95
	it("the configured env", async () => {
		const { base } = await listen(
			answering((_req, env) => Response.json(env)),
			{ env: { db: "primary" } },
		)
		expect(await (await fetch(base)).json()).toEqual({ db: "primary" })
	})

	it("a signal that aborts when the client disconnects before the answer", async () => {
		const { app, arrived, reasons } = untilAborted()
		const { port } = await listen(app)
		const socket = connect(port, "127.0.0.1")
		socket.write("GET / HTTP/1.1\r\nHost: h\r\n\r\n")
		await arrived.shut
		socket.destroy()
		await vi.waitFor(() => expect(reasons).toHaveLength(1))
		expect((reasons[0] as DOMException).message).toBe("The client disconnected")
	})
})

describe("shutdown(): draining", () => {
	// v0: 2e6d785cd7
	// v0: da85e6bc33
	// v0: 77a9ce6911
	// v0: 4cd3118c8e
	it("waits for in-flight requests, then closes; new connections are refused at once", async () => {
		const { app, arrived, release } = holding()
		const { base, server } = await listen(app)
		const inflight = fetch(base)
		await arrived.shut
		let closed = false
		const shutdown = server.shutdown().then(() => (closed = true))
		await expect(fetch(base)).rejects.toThrow()
		expect(closed).toBe(false)
		release.open()
		const res = await inflight
		expect([res.status, await res.text(), res.headers.get("connection")]).toEqual([200, "finished", "close"])
		await shutdown
		expect(closed).toBe(true)
	})

	// v0: 21bb753231
	// v0: 0851a43fb7
	it("never hands the app a request that arrives on a busy connection while draining", async () => {
		const { app, arrived, release, seen } = holding()
		const { port, server } = await listen(app)
		const socket = connect(port, "127.0.0.1")
		let raw = ""
		socket.on("data", (chunk) => (raw += chunk.toString("latin1")))
		const closed = new Promise((resolve) => socket.on("close", resolve))
		socket.write("GET /1 HTTP/1.1\r\nHost: h\r\n\r\n")
		await arrived.shut
		const shutdown = server.shutdown()
		socket.write("GET /2 HTTP/1.1\r\nHost: h\r\n\r\n")
		await new Promise((resolve) => setTimeout(resolve, 20))
		release.open()
		await Promise.all([closed, shutdown])
		/* the answer ends the connection, so the client knows /2 was never processed and may retry it */
		const answers = raw.split("HTTP/1.1 ").length - 1
		expect([seen, answers, headerLines(raw).includes("connection: close")]).toEqual([["/1"], 1, true])
	})
})

describe("shutdown(): what would never finish on its own", () => {
	it("aborts the signal of a response already streaming, so it ends", async () => {
		const ticking = answering(
			(req) =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(encode("tick"))
							req.signal.addEventListener("abort", () => controller.close())
						},
					}),
				),
		)
		const { base, server } = await listen(ticking)
		const reader = ((await fetch(base)).body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await server.shutdown()
		expect(await reader.read()).toEqual({ done: true, value: undefined })
	})

	it("after the timeout, aborts what is still working and closes every connection", async () => {
		const { app, arrived, reasons } = untilAborted()
		const { base, server } = await listen(app)
		const pending = fetch(base).then(
			(res) => res.text(),
			() => "cut",
		)
		await arrived.shut
		await server.shutdown(30)
		expect([(reasons[0] as DOMException).message, await pending]).toEqual(["The server is shutting down", "cut"])
	})
})

describe("server options", () => {
	it("sets Node's timeouts it is given and leaves the others at Node's defaults", async () => {
		const timeouts = { headersTimeout: 1000, keepAliveTimeout: 3000, requestTimeout: 2000 }
		const { server } = await listen(
			answering(() => new Response()),
			timeouts,
		)
		const plain = (await listen(answering(() => new Response()))).server
		const seen = [server.headersTimeout, server.requestTimeout, server.keepAliveTimeout, plain.keepAliveTimeout]
		expect(seen).toEqual([1000, 2000, 3000, 5000])
	})

	// v0: a1d56ee617
	it("listens on the hostname it is given, on a free port when none is", async () => {
		const server = serve(
			answering(() => new Response("ok")),
			{ env: {}, hostname: "127.0.0.1" },
		)
		servers.push(server)
		await new Promise((resolve) => server.once("listening", resolve))
		const address = server.address() as AddressInfo
		expect([address.address, address.port > 0]).toEqual(["127.0.0.1", true])
	})
})
