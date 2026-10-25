/**
 * The TS SDK's event-stream open, bounded (bit 19 b2): the call's timeout bounds an explicit stream up to its response
 * headers, as `requestAuto` already did, so an answer that never comes fails the iteration at the timeout with a
 * TimeoutError; once the headers arrive the stream is exempt, so a silence mid-stream longer than the timeout is never
 * cut. A five-second latch stands for "never", so an unbounded open reads as a value, not a hang.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

/** `GET /events`, an event stream: the SDK method `events.list`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/events": {
			get: {
				operationId: "events.list",
				responses: { "200": { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } },
			},
		},
	},
}

type Stream = AsyncIterable<{ data: string }>

/** The datas `events.list()` yields under `timeout` with `fetch`, or how it failed, or `"unbounded"` past 5 s. */
async function streamed(fetch: typeof globalThis.fetch, timeout: number): Promise<unknown> {
	const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
		TestSDK: new (config: object) => { events: { list: () => Stream } }
	}
	const read = (async () => {
		const datas: string[] = []
		for await (const event of new TestSDK({ baseURL: "https://api.test", fetch, timeout }).events.list())
			datas.push(event.data)
		return datas
	})().catch((error: Error) => `${error.name}: ${error.message}`)
	let latch: ReturnType<typeof setTimeout> | undefined
	const unbounded = new Promise<string>((resolve) => (latch = setTimeout(() => resolve("unbounded"), 5_000)))
	try {
		return await Promise.race([read, unbounded])
	} finally {
		clearTimeout(latch)
	}
}

/** An answer that never comes: the request's own abort is the only way out. */
const silent = recordingFetch(
	(request) =>
		new Promise<Response>((_, reject) =>
			request.signal.addEventListener("abort", () => reject(request.signal.reason as Error), { once: true }),
		),
)

/** An event stream: one event, `gapMs` of silence, a second. */
function gapped(gapMs: number): Response {
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(encoder.encode("data: 1\n\n"))
			await new Promise((resolve) => setTimeout(resolve, gapMs))
			controller.enqueue(encoder.encode("data: 2\n\n"))
			controller.close()
		},
	})
	return new Response(body, { headers: { "content-type": "text/event-stream" }, status: 200 })
}

describe("the TS SDK's event-stream open is bounded by the call's timeout, its body never (bit 19 b2)", () => {
	it("fails a stream whose answer never comes at its 300 ms timeout, as a TimeoutError", async () => {
		expect(await streamed(silent.fetch, 300)).toBe("TimeoutError: Request timed out after 300 ms")
	})

	it("keeps a stream that opened in time through an 800 ms silence past its 300 ms timeout", async () => {
		expect(await streamed(recordingFetch(() => gapped(800)).fetch, 300)).toEqual(["1", "2"])
	})
})

describe("the open's bound ends with the headers, over Node's own fetch (bit 19 b2)", () => {
	it("reads every event of a local stream through an 800 ms silence past its 300 ms timeout: no abort cuts its body", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write("data: 1\n\n")
			setTimeout(() => res.end("data: 2\n\n"), 800)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const { port } = server.address() as AddressInfo
		try {
			const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
				TestSDK: new (config: object) => { events: { list: () => Stream } }
			}
			const datas: string[] = []
			const ended = await (async () => {
				for await (const event of new TestSDK({ baseURL: `http://127.0.0.1:${port}`, timeout: 300 }).events.list())
					datas.push(event.data)
				return "ended"
			})().catch((error: Error) => `${error.name}: ${error.message}`)
			expect([datas, ended]).toEqual([["1", "2"], "ended"])
		} finally {
			server.closeAllConnections()
			await new Promise((resolve) => server.close(resolve))
		}
	})
})
