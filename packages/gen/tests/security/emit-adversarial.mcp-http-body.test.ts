/**
 * The MCP server's Streamable HTTP handler against hostile bodies and streams (bit 21 d), the runtime's own handler fed
 * Requests in process. The body: past the cap is 413, counted as it streams whatever Content-Length says (the cap ±1);
 * no JSON is -32700; deep nesting is answered and the next request served; a batch is answered under 2025-03-26 alone
 * (no header) and refused -32600 in every later revision; a client's response is taken (202) before 2026-07-28 and
 * refused in it; a notification is 202 with no body; prototype keys pollute nothing and smuggle no `_meta`. A file path
 * is a tool error over HTTP in both eras, nothing sent. No answer carries a session id; one sent is ignored. A call's
 * progress makes its answer an unbuffered event stream. In 2026-07-28 a closed stream or an aborted request cancels the
 * call; in 2025-11-25 neither does. A cancel aborts at once, so each held call is released right after it: one a cancel
 * missed ends released, never waited on.
 */
import { describe, expect, it } from "vitest"
import { serveHttp } from "../../src/runtime/mcp/http.ts"
import {
	ACCEPT,
	codeOf,
	ended,
	holding,
	META,
	MODERN,
	modernHeaders,
	nextEnd,
	posting,
	protocol,
	read,
	release,
	resultOf,
	sent,
	URL_MCP,
} from "./mcp-http.ts"

const handler = serveHttp(protocol, { max: 4_096 })
const post = posting(handler)
const wide = posting(serveHttp(protocol))
const LIST = { id: 1, jsonrpc: "2.0", method: "tools/list" }

/** A body of 5 MiB streamed to the handler, Content-Length set to `length` when given. */
const streamedBig = async (length?: string) => {
	const big = new Uint8Array(5 * 1024 * 1024).fill(0x20)
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(big)
			controller.close()
		},
	})
	const headers = { accept: ACCEPT, "content-type": "application/json", ...(length && { "content-length": length }) }
	const init = { body, duplex: "half", headers, method: "POST" } as RequestInit
	return (await handler(new Request(URL_MCP, init))).status
}

/** The tools/list request padded with spaces to `size` bytes. */
const padded = (size: number) => JSON.stringify(LIST) + " ".repeat(size - JSON.stringify(LIST).length)

/** `[` and `]` each `depth` times. */
const nest = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`

/** A legacy tools/call of `name` whose `file` argument is `value` as written, through the 4 MiB handler. */
const deepCall = (name: string, value: string) =>
	wide(`{"id":1,"jsonrpc":"2.0","method":"tools/call","params":{"name":"${name}","arguments":{"file":${value}}}}`)

/** A held call under `version` with a progress token, so it answers as an event stream. */
const heldCall = (version: string, id: number) => {
	const modern = version === MODERN
	const params = { _meta: modern ? { ...META, progressToken: id } : { progressToken: id }, name: "hold" }
	return post(
		{ id, jsonrpc: "2.0", method: "tools/call", params },
		modern ? modernHeaders("hold") : { "mcp-protocol-version": version },
	)
}

/** An event stream's text whole. */
async function eventsOf(reader: ReadableStreamDefaultReader<Uint8Array>, first: string): Promise<string[]> {
	let text = first
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
		text += new TextDecoder().decode(chunk.value)
	return text.split("\n\n").filter(Boolean)
}

describe("the body's size and shape", () => {
	it("refuses a body past the cap with 413 whatever Content-Length claims, counted as it streams", async () => {
		expect([await streamedBig("10"), await streamedBig()]).toEqual([413, 413])
	})

	it("holds the cap ±1: 4,096 bytes served, 4,097 refused", async () => {
		expect([(await post(padded(4096))).status, (await post(padded(4097))).status]).toEqual([200, 413])
	})

	it("answers a body that is no JSON with 400 and -32700", async () => {
		expect(codeOf(await read(await post("{")))).toEqual([400, -32700])
	})

	it("answers deep nesting in params and in a guarded tool's arguments without falling over, then serves the next", async () => {
		const answers = [
			await read(await deepCall("echo", nest(100_000))),
			await read(await deepCall("upload", `{"a":${nest(100_000)}}`)),
		]
		const next = await read(await post(LIST, { "mcp-protocol-version": "2025-11-25" }))
		expect([...answers.map((answer) => answer.status), next.status]).toEqual([200, 200, 200])
	})

	it("pollutes no prototype: a __proto__ key at the top and in params claims no _meta", async () => {
		const text = `{"__proto__":{"polluted":1},"id":1,"jsonrpc":"2.0","method":"tools/list","params":{"__proto__":{"_meta":${JSON.stringify(META)}}}}`
		const answer = await read(await post(text, { "mcp-protocol-version": "2025-11-25" }))
		const result = answer.json?.result as object
		expect([answer.status, "resultType" in result, ({} as { polluted?: number }).polluted]).toEqual([
			200,
			false,
			undefined,
		])
	})
})

describe("batches, responses and notifications by era", () => {
	it("answers a batch as one array under 2025-03-26 (no header) and refuses it with -32600 in every later revision", async () => {
		const call = { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "echo" } }
		const batch = [LIST, { jsonrpc: "2.0", method: "notifications/initialized" }, call]
		const oldest = await read(await post(batch))
		const versions = ["2025-03-26", "2025-06-18", "2025-11-25", MODERN]
		const later = await Promise.all(
			versions.map(async (version) => codeOf(await read(await post(batch, { "mcp-protocol-version": version })))),
		)
		const ids = (JSON.parse(oldest.text) as { id: number }[]).map((reply) => reply.id)
		expect([oldest.status, ids, later, codeOf(await read(await post([])))]).toEqual([
			200,
			[1, 2],
			[[200, undefined], ...Array.from({ length: 3 }, () => [400, -32600])],
			[400, -32600],
		])
	})

	it("takes a client's response with 202 before 2026-07-28 and refuses it with 400 in 2026-07-28", async () => {
		const bodies = [
			{ id: 7, jsonrpc: "2.0", result: {} },
			{ error: { code: -1, message: "no" }, id: 8, jsonrpc: "2.0" },
		]
		const answers = await Promise.all(
			[undefined, "2025-03-26", "2025-11-25", MODERN].flatMap((version) =>
				bodies.map(async (body) =>
					codeOf(await read(await post(body, version ? { "mcp-protocol-version": version } : {}))),
				),
			),
		)
		expect(answers).toEqual([...Array.from({ length: 6 }, () => [202, undefined]), [400, -32600], [400, -32600]])
	})

	it("answers a notification with 202 and no body, in both eras", async () => {
		const legacy = await read(
			await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": "2025-11-25" }),
		)
		const notification = { jsonrpc: "2.0", method: "notifications/whatever", params: { _meta: META } }
		const modern = await read(await post(notification, { "mcp-protocol-version": MODERN }))
		expect([legacy.status, legacy.text, modern.status, modern.text]).toEqual([202, "", 202, ""])
	})
})

describe("files and sessions over HTTP", () => {
	it("refuses a file path as a tool error naming the rule, in both eras, and sends nothing", async () => {
		const before = sent.length
		const args = { file: { path: "/etc/hostname" } }
		const params = { arguments: args, name: "upload" }
		const modern = await read(
			await post(
				{ id: 4, jsonrpc: "2.0", method: "tools/call", params: { ...params, _meta: META } },
				modernHeaders("upload"),
			),
		)
		const legacy = await read(
			await post({ id: 5, jsonrpc: "2.0", method: "tools/call", params }, { "mcp-protocol-version": "2025-11-25" }),
		)
		const refusal = [true, { message: "Invalid arguments: file is a path, which only the stdio server reads" }]
		expect([resultOf(modern), resultOf(legacy), sent.length - before]).toEqual([refusal, refusal, 0])
	})

	it("mints no session id on any answer and ignores one sent", async () => {
		const clientInfo = { name: "t", version: "1" }
		const initialize = {
			id: 1,
			jsonrpc: "2.0",
			method: "initialize",
			params: { capabilities: {}, clientInfo, protocolVersion: "2025-11-25" },
		}
		const forged = { "mcp-protocol-version": "2025-11-25", "mcp-session-id": "forged" }
		const answers = [
			await post(initialize),
			await post({ jsonrpc: "2.0", method: "notifications/initialized" }, forged),
			await post(LIST, forged),
			await post(
				{ id: 3, jsonrpc: "2.0", method: "tools/call", params: { _meta: META, name: "echo" } },
				modernHeaders("echo"),
			),
			await heldCall(MODERN, 9),
			await post(LIST, { "mcp-protocol-version": "2099-01-01" }),
		]
		release()
		const shown = answers.map((answer) => [answer.status, answer.headers.get("mcp-session-id")])
		await Promise.all(answers.map((answer) => answer.text()))
		expect(shown).toEqual([
			[200, null],
			[202, null],
			[200, null],
			[200, null],
			[200, null],
			[400, null],
		])
	})
})

describe("SSE", () => {
	it("streams a call's progress as SSE, unbuffered, then its result, and ends the stream", async () => {
		release()
		const response = await heldCall("2025-11-25", 11)
		const reader = (response.body as ReadableStream<Uint8Array>).getReader()
		const first = new TextDecoder().decode((await reader.read()).value)
		release()
		const events = (await eventsOf(reader, first)).map((event) => {
			const message = JSON.parse(event.replace("event: message\ndata: ", "")) as Record<string, unknown>
			return message.method ?? message.id
		})
		const headers = ["content-type", "x-accel-buffering", "cache-control"].map((name) => response.headers.get(name))
		expect([headers, events]).toEqual([
			["text/event-stream", "no", "no-cache"],
			["notifications/progress", 11],
		])
	})
})

describe("cancellation by era", () => {
	it("in 2026-07-28, cancels the call when its stream is closed", async () => {
		release()
		const count = ended.length + 1
		const reader = ((await heldCall(MODERN, 12)).body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await reader.cancel()
		/* a cancel aborts the call at once; released after it, a call it missed would end released */
		release()
		expect(await nextEnd(count)).toBe("aborted")
	})

	it("in 2026-07-28, cancels the call when its request is aborted before any answer", async () => {
		release()
		const count = ended.length + 1
		const abort = new AbortController()
		const params = { _meta: META, name: "hold" }
		const answered = post({ id: 13, jsonrpc: "2.0", method: "tools/call", params }, modernHeaders("hold"), {
			signal: abort.signal,
		})
		await holding(1)
		abort.abort()
		release()
		await answered
		expect(await nextEnd(count)).toBe("aborted")
	})

	it("in 2025-11-25, reads neither a closed stream nor an aborted request as a cancel: the call runs on", async () => {
		release()
		const count = ended.length + 1
		const reader = ((await heldCall("2025-11-25", 14)).body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await reader.cancel()
		const abort = new AbortController()
		const call = { id: 15, jsonrpc: "2.0", method: "tools/call", params: { name: "hold" } }
		void post(call, { "mcp-protocol-version": "2025-11-25" }, { signal: abort.signal })
		await holding(2)
		abort.abort()
		release()
		expect([await nextEnd(count), await nextEnd(count + 1)]).toEqual(["released", "released"])
	})
})
