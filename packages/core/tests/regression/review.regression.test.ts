/**
 * Code-review findings, frozen as regressions: a scope over a non-ASCII literal covers every
 * percent-escape spelling of it, in requests and in route literals; realtime routes keep their
 * topics apart across mounts.
 */
import { describe, expect, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { realtime } from "../../src/realtime/realtime.ts"
import type { ConnContext } from "../../src/realtime/route.ts"
import { honey } from "../../src/routing/app.ts"
import type { WSAdapter, WSContext } from "../../src/ws/contract.ts"

async function send(app: { fetch: (r: Request, env: never) => Response | Promise<Response> }, target: string) {
	const res = await app.fetch(new Request(`http://x${target}`), {} as never)
	return { body: await res.text(), status: res.status }
}

const denied = { body: "denied", status: 401 }
const deny = createMiddleware(() => new Response("denied", { status: 401 }))

describe("scopes over non-ASCII literals", () => {
	// regression: R1
	// v0: 52889f76ac
	it.each(["/%C3%A9", "/%c3%a9", "/%c3%A9"])(
		"R1: a scope over /é guards %s, whatever the escape case",
		async (target) => {
			const app = honey<{}>()
			app.use("/é", deny)
			app.get("/:slug").handler((ctx) => ctx.res.text("ok", ctx.params.slug))
			expect(await send(app, target)).toEqual(denied)
			expect(await send(app, "/other")).toEqual({ body: "other", status: 200 })
		},
	)

	// regression: R1
	// v0: b748dd1251
	it("R1: a route literal written with lowercase escapes is covered by the scope", async () => {
		const app = honey<{}>()
		app.use("/é", deny)
		app.get("/%c3%a9/x").handler((ctx) => ctx.res.text("ok", "x"))
		for (const target of ["/%C3%A9/x", "/%c3%a9/x"]) expect(await send(app, target)).toEqual(denied)
	})
})

/** An adapter that opens each upgrade at once; `message` drives a socket, `sent` reads what it got. */
function openingAdapter() {
	const sockets: { message(data: string): void; sent: unknown[] }[] = []
	const adapter: WSAdapter = {
		upgrade(_req, _env, handler) {
			const sent: unknown[] = []
			const socket: WSContext = {
				close: () => {},
				raw: null,
				readyState: 1,
				send: (data) => void sent.push(JSON.parse(data as string)),
			}
			sockets.push({ message: (data) => handler.onMessage?.(undefined, socket, data), sent })
			handler.onOpen?.(undefined, socket)
			const response = new Response(null)
			Object.defineProperty(response, "status", { value: 101 })
			return { response, socket }
		},
	}
	return { adapter, sockets }
}

const upgrade = (path: string) =>
	new Request(`http://x${path}`, { headers: { connection: "Upgrade", upgrade: "websocket" } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** Join `t`, and echo each frame to it. */
const echo = (_ctx: unknown, conn: ConnContext) => {
	conn.join("t")
	conn.on("message", (payload) => conn.publish("t", payload))
}

describe("realtime topics across mounts", () => {
	// regression: R2
	// v0: afa4f6f08b — v1: one realtime() call is one bus and namespace however often it is mounted; a call per mount keeps mounts apart (ruling 12)
	it("R2: a sub-app mounted twice shares its one realtime route; a realtime() per mount keeps them apart", async () => {
		const { adapter, sockets } = openingAdapter()
		const shared = honey<{}>()
		realtime(shared, "/chat", { handler: echo })
		const [v3, v4] = [honey<{}>(), honey<{}>()]
		for (const sub of [v3, v4]) realtime(sub, "/chat", { handler: echo })
		const app = honey<{}>().wsAdapter(adapter)
		app.route("/v1", shared)
		app.route("/v2", shared)
		app.route("/v3", v3)
		app.route("/v4", v4)
		for (const path of ["/v1/chat", "/v2/chat", "/v3/chat", "/v4/chat"]) await app.fetch(upgrade(path), {})
		await tick()
		sockets[0]?.message('"from v1"')
		sockets[2]?.message('"from v3"')
		await tick()
		expect(sockets.map((socket) => socket.sent)).toEqual([["from v1"], ["from v1"], ["from v3"], []])
	})

	// regression: R2
	// v0: b61aa4e878
	it("R2: a mounted realtime route does not share topics with the parent's route of the sub's path", async () => {
		const { adapter, sockets } = openingAdapter()
		const sub = honey<{}>()
		realtime(sub, "/chat", { handler: echo })
		const app = honey<{}>().wsAdapter(adapter)
		realtime(app, "/chat", { handler: (_ctx, conn) => conn.join("t") })
		app.route("/v1", sub)
		await app.fetch(upgrade("/v1/chat"), {})
		await app.fetch(upgrade("/chat"), {})
		await tick()
		sockets[0]?.message('"from v1"')
		await tick()
		expect(sockets.map((socket) => socket.sent)).toEqual([["from v1"], []])
	})
})
