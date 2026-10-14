import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createHoneyResponse, isHoneyResponse } from "../../response/builder.ts"
import { honey } from "../../routing/app.ts"
import { DEFAULT_MAX_REQUEST_BODY } from "../serve.ts"
import { type HoneyServer, type NodeServeOptions, serve } from "./serve.ts"

type FetchApp = { fetch(request: Request, env: unknown): Response | Promise<Response> }

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => (server.listening ? server.shutdown(0) : Promise.resolve())))
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

/** A Honey response whose header value tries to start a second header. */
function headerInjection(): Response {
	return createHoneyResponse({ headers: { "x-a": "1\r\nset-cookie: pwned=1" }, raw: "x", status: 200 })
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

describe("answering Node", () => {
	// v0: e10dc5cd9b
	// v0: 03a50e035a
	// v0: 1dce41eac3
	// v0: 099219a434
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

	/* bit 07 (H17): the default reporter is a logger, never a process warning */
	it("with no onError, a plain fetch app's failures go to a default logger, a thrown non-Error as text", async () => {
		vi.stubEnv("NODE_ENV", "production")
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {})
		const { base } = await listen(throwing(new Error("boom"), "plain"))
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const statuses = [(await fetch(base)).status, (await fetch(base)).status]
		const lines = write.mock.calls.map(
			([line]) => JSON.parse(String(line)) as { err: { message: string }; msg: string },
		)
		write.mockRestore()
		vi.unstubAllEnvs()
		expect([statuses, lines.map((line) => [line.msg, line.err.message]), warn.mock.calls]).toEqual([
			[500, 500],
			[
				["serve failed", "boom"],
				["serve failed", "plain"],
			],
			[],
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
	// v0: 5b9b50da7b
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

	// v0: 1367cdc6b5
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
