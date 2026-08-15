import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("SSE backpressure", () => {
	it("send() returns a promise that resolves after write", async () => {
		const app = honey()
		let sendResult: unknown = "not-set"

		app.get("/sse").handler((ctx) => {
			return ctx.res.sse(async (stream) => {
				sendResult = stream.send({ data: "test", event: "msg" })
				stream.close()
			})
		})

		const res = await app.fetch(new Request("http://localhost/sse"), {})
		const reader = res.body?.getReader()
		if (reader) {
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}
		}

		/* send() must return a Promise, not void/undefined */
		expect(sendResult).toBeInstanceOf(Promise)
	})
})
