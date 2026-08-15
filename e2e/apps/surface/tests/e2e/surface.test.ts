import { expect, test } from "@playwright/test"

const WS_PORT = process.env.PORT ?? "4100"
const WS_HOST = process.env.WS_HOST ?? "localhost"
const WS_BASE = `ws://${WS_HOST}:${WS_PORT}`

function connectWs(path: string): {
	close(code?: number, reason?: string): void
	messages: string[]
	send(data: string): void
	waitForClose(): Promise<{ code: number; reason: string }>
	waitForMessages(count: number, timeout?: number): Promise<string[]>
} {
	const messages: string[] = []
	const listeners: Array<() => void> = []
	let closeResolve: ((v: { code: number; reason: string }) => void) | null = null
	const ws = new WebSocket(`${WS_BASE}${path}`)
	ws.onmessage = (evt) => {
		messages.push(typeof evt.data === "string" ? evt.data : String(evt.data))
		for (const cb of listeners) cb()
	}
	ws.onclose = (evt) => closeResolve?.({ code: evt.code, reason: evt.reason })
	return {
		close(code?: number, reason?: string) {
			ws.close(code, reason)
		},
		messages,
		send(data: string) {
			ws.send(data)
		},
		waitForClose() {
			return new Promise((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) {
					resolve({ code: 0, reason: "" })
					return
				}
				closeResolve = resolve
			})
		},
		waitForMessages(count: number, timeout = 5000) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(
							`Timeout: expected ${count} messages, got ${messages.length}: ${JSON.stringify(messages)}`,
						),
					)
				}, timeout)
				const check = () => {
					if (messages.length >= count) {
						clearTimeout(timer)
						resolve(messages.slice(0, count))
					}
				}
				listeners.push(check)
				check()
			})
		},
	}
}

test.describe("input sources", () => {
	test("POST /in/json", async ({ request }) => {
		const res = await request.post("/in/json", { data: { email: "a@b.c", name: "Ada" } })
		expect(res.status()).toBe(201)
		expect(await res.json()).toEqual({ id: "1" })
	})

	test("POST /in/form", async ({ request }) => {
		const res = await request.post("/in/form", {
			form: { password: "x", username: "ada" },
		})
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ token: "t-ada" })
	})

	test("GET /in/search", async ({ request }) => {
		const res = await request.get("/in/search?limit=10&page=1")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ results: [] })
	})

	test("GET /in/headers", async ({ request }) => {
		const res = await request.get("/in/headers", {
			headers: { "x-api-key": "k", "x-request-id": "r1" },
		})
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ accepted: true })
	})

	test("GET /in/cookies", async ({ request }) => {
		const res = await request.get("/in/cookies", {
			headers: { cookie: "locale=en; sid=s1" },
		})
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ locale: "en", valid: true })
	})

	test("GET /in/params/:orgId/members/:memberId", async ({ request }) => {
		const res = await request.get("/in/params/org-1/members/m-2")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ memberId: "m-2", orgId: "org-1" })
	})

	test("GET /in/none", async ({ request }) => {
		const res = await request.get("/in/none")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ ping: "pong" })
	})

	test("POST /in/file multipart", async ({ request }) => {
		const res = await request.post("/in/file", {
			multipart: {
				title: "hello",
				upload: {
					buffer: Buffer.from("hi"),
					mimeType: "text/plain",
					name: "hi.txt",
				},
			},
		})
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ name: "hi.txt", title: "hello" })
	})

	test("PUT /in/all/:resourceId combo", async ({ request }) => {
		const res = await request.put("/in/all/r1?version=2", {
			data: { data: { k: "v" } },
			headers: { "if-match": "W/\"1\"" },
		})
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ etag: 'W/"abc"', version: 2 })
	})
})

test.describe("output types", () => {
	test("GET /out/text", async ({ request }) => {
		const res = await request.get("/out/text")
		expect(res.status()).toBe(200)
		expect(await res.text()).toBe("hello world")
	})

	test("GET /out/html", async ({ request }) => {
		const res = await request.get("/out/html")
		expect(res.status()).toBe(200)
		expect(await res.text()).toContain("<h1>Hello</h1>")
	})

	test("GET /out/csv", async ({ request }) => {
		const res = await request.get("/out/csv")
		expect(res.status()).toBe(200)
		expect(await res.text()).toContain("Alice")
	})

	test("GET /out/xml", async ({ request }) => {
		const res = await request.get("/out/xml")
		expect(res.status()).toBe(200)
		expect(await res.text()).toContain("<user>")
	})

	test("GET /out/binary", async ({ request }) => {
		const res = await request.get("/out/binary")
		expect(res.status()).toBe(200)
		const body = await res.body()
		expect(body).toEqual(Buffer.from([0x48, 0x49]))
	})

	test("GET /out/sse", async ({ request }) => {
		const res = await request.get("/out/sse")
		expect(res.status()).toBe(200)
		expect(res.headers()["content-type"]).toMatch(/text\/event-stream/)
		const text = await res.text()
		expect(text).toContain("event: heartbeat")
		expect(text).toContain("event: data")
	})

	test("POST /out/multi-status created", async ({ request }) => {
		const res = await request.post("/out/multi-status", { data: { slug: "ada" } })
		expect(res.status()).toBe(201)
		expect(await res.json()).toEqual({ id: "1", slug: "ada" })
	})

	test("DELETE /out/no-content/:id", async ({ request }) => {
		const res = await request.delete("/out/no-content/1")
		expect(res.status()).toBe(204)
	})
})

test.describe("methods and status keys", () => {
	test("GET/POST/PUT/PATCH/DELETE /methods/resource", async ({ request }) => {
		expect((await request.get("/methods/resource")).status()).toBe(200)
		expect((await request.post("/methods/resource", { data: { name: "n" } })).status()).toBe(201)
		expect((await request.put("/methods/resource/1", { data: { name: "n" } })).status()).toBe(200)
		expect((await request.patch("/methods/resource/1", { data: {} })).status()).toBe(200)
		expect((await request.delete("/methods/resource/1")).status()).toBe(204)
	})

	test("status keys 200/201/202/204", async ({ request }) => {
		expect((await request.get("/status/ok")).status()).toBe(200)
		expect((await request.post("/status/created", { data: { x: "a" } })).status()).toBe(201)
		expect((await request.post("/status/accepted", { data: { task: "t" } })).status()).toBe(202)
		expect((await request.delete("/status/no-content")).status()).toBe(204)
	})
})

test.describe("streams and uploads", () => {
	test("GET /stream/filtered SSE uses search", async ({ request }) => {
		const res = await request.get("/stream/filtered?channel=news")
		expect(res.status()).toBe(200)
		expect(await res.text()).toContain("news")
	})

	test("POST /rs/upload readableStream json", async ({ request }) => {
		const res = await request.post("/rs/upload", {
			data: { chunks: 3, fileName: "a.bin" },
		})
		expect(res.status()).toBe(202)
		expect(await res.json()).toEqual({ uploadId: "up-1" })
	})
})

test.describe("websocket", () => {
	test("GET without Upgrade to /ws/echo → 426", async ({ request }) => {
		const res = await request.get("/ws/echo")
		expect(res.status()).toBe(426)
	})

	test("echo: greeting then echo", async () => {
		const ws = connectWs("/ws/echo")
		const first = await ws.waitForMessages(1)
		expect(first[0]).toBe("connected")
		ws.send("ping")
		const both = await ws.waitForMessages(2)
		expect(both[1]).toBe("ping")
		ws.close(1000)
		await ws.waitForClose()
	})

	test("room search input", async () => {
		const ws = connectWs("/ws/room?roomId=lobby")
		const first = await ws.waitForMessages(1)
		expect(first[0]).toBe("joined")
		ws.close(1000)
		await ws.waitForClose()
	})
})

test.describe("openapi", () => {
	test("GET /openapi.json includes surface paths", async ({ request }) => {
		const res = await request.get("/openapi.json")
		expect(res.status()).toBe(200)
		const spec = await res.json()
		expect(spec.info.title).toBe("Honey Surface")
		expect(spec.paths["/in/json"]).toBeDefined()
		expect(spec.paths["/out/text"]).toBeDefined()
		expect(spec.paths["/methods/resource"]).toBeDefined()
	})
})
