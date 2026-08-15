import { describe, expect, test } from "bun:test"
import type { WSAdapter } from "@lovrozagar/honey"
import { createApp } from "../src/app.ts"

const stubWs: WSAdapter = {
	upgrade() {
		return {
			response: new Response("websocket upgrade not used in smoke", { status: 426 }),
			socket: {
				close() {},
				raw: { close() {}, readyState: 3, send() {} },
				get readyState() {
					return 3 as const
				},
				send() {},
			},
		}
	},
}

const app = createApp(stubWs)

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`http://honey.test${path}`, init), {})
}

describe("e2e surface consumes honey", () => {
	test("GET /in/none", async () => {
		const res = await fetchApp("/in/none")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ping: "pong" })
	})

	test("POST /in/json", async () => {
		const res = await fetchApp("/in/json", {
			body: JSON.stringify({ email: "a@b.c", name: "Ada" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(201)
		expect(await res.json()).toEqual({ id: "1" })
	})

	test("GET /out/text", async () => {
		const res = await fetchApp("/out/text")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("hello world")
	})
})
