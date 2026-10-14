import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createHoneyResponse, withRawBody } from "../../response/builder.ts"
import type { HeaderMap } from "../../response/out-headers.ts"
import { writeResponse } from "./response.ts"

const servers: Server[] = []

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
})

/** A node:http server that writes `make(path)` for every request. */
async function writing(make: (path: string) => Response) {
	const server = createServer((req, res) => {
		void writeResponse(make(req.url as string), res)
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	return { base: `http://127.0.0.1:${port}`, port }
}

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

/** A native response of `size` bytes that declares its length. */
function declaredOf(size: number): Response {
	return new Response(new Blob([new Uint8Array(size).fill(97)]).stream(), {
		headers: { "content-length": String(size) },
	})
}

describe("writing Honey's own responses", () => {
	// v0: bd8b40ea47
	it.each([
		["text", { raw: "héllo" }, "héllo", "6"],
		["bytes", { raw: encode("bytes") }, "bytes", "5"],
		["no body", { raw: null }, "", null],
	])("%s: the status, its headers and a content-length that counts bytes", async (_kind, body, text, length) => {
		const { base } = await writing(() => createHoneyResponse({ headers: { "x-a": "1" }, status: 201, ...body }))
		const res = await fetch(base)
		const seen = [res.status, res.headers.get("x-a"), res.headers.get("content-length"), await res.text()]
		expect(seen).toEqual([201, "1", length, text])
	})

	it("streams a body it has no bytes for, chunked", async () => {
		const { port } = await writing(() => createHoneyResponse({ headers: {}, status: 200, stream: streamOf("a", "b") }))
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
		const { port } = await writing(() => createHoneyResponse({ headers, raw: "abc", status: 200 }))
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
		const { base } = await writing(recorded)
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
		const { port } = await writing(() => new Response("abc", { headers }))
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
		const { base } = await writing(() => new Response(null, { status: 204 }))
		const res = await fetch(base)
		expect([res.status, await res.text()]).toEqual([204, ""])
	})

	// v0: 1500e61168
	it("never trusts a stream's declared length: it chunks the bytes, and keep-alive stays in sync", async () => {
		const lying = () => new Response(streamOf("abc"), { headers: { "content-length": "999999" } })
		const { port } = await writing(lying)
		const raw = await exchange(port, `GET / HTTP/1.1\r\nHost: h\r\n\r\n${GET("/")}`)
		const count = (part: string) => raw.split(part).length - 1
		expect([count("HTTP/1.1 200"), raw.includes("999999"), count("3\r\nabc\r\n0\r\n\r\n")]).toEqual([2, false, 2])
	})

	it("buffers a small body of declared length, and streams one over 256 KiB", async () => {
		const { base } = await writing((path) => declaredOf(path === "/big" ? 300_000 : 10))
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

describe("when the body fails mid-way", () => {
	it("cuts the connection when a stream fails after the headers went out", async () => {
		const { base } = await writing(failingAfterHeaders)
		const res = await fetch(base)
		expect(res.status).toBe(200)
		await expect(res.text()).rejects.toThrow()
	})
})
