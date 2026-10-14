/**
 * Realtime end to end on a real node:http server: resume through the reference server (H8), on
 * the two public hooks alone, SSE `Last-Event-ID` and the WebSocket `reconnect_token`.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket as WsClient } from "ws"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { createReferenceServer } from "./conformance/reference-server.ts"

const servers: HoneyServer[] = []

const quiet = () => new Promise((resolve) => setTimeout(resolve, 50))

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

/** The reference server on a free loopback port, with `count` events already logged. */
async function reference(count: number) {
	const ref = createReferenceServer()
	for (let n = 1; n <= count; n++) ref.append({ n })
	const server = serve(ref.app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo
	return { ...ref, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` }
}

/** The first `count` frames a WebSocket client receives, parsed; the client then closes. */
function frames(url: string, count: number, onOpen?: () => void): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const client = new WsClient(url)
		const got: unknown[] = []
		client.on("open", () => onOpen?.())
		client.on("message", (data) => {
			got.push(JSON.parse(String(data)))
			if (got.length === count) {
				client.close()
				resolve(got)
			}
		})
		client.on("error", reject)
	})
}

/** The first `count` SSE events a client receives as `[id, data]`; the client then leaves. */
async function sseEvents(url: string, count: number, headers: Record<string, string> = {}, onOpen?: () => void) {
	const abort = new AbortController()
	const res = await fetch(url, { headers, signal: abort.signal })
	onOpen?.()
	const reader = (res.body as ReadableStream<Uint8Array>).getReader()
	const decoder = new TextDecoder()
	const events: [string, unknown][] = []
	let text = ""
	while (events.length < count) {
		const { value } = await reader.read()
		text += decoder.decode(value, { stream: true })
		const blocks = text.split("\n\n")
		text = blocks.pop() as string
		for (const block of blocks) {
			const fields = Object.fromEntries(block.split("\n").map((line) => line.split(": ", 2) as [string, string]))
			if (fields.id !== undefined) events.push([fields.id, JSON.parse(fields.data as string)])
		}
	}
	abort.abort()
	return [res.headers.get("content-type"), events.slice(0, count)] as const
}

describe("the reference server: WebSocket resume through onReconnect", () => {
	it("a fresh socket gets the whole log, then live events", async () => {
		const ref = await reference(2)
		const got = await frames(`${ref.ws}/events/ws`, 3, () => setTimeout(() => ref.append({ n: 3 }), 20))
		expect(got).toEqual([
			{ data: { n: 1 }, id: 1 },
			{ data: { n: 2 }, id: 2 },
			{ data: { n: 3 }, id: 3 },
		])
	})

	it("a reconnect_token resumes after that id, never replaying what the client already had", async () => {
		const ref = await reference(4)
		const got = await frames(`${ref.ws}/events/ws?reconnect_token=2`, 3, () =>
			setTimeout(() => ref.append({ n: 5 }), 20),
		)
		expect(got).toEqual([
			{ data: { n: 3 }, id: 3 },
			{ data: { n: 4 }, id: 4 },
			{ data: { n: 5 }, id: 5 },
		])
	})

	it.each([
		["not a whole number replays the whole log", "abc", [1, 2, "live"]],
		["past the head replays nothing", "99", ["live"]],
	])("a forged token is only data: one %s", async (_name, token, expected) => {
		const ref = await reference(2)
		const got = await frames(`${ref.ws}/events/ws?reconnect_token=${token}`, expected.length, () =>
			setTimeout(() => ref.append("live"), 20),
		)
		expect(got.map((frame) => (frame as { data: unknown; id: number }).data)).toEqual(
			expected.map((n) => (n === "live" ? "live" : { n })),
		)
	})

	it("a closed socket or a stream the client left stops following the log", async () => {
		const ref = await reference(1)
		let socketOpen = -1
		let streamOpen = -1
		await frames(`${ref.ws}/events/ws`, 1, () => (socketOpen = ref.following()))
		await quiet()
		const afterSocket = ref.following()
		await sseEvents(`${ref.base}/events`, 1, {}, () => (streamOpen = ref.following()))
		await quiet()
		expect([socketOpen, afterSocket, streamOpen, ref.following()]).toEqual([1, 0, 1, 0])
	})
})

describe("the reference server: SSE resume through Last-Event-ID", () => {
	it("posts append to the log; a fresh stream gets it all, then live events", async () => {
		const ref = await reference(0)
		const posted = await fetch(`${ref.base}/events`, { body: JSON.stringify({ n: 1 }), method: "POST" })
		const stream = await sseEvents(`${ref.base}/events`, 2, {}, () => setTimeout(() => ref.append({ n: 2 }), 20))
		expect([await posted.json(), stream]).toEqual([
			{ data: { n: 1 }, id: 1 },
			[
				"text/event-stream",
				[
					["1", { n: 1 }],
					["2", { n: 2 }],
				],
			],
		])
	})

	it("Last-Event-ID resumes after that id", async () => {
		const ref = await reference(3)
		const [, events] = await sseEvents(`${ref.base}/events`, 2, { "last-event-id": "1" })
		expect(events).toEqual([
			["2", { n: 2 }],
			["3", { n: 3 }],
		])
	})
})
