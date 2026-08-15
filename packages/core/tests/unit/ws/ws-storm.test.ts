import { describe, expect, it } from "vitest"
import WebSocket from "ws"
import "@lovrozagar/honey/serve"
import { honey } from "../../../src/index.ts"

const N = 80

type Client = {
	inbox: string[]
	next(): Promise<string>
	ws: WebSocket
}

function open(url: string): Promise<Client> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		const inbox: string[] = []
		const waiters: Array<(s: string) => void> = []
		ws.on("message", (data) => {
			const text = String(data)
			const w = waiters.shift()
			if (w) w(text)
			else inbox.push(text)
		})
		const client: Client = {
			inbox,
			next() {
				if (inbox.length > 0) return Promise.resolve(inbox.shift() as string)
				return new Promise((res, rej) => {
					const t = setTimeout(() => rej(new Error("message timeout")), 3_000)
					waiters.push((s) => {
						clearTimeout(t)
						res(s)
					})
				})
			},
			ws,
		}
		ws.once("open", () => resolve(client))
		ws.once("error", reject)
	})
}

function onceClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		ws.once("close", (code, reason) => {
			resolve({ code, reason: reason.toString() })
		})
	})
}

describe("WS storm — node listen", () => {
	it("many sockets echo, broadcast, close code, reconnect", async () => {
		const room = new Set<{ send(data: string): void }>()
		const app = honey()
			.ws("/echo")
			.handler({
				onClose(_ctx, ws) {
					room.delete(ws)
				},
				onMessage(_ctx, ws, data) {
					const text = String(data)
					if (text === "boom") {
						for (const peer of room) peer.send(`all:${text}`)
						return
					}
					ws.send(`echo:${text}`)
				},
				onOpen(_ctx, ws) {
					room.add(ws)
					ws.send("hi")
				},
			})

		const handle = await app.serve({ hostname: "127.0.0.1", port: 0, runtime: "node" })
		const clients: Client[] = []
		try {
			const url = `${handle.url.replace("http", "ws")}/echo`
			for (let i = 0; i < N; i++) clients.push(await open(url))
			const hellos = await Promise.all(clients.map((c) => c.next()))
			expect(hellos.every((h) => h === "hi")).toBe(true)

			const echoed = await Promise.all(
				clients.map((c, i) => {
					const p = c.next()
					c.ws.send(`n${i}`)
					return p
				}),
			)
			expect(new Set(echoed).size).toBe(N)

			const blasts = clients.map((c) => c.next())
			clients[0]?.ws.send("boom")
			const all = await Promise.all(blasts)
			expect(all.every((m) => m === "all:boom")).toBe(true)

			const closed = onceClose(clients[0]!.ws)
			clients[0]!.ws.close(4000, "done")
			const got = await closed
			expect(got.code).toBe(4000)
			expect(got.reason).toBe("done")

			const again = await open(url)
			expect(await again.next()).toBe("hi")
			again.ws.close(1000)
			await onceClose(again.ws)
		} finally {
			for (const c of clients) {
				if (c.ws.readyState === WebSocket.OPEN) c.ws.close()
			}
			await handle.close()
		}
	}, 20_000)
})

describe("WS storm — wrangler", () => {
	it("opt-in only — default suite uses e2e:cf for workerd WS", () => {
		if (!process.env.HONEY_CF_WS_STORM) {
			expect(true).toBe(true)
			return
		}
		expect.fail("HONEY_CF_WS_STORM runner not wired — use bun run test:e2e:cf")
	})
})
