import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("SSE keepalive heartbeat", () => {
	it("sends heartbeat comments when keepalive is set", async () => {
		const h = honey<{}>()

		h.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (stream) => {
					stream.send({ data: "hello", event: "msg", id: "1" })
					/* wait for keepalive to fire */
					await new Promise((r) => setTimeout(r, 80))
					stream.close()
				},
				{ keepalive: 30 },
			),
		)

		const res = await h.fetch(new Request("http://localhost/events"), {})
		const text = await res.text()
		expect(text).toContain("data: hello")
		expect(text).toContain(": heartbeat")
	})

	it("no heartbeat when keepalive is not set", async () => {
		const h = honey<{}>()

		h.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				stream.send({ data: "hello", event: "msg" })
				stream.close()
			}),
		)

		const res = await h.fetch(new Request("http://localhost/events"), {})
		const text = await res.text()
		expect(text).not.toContain(": heartbeat")
		expect(text).toContain("data: hello")
	})
})

describe("SSE lastEventId and defaultRetry", () => {
	it("exposes Last-Event-ID from request header on stream", async () => {
		const h = honey<{}>()
		let receivedId: string | undefined

		h.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				receivedId = stream.lastEventId
				stream.send({ data: "resumed", event: "msg" })
				stream.close()
			}),
		)

		await h.fetch(
			new Request("http://localhost/events", {
				headers: { "last-event-id": "evt-42" },
			}),
			{},
		)

		expect(receivedId).toBe("evt-42")
	})

	it("lastEventId is undefined when no header present", async () => {
		const h = honey<{}>()
		let receivedId: string | undefined = "should-be-undefined"

		h.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				receivedId = stream.lastEventId
				stream.close()
			}),
		)

		await h.fetch(new Request("http://localhost/events"), {})
		expect(receivedId).toBeUndefined()
	})

	it("sends retry directive when defaultRetry is set", async () => {
		const h = honey<{}>()

		h.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (stream) => {
					stream.send({ data: "hello", event: "msg" })
					stream.close()
				},
				{ defaultRetry: 3000 },
			),
		)

		const res = await h.fetch(new Request("http://localhost/events"), {})
		const text = await res.text()
		expect(text).toContain("retry: 3000")
	})
})
