/**
 * Regression guards for the `/code-review high 3ab88ce..HEAD` findings R1–R7
 * (docs/regression-matrix/review.md). Each test reproduces the reported scenario; R8 (the Python
 * SDK) lives in regression/ws9-12/polyglot.regression.test.ts.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { accepts } from "../../src/accepts.ts"
import { writeOutputDir } from "../../src/gen-write.ts"
import { createMiddleware, honey, mergeTree } from "../../src/index.ts"
import { createLogger, logger } from "../../src/logger.ts"
import type { RouteTree } from "../../src/tree.ts"
import type { WSAdapter, WSHandler } from "../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../src/ws/cloudflare.ts"
import "../../src/realtime/register.ts"

const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

/* Node's Response rejects 101; the CF adapter's Response allows it */
function make101(): Response {
	const res = new Response(null, { status: 200 })
	Object.defineProperty(res, "status", { value: 101 })
	return res
}

type Socket = {
	handler: WSHandler<unknown>
	message(data: string): void
	open(): void
	sent(): unknown[]
}

/** WS adapter whose sockets a test drives by hand, opening them only when asked to. */
function manualAdapter(opts: { openOnUpgrade: boolean }) {
	const sockets: Socket[] = []
	const adapter: WSAdapter = {
		upgrade(_req, _env, handler: WSHandler<unknown>) {
			const raw = {
				bufferedAmount: 0,
				close: vi.fn<(code?: number, reason?: string) => void>(),
				/* Bun and Deno: the socket is not open until onOpen fires */
				readyState: opts.openOnUpgrade ? 1 : 0,
				send: vi.fn<(data: unknown) => void>(),
			}
			const ws = new WSContextImpl(raw)
			const socket: Socket = {
				handler,
				message: (data) => handler.onMessage?.(undefined, ws, data),
				open: () => {
					raw.readyState = 1
					handler.onOpen?.(undefined, ws)
				},
				sent: () => raw.send.mock.calls.map((c) => JSON.parse(c[0] as string)),
			}
			sockets.push(socket)
			if (opts.openOnUpgrade) socket.open()
			return { response: make101(), socket: ws }
		},
	}
	return { adapter, sockets }
}

function upgrade(path: string): Request {
	return new Request(`http://localhost${path}`, { headers: { connection: "Upgrade", upgrade: "websocket" } })
}

const tick = () => new Promise((r) => setTimeout(r, 5))

function acceptReq(header: string): Request {
	return new Request("http://x/", { headers: { accept: header } })
}

describe("code review regressions", () => {
	// regression: R1
	it("R1: a scope over a non-ASCII literal guards lowercase percent-escapes too", async () => {
		const app = honey()
		app.use("/é", deny)
		app.get("/:slug").handler((c) => c.res.json("ok", { slug: c.params.slug }))
		for (const path of ["/%C3%A9", "/%c3%a9", "/%c3%A9"]) {
			expect((await app.fetch(new Request(`http://x${path}`), {})).status, path).toBe(401)
		}
		expect((await app.fetch(new Request("http://x/other"), {})).status).toBe(200)
	})

	// regression: R1
	it("R1: a route literal written with lowercase escapes is covered by the scope", async () => {
		const app = honey()
		app.use("/é", deny)
		app.get("/%c3%a9/x").handler((c) => c.res.json("ok", {}))
		expect((await app.fetch(new Request("http://x/%C3%A9/x"), {})).status).toBe(401)
		expect((await app.fetch(new Request("http://x/%c3%a9/x"), {})).status).toBe(401)
	})

	// regression: R2
	it.fails("R2: one sub-app mounted twice keeps two realtime namespaces", async () => {
		const { adapter, sockets } = manualAdapter({ openOnUpgrade: true })
		const sub = honey().realtime("/chat", {
			handler: (_c, conn) => {
				conn.join("t")
				conn.on("message", (p) => conn.publish("t", p))
			},
		})
		const app = honey().wsAdapter(adapter)
		app.route("/v1", sub)
		app.route("/v2", sub)
		await app.fetch(upgrade("/v1/chat"), {})
		await app.fetch(upgrade("/v2/chat"), {})
		await tick()
		sockets[0]!.message('"from v1"')
		await tick()
		expect(sockets[0]!.sent()).toEqual(["from v1"])
		expect(sockets[1]!.sent()).toEqual([])
	})

	// regression: R2
	it.fails("R2: a mounted realtime route does not share topics with the parent's route of the sub's path", async () => {
		const { adapter, sockets } = manualAdapter({ openOnUpgrade: true })
		const sub = honey().realtime("/chat", {
			handler: (_c, conn) => {
				conn.join("t")
				conn.on("message", (p) => conn.publish("t", p))
			},
		})
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/chat", { handler: (_c, conn) => conn.join("t") })
		app.route("/v1", sub)
		await app.fetch(upgrade("/v1/chat"), {})
		await app.fetch(upgrade("/chat"), {})
		await tick()
		sockets[0]!.message('"from v1"')
		await tick()
		expect(sockets[1]!.sent()).toEqual([])
	})

	// regression: R3
	it.fails("R3: a log sink that throws on the request line never fails the request", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const instance = createLogger({
				write: () => {
					throw new Error("EPIPE")
				},
			})
			const app = honey()
				.use(logger({ instance }))
				.get("/")
				.handler((c) => c.res.json("ok", { ok: true }))
			const res = await app.fetch(new Request("http://x/"), {})
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ ok: true })
		} finally {
			spy.mockRestore()
		}
	})

	// regression: R4
	it.fails("R4: a parameterized range does not override the plain range for a type without those parameters", () => {
		expect(accepts(acceptReq("application/json;v=2;q=0, application/json"), ["application/json"])).toBe(
			"application/json",
		)
		expect(
			accepts(acceptReq("text/html;level=1;q=0.1, text/html, application/json;q=0.5"), [
				"application/json",
				"text/html",
			]),
		).toBe("text/html")
	})

	// regression: R4
	it("R4: a parameterized range still applies to a supported type with matching parameters", () => {
		expect(accepts(acceptReq("application/json;v=2;q=0, application/json"), ["application/json;v=2"])).toBeNull()
		expect(accepts(acceptReq("text/html;level=1, */*;q=0.1"), ["application/json", "text/html;level=1"])).toBe(
			"text/html;level=1",
		)
	})

	// regression: R5
	it.fails("R5: a gateway whose every own route shadows a downstream route fails generation", () => {
		const down = honey()
		down.get("/health").handler((c) => c.res.json("ok", { from: "down" }))
		down.get("/users").handler((c) => c.res.json("ok", {}))
		const gw = honey()
		gw.get("/health").handler((c) => c.res.json("ok", { from: "gateway" }))
		gw.all("/*").handler((c) => c.res.json("ok", {}))
		const source = mergeTree([down.toRouteTree(), { worker: "down" }]) as RouteTree
		expect(() => (gw as unknown as { _gatewayTree(t: RouteTree): RouteTree })._gatewayTree(source)).toThrow(
			/GET \/health/,
		)
	})

	// regression: R5
	it("R5: a merge source built from the gateway app itself is still accepted", () => {
		const build = () => {
			const app = honey()
			app.get("/health").handler((c) => c.res.json("ok", {}))
			app.post("/items").handler((c) => c.res.json("ok", {}))
			return app
		}
		const gw = build()
		const source = build().toRouteTree()
		expect(() => (gw as unknown as { _gatewayTree(t: RouteTree): RouteTree })._gatewayTree(source)).not.toThrow()
	})

	// regression: R6
	it.fails("R6: a realtime frame that beat the open is delivered before frames that arrive later", async () => {
		const { adapter, sockets } = manualAdapter({ openOnUpgrade: false })
		const got: unknown[] = []
		let attach: () => void = () => {}
		const attached = new Promise<void>((r) => (attach = r))
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: async (_c, conn) => {
					await attached
					conn.on("message", (p) => {
						got.push(p)
					})
				},
			})
		await app.fetch(upgrade("/rt"), {})
		const s = sockets[0]!
		s.message('"A"')
		s.open()
		s.message('"B"')
		attach()
		await tick()
		s.message('"C"')
		await tick()
		expect(got).toEqual(["A", "B", "C"])
	})

	describe("R7", () => {
		const ROOT = resolve(import.meta.dirname, "../../.tmp-review-r7")
		afterEach(() => rmSync(ROOT, { force: true, recursive: true }))

		// regression: R7
		it.fails("R7: a stale manifest entry whose directory the user deleted does not abort generation", () => {
			mkdirSync(ROOT, { recursive: true })
			writeOutputDir(ROOT, { "main.go": "package main\n", "models/x.go": "package models\n" })
			rmSync(join(ROOT, "models"), { force: true, recursive: true })
			expect(() => writeOutputDir(ROOT, { "main.go": "package main\n" })).not.toThrow()
			const manifest = JSON.parse(readFileSync(join(ROOT, ".honey-generated.json"), "utf-8")) as { files: string[] }
			expect(manifest.files).toEqual(["main.go"])
			expect(existsSync(join(ROOT, "models"))).toBe(false)
		})
	})
})
