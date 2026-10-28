/**
 * The standalone MCP Streamable HTTP listener against hostile requests (bit 21 d), the runtime's own listener on ports
 * the OS picks, driven by raw requests. Host: a loopback name (127.0.0.1, localhost, [::1], any letter case) with the
 * bound port alone, else 421 before the token or any tool (rebinding names, `127.0.0.1.nip.io`, another port, no
 * port, a repeated Host); exposed, any Host, its token still required. The token: missing, alone, another scheme,
 * wrong, a prefix of it, more than it, twice, empty are 401 with a Bearer challenge, compared on equal-length digests
 * through node's constant-time primitive. /mcp alone (else 404). A chunked body past the cap is 413. GET and DELETE are
 * 405; a method fetch cannot carry is 400. In 2026-07-28 a connection closed before its answer cancels the call.
 */
import { timingSafeEqual } from "node:crypto"
import { request as httpRequest, type Server } from "node:http"
import { type AddressInfo, connect, type Socket } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { serveHttp } from "../../src/runtime/mcp/http.ts"
import { bearer, listenHttp } from "../../src/runtime/mcp/listen.ts"
import { ACCEPT, ended, holding, META, MODERN, modernHeaders, nextEnd, protocol, release, seen } from "./mcp-http.ts"

vi.mock("node:crypto", async (actual) => {
	const crypto = await actual<typeof import("node:crypto")>()
	return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) }
})

const TOKEN = "s3cret-token"
const LIST = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" })

let guarded: Server
let exposed: Server
let port = 0
let exposedPort = 0
beforeAll(async () => {
	guarded = await listenHttp(serveHttp(protocol, { max: 64 }), { host: "127.0.0.1", port: 0, token: TOKEN })
	exposed = await listenHttp(serveHttp(protocol), { exposed: true, host: "127.0.0.1", port: 0, token: TOKEN })
	port = (guarded.address() as AddressInfo).port
	exposedPort = (exposed.address() as AddressInfo).port
})
afterAll(() => {
	for (const server of [guarded, exposed]) {
		server.closeAllConnections()
		server.close()
	}
})

/** A conforming client's headers to the guarded listener, `host` its own. */
const good = (): Record<string, string> => ({
	accept: ACCEPT,
	authorization: `Bearer ${TOKEN}`,
	"content-type": "application/json",
	host: `127.0.0.1:${port}`,
	"mcp-protocol-version": "2025-11-25",
})

/** A request's body as chunks written (chunked: no Content-Length), its method and path. */
type Sent = { readonly chunks?: readonly string[]; readonly method?: string; readonly path?: string }

/** A raw request to `at` with exactly `headers`. */
const raw = (
	at: number,
	headers: Record<string, string>,
	{ chunks = [LIST], method = "POST", path = "/mcp" }: Sent = {},
) =>
	new Promise<{ status: number; challenge: unknown }>((settle, reject) => {
		const outgoing = httpRequest({ headers, host: "127.0.0.1", method, path, port: at, setHost: false }, (incoming) => {
			incoming.resume()
			incoming.on("end", () =>
				settle({ challenge: incoming.headers["www-authenticate"], status: incoming.statusCode ?? 0 }),
			)
		})
		outgoing.on("error", reject)
		for (const chunk of chunks) outgoing.write(chunk)
		outgoing.end()
	})

/** The status line of `lines` sent as one request over a socket, then `body`. */
const statusLine = (lines: readonly string[], body: string) =>
	new Promise<string>((settle) => {
		let text = ""
		const socket = connect(port, "127.0.0.1", () => socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`))
		socket.on("data", (chunk) => (text += chunk.toString()))
		socket.on("close", () => settle(text.split("\r\n")[0] ?? ""))
	})

describe("the Host", () => {
	it("serves a loopback Host with the bound port: 127.0.0.1, localhost, [::1], in any letter case", async () => {
		const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]
		const statuses = await Promise.all(hosts.map(async (host) => (await raw(port, { ...good(), host })).status))
		expect(statuses).toEqual([200, 200, 200, 200])
	})

	it.each([
		["evil.example"],
		["127.0.0.1.nip.io"],
		["evil.example:PORT"],
		["127.0.0.1.nip.io:PORT"],
		["127.0.0.1:1"],
		["127.0.0.1"],
		["::1:PORT"],
		["[::1]:1"],
		["localhost.:PORT"],
		["user@127.0.0.1:PORT"],
		["0.0.0.0:PORT"],
	])("refuses the Host %s with 421 before the token or any tool", async (host) => {
		const before = seen.length
		const headers = { ...good(), authorization: "", host: host.replace("PORT", String(port)) }
		expect([(await raw(port, headers)).status, seen.length - before]).toEqual([421, 0])
	})

	it("refuses a Host sent twice with 421, the first one its own", async () => {
		const rest = Object.entries(good()).filter(([name]) => name !== "host")
		const lines = ["POST /mcp HTTP/1.1", `Host: 127.0.0.1:${port}`, "Host: evil.example"]
		lines.push(
			...rest.map(([name, value]) => `${name}: ${value}`),
			`content-length: ${LIST.length}`,
			"connection: close",
		)
		expect(await statusLine(lines, LIST)).toBe("HTTP/1.1 421 Misdirected Request")
	})

	it("answers any Host when exposed, its token still required", async () => {
		const host = "mcp.example.com"
		const served = await raw(exposedPort, { ...good(), host })
		const tokenless = await raw(exposedPort, { ...good(), authorization: "", host })
		expect([served.status, tokenless.status]).toEqual([200, 401])
	})
})

describe("the token", () => {
	it.each([
		["no Authorization", undefined],
		["the token alone", TOKEN],
		["another scheme", `Basic ${TOKEN}`],
		["a wrong token", "Bearer s3cret-tokem"],
		["a prefix of the token", "Bearer s3cret"],
		["the token and more", `Bearer ${TOKEN}2`],
		["the token twice", `Bearer ${TOKEN}, Bearer ${TOKEN}`],
		["an empty bearer", "Bearer "],
	])("refuses %s with 401 and a Bearer challenge before any tool", async (_, authorization) => {
		const before = seen.length
		const { authorization: _token, ...rest } = good()
		const answer = await raw(port, authorization === undefined ? rest : { ...rest, authorization })
		expect([answer.status, answer.challenge, seen.length - before]).toEqual([401, "Bearer", 0])
	})

	it("takes the scheme in any letter case", async () => {
		expect((await raw(port, { ...good(), authorization: `bearer ${TOKEN}` })).status).toBe(200)
	})

	it("compares the token through node's constant-time primitive, on equal-length digests, whatever was sent", () => {
		const spy = vi.mocked(timingSafeEqual)
		spy.mockClear()
		const sent = [`Bearer ${TOKEN}`, "Bearer s3cret", null, "Bearer a-much-longer-token-than-the-real-one"]
		const outcomes = sent.map((header) => bearer(header, TOKEN))
		const lengths = spy.mock.calls.map(([a, b]) => [(a as Buffer).length, (b as Buffer).length])
		expect([outcomes, lengths]).toEqual([[true, false, false, false], Array.from({ length: 4 }, () => [32, 32])])
	})
})

describe("the path, the body and the method", () => {
	it("serves /mcp alone, with or without a query: another path is 404", async () => {
		const paths = ["/", "/mcp/", "/MCP", "/other", "http://127.0.0.1/mcp", "/mcp?x=1"]
		const statuses = await Promise.all(paths.map(async (path) => (await raw(port, good(), { path })).status))
		expect(statuses).toEqual([404, 404, 404, 404, 404, 200])
	})

	it("refuses a chunked body past the cap with 413, no Content-Length sent", async () => {
		expect((await raw(port, good(), { chunks: [LIST.slice(0, 40), " ".repeat(40)] })).status).toBe(413)
	})

	it("answers GET and DELETE with 405 and a method fetch cannot carry with 400", async () => {
		const statuses = await Promise.all(
			["GET", "DELETE", "TRACE"].map(async (method) => (await raw(port, good(), { chunks: [], method })).status),
		)
		expect(statuses).toEqual([405, 405, 400])
	})
})

describe("cancellation on a closed connection", () => {
	it("in 2026-07-28, cancels a call whose connection closes before its answer", async () => {
		release()
		const count = ended.length + 1
		const body = JSON.stringify({ id: 21, jsonrpc: "2.0", method: "tools/call", params: { _meta: META, name: "hold" } })
		const headers = { ...good(), ...modernHeaders("hold"), "mcp-protocol-version": MODERN }
		const outgoing = httpRequest({
			agent: false,
			headers,
			host: "127.0.0.1",
			method: "POST",
			path: "/mcp",
			port: exposedPort,
			setHost: false,
		})
		const accepted = new Promise<Socket>((settle) => exposed.once("connection", settle))
		outgoing.on("error", () => undefined)
		outgoing.end(body)
		const socket = await accepted
		await holding(1)
		/* the server's side closes, every close listener runs, then this: a call it missed ends released */
		const gone = new Promise((settle) => socket.once("close", settle))
		outgoing.destroy()
		await gone
		release()
		expect(await nextEnd(count)).toBe("aborted")
	})
})
