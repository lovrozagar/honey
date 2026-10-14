import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { PEER_ADDRESS } from "../../context/peer.ts"
import { HoneyError } from "../../errors/error.ts"
import { isNodeOutbound } from "../../response/builder.ts"
import { toFetchRequest } from "../fetch-request.ts"
import { httpParser, type RawRequest } from "./__fixtures__/parsed.ts"
import { ABORT_REQUEST, BODY_OVERFLOW, nodeRequest, nodeRequestUrl } from "./request.ts"

const parser = httpParser()
afterEach(() => parser.close())

/** The IncomingMessage for these bytes; `encrypted` marks its socket as TLS. */
async function incoming(init: RawRequest & { encrypted?: boolean } = {}): Promise<IncomingMessage> {
	const msg = await parser.parse(init)
	if (init.encrypted === true) Object.defineProperty(msg.socket, "encrypted", { value: true })
	return msg
}

/** The bridge's Request for a POST carrying `body`. */
async function post(body: readonly string[], extra: RawRequest = {}, maxBody = 0): Promise<Request> {
	return nodeRequest(
		await incoming({ body, method: "POST", target: "/in", ...extra }),
		"http://app.example/in",
		maxBody,
	)
}

function abort(req: Request, reason?: unknown): void {
	;(req as unknown as Record<symbol, (r?: unknown) => void>)[ABORT_REQUEST]?.(reason)
}

function overflowOf(req: Request): boolean | undefined {
	return (req as unknown as Record<symbol, boolean>)[BODY_OVERFLOW]
}

const hostOf = (host: string | undefined) => (host === undefined ? [] : ([["Host", host]] as const))

describe("nodeRequestUrl: the URL is what the client sent, as Bun and Workers spell it", () => {
	// v0: 702ec7a210
	// v0: dbfcc94cd8
	// v0: 16db748496
	// v0: 0c4eaa8045
	// v0: 3c96901855
	it.each([
		["/a?b=1", "app.example", {}, "http://app.example/a?b=1"],
		["/a", "app.example:8443", { encrypted: true }, "https://app.example:8443/a"],
		["/a", "[::1]:8080", {}, "http://[::1]:8080/a"],
		["/a", "app.example.", {}, "http://app.example./a"],
		["/a/./b/../c", "h", {}, "http://h/a/c"],
		["/%2e%2e/admin", "h", {}, "http://h/admin"],
		["/.well-known/x", "h", {}, "http://h/.well-known/x"],
		["/a\\b", "h", {}, "http://h/a/b"],
		["/a<b>?q='x'", "h", {}, "http://h/a%3Cb%3E?q=%27x%27"],
		["/a#frag", "h", {}, "http://h/a"],
		["//evil.example/x", "h", {}, "http://h//evil.example/x"],
		["http://other.example/p?q", "h", {}, "http://other.example/p?q"],
		["HTTPS://Other.Example/p", "h", {}, "http://other.example/p"],
		["/a", undefined, { version: "1.0" }, "http://localhost/a"],
		["/a", "App.Example", {}, "http://app.example/a"],
		["/a", "app.example:80", {}, "http://app.example/a"],
		["/a", "app.example:443", { encrypted: true }, "https://app.example/a"],
		["/a", "app.example:443", {}, "http://app.example:443/a"],
		["/a", "127.0.0.1:3000", {}, "http://127.0.0.1:3000/a"],
		["/a", "0x7f.1", {}, "http://127.0.0.1/a"],
		["/a", "[0:0::1]:8080", {}, "http://[::1]:8080/a"],
		["/a/../b", "XN--NXASMQ6B", {}, "http://xn--nxasmq6b/b"],
	] as const)("%j with Host %j %j → %j", async (target, host, extra, expected) => {
		expect(nodeRequestUrl(await incoming({ headers: hostOf(host), target, ...extra }))).toBe(expected)
	})

	// v0: e319ee7191
	// v0: fea1319141
	// v0: 60e9d255d3
	it.each([
		["*", "h", "asterisk-form"],
		["ftp://h/x", "h", "a scheme other than http(s)"],
		["http://user:pw@h/x", "h", "userinfo in an absolute-form target"],
		["http://[::1/x", "h", "an absolute-form target that is no URL"],
		["http://exa_mple/x", "h", "an absolute-form host that is not host[:port]"],
		["/a", "", "an empty Host"],
		["/a", "h/admin?", "a Host carrying a path"],
		["/a", "a b", "a Host with a space"],
		["/a", "h:99999", "a port over 65535"],
		["/a", "-h", "a label starting with a dash"],
		["/a", "h@evil", "a Host carrying userinfo"],
		["/a", "[:::::]", "a bracketed Host that is no IPv6 address"],
		["/a", "[::1]:99999", "a bracketed Host with a port over 65535"],
		["/a", "1.2.3.256", "an IPv4 octet over 255"],
		["/a", "999999999999", "a number no IPv4 address holds"],
	])("%j with Host %j is null (%s): the request gets 400", async (target, host) => {
		expect(nodeRequestUrl(await incoming({ headers: hostOf(host), target }))).toBeNull()
	})
})

describe("nodeRequest: Request-shaped without being constructed as one", () => {
	// v0: ac32ffde30
	// v0: 2b030b4b40
	it("reports what a Fetch Request for the same message reports", async () => {
		const view = nodeRequest(await incoming({ target: "/x" }), "http://app.example/x", 0)
		const native = new Request("http://app.example/x")
		const keys = [
			"cache",
			"credentials",
			"destination",
			"integrity",
			"keepalive",
			"method",
			"mode",
			"redirect",
			"referrer",
			"referrerPolicy",
			"url",
		] as const
		expect(Object.fromEntries(keys.map((k) => [k, view[k]]))).toEqual(
			Object.fromEntries(keys.map((k) => [k, native[k]])),
		)
		expect([view instanceof Request, view.body, view.bodyUsed, view.headers.get("host")]).toEqual([
			false,
			null,
			false,
			"app.example",
		])
		expect((view as unknown as { duplex: string }).duplex).toBe("half")
	})

	it("is the request the response builder writes for Node directly (NODE_OUTBOUND)", async () => {
		expect(isNodeOutbound(nodeRequest(await incoming(), "http://h/", 0))).toBe(true)
	})

	// v0: 46e39f1757
	it("reports the socket peer for ctx.ip, or null once the socket has none", async () => {
		const live = nodeRequest(await incoming(), "http://h/", 0)
		const gone = await incoming()
		gone.socket.destroy()
		expect([(live as never)[PEER_ADDRESS], (nodeRequest(gone, "http://h/", 0) as never)[PEER_ADDRESS]]).toEqual([
			"127.0.0.1",
			null,
		])
	})
})

describe("nodeRequest: reading the body", () => {
	it.each([
		["text", (r: Request) => r.text(), "héllo"],
		["json", (r: Request) => r.json(), { a: "héllo" }],
		["arrayBuffer", async (r: Request) => new TextDecoder().decode(await r.arrayBuffer()), "héllo"],
		["bytes", async (r: Request) => new TextDecoder().decode(await r.bytes()), "héllo"],
		["blob", async (r: Request) => (await r.blob()).text(), "héllo"],
	])("%s() reads the whole body once, however it arrived in chunks", async (method, read, expected) => {
		const text = method === "json" ? JSON.stringify(expected) : "héllo"
		const req = await post([text.slice(0, 3), text.slice(3)], { chunked: true })
		expect(await read(req)).toEqual(expected)
		expect(req.bodyUsed).toBe(true)
		await expect(read(req)).rejects.toThrow(TypeError)
	})

	it("reads a body that arrived in one piece", async () => {
		expect(await (await post(["one piece"])).text()).toBe("one piece")
	})

	it("reads a GET's absent body as empty, any number of times", async () => {
		const req = nodeRequest(await incoming(), "http://h/", 0)
		expect([await req.text(), await req.text(), (await req.bytes()).byteLength]).toEqual(["", "", 0])
	})

	it("fails json() on an empty body with a SyntaxError, as Fetch does", async () => {
		await expect((await post([])).json()).rejects.toThrow(SyntaxError)
	})

	it("hands the same body stream to every reader of .body", async () => {
		const req = await post(["a", "b"])
		expect(req.body).toBe(req.body)
		expect([await new Response(req.body).text(), req.bodyUsed]).toEqual(["ab", true])
	})

	it("reads a body stream that something asked for first through text()", async () => {
		const req = await post(["a", "b"])
		void req.body
		expect(await req.text()).toBe("ab")
	})
})

describe("nodeRequest: the Fetch Request behind the view", () => {
	it("parses a form, then refuses a second read", async () => {
		const headers = [
			["Host", "h"],
			["Content-Type", "application/x-www-form-urlencoded"],
		] as const
		const req = await post(["a=1&b=2"], { headers })
		expect(Object.fromEntries(await req.formData())).toEqual({ a: "1", b: "2" })
		await expect(req.text()).rejects.toThrow(TypeError)
	})

	it("reads through it once one exists, so a clone and the original both get the body", async () => {
		const req = await post(["shared"])
		const copy = req.clone()
		expect(req.body).toBe(toFetchRequest(req).body)
		expect([await req.text(), await copy.text(), req.bodyUsed]).toEqual(["shared", "shared", true])
	})

	// v0: 02f0289d7c
	it("toFetchRequest() gives one real Request that new Request() and fetch() accept", async () => {
		const headers = [
			["Host", "h"],
			["X-Multi", "1"],
			["x-multi", "2"],
		] as const
		const view = await post(["payload"], { headers })
		const real = toFetchRequest(view)
		expect(toFetchRequest(view)).toBe(real)
		const copy = new Request(real)
		expect([real instanceof Request, copy.method, copy.url, copy.headers.get("x-multi")]).toEqual([
			true,
			"POST",
			"http://app.example/in",
			"1, 2",
		])
		expect([await copy.text(), view.bodyUsed]).toEqual(["payload", true])
	})
})

describe("nodeRequest: the signal aborts when the adapter says the client is gone", () => {
	it("aborts a signal already handed out, with the adapter's reason", async () => {
		const req = nodeRequest(await incoming(), "http://h/", 0)
		const { signal } = req
		expect(signal.aborted).toBe(false)
		abort(req, new DOMException("The server is shutting down", "AbortError"))
		expect([signal.aborted, (signal.reason as DOMException).message]).toEqual([true, "The server is shutting down"])
	})

	it("hands out an aborted signal when the abort came before anyone asked, the first reason kept", async () => {
		const req = nodeRequest(await incoming(), "http://h/", 0)
		abort(req)
		abort(req, new Error("later"))
		expect([req.signal.aborted, (req.signal.reason as DOMException).message]).toEqual([true, "The client disconnected"])
		expect(req.signal).toBe(req.signal)
	})

	it("passes the signal to the Fetch Request behind the view", async () => {
		const req = nodeRequest(await incoming(), "http://h/", 0)
		abort(req)
		expect(toFetchRequest(req).signal.aborted).toBe(true)
	})
})

describe("nodeRequest: the body cap (maxRequestBodySize)", () => {
	const declared = [
		["Host", "h"],
		["Content-Length", "11"],
	] as const

	// v0: 8926c4a24f
	// v0: b21d3b23ee
	it.each([
		["a declared length over the cap", { body: ["abc"], headers: declared }],
		["a chunked body that grows over the cap", { body: ["12345", "678901"], chunked: true }],
	])("%s fails the read with 413 and marks the connection unusable", async (_case, raw: RawRequest) => {
		for (const read of [(r: Request) => r.text(), (r: Request) => new Response(r.body).text()]) {
			const req = await post([], raw, 10)
			const error = await read(req).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(HoneyError)
			expect([(error as HoneyError).status, (error as HoneyError).errorKey, overflowOf(req)]).toEqual([
				413,
				"content_too_large",
				true,
			])
		}
	})

	it("accepts a body of exactly the cap, and 0 turns the cap off", async () => {
		const exact = await post(["12345", "67890"], {}, 10)
		const streamed = await post(["12345", "67890"], {}, 10)
		const uncapped = await post(["x".repeat(100_000)])
		expect([
			await exact.text(),
			await new Response(streamed.body).text(),
			overflowOf(exact) || overflowOf(streamed),
			(await uncapped.text()).length,
		]).toEqual(["1234567890", "1234567890", false, 100_000])
	})

	it("cancelling a capped body stream stops reading the socket", async () => {
		const msg = await incoming({ body: ["a", "b"], chunked: true, method: "POST" })
		const reader = (nodeRequest(msg, "http://h/", 10).body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await reader.cancel()
		expect(msg.destroyed).toBe(true)
	})
})
