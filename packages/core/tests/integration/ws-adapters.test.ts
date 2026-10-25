/**
 * app.ws(path) through every adapter: one self-contained app, one outcome table. Node serves it on
 * real sockets, a spawned `bun` serves the same function from its source, and Workers runs it over
 * a stubbed WebSocketPair. Bun's one difference is pinned (Ruling 13): past maxPayload it
 * force-closes with 1006 where Node and Workers close with 1009.
 */
import { spawn } from "node:child_process"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket as WsClient } from "ws"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { honey } from "../../src/routing/app.ts"
import { cfWebSocket } from "../../src/ws/cloudflare.ts"
import type { WSAdapter } from "../../src/ws/contract.ts"
import { nodeWebSocket } from "../../src/ws/node.ts"

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
	vi.unstubAllGlobals()
})

/** Serve `app` on a free loopback port. */
async function listen(app: { fetch(request: Request, env: unknown): Response | Promise<Response> }) {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	return { port: (server.address() as AddressInfo).port }
}

/**
 * One app for every adapter: echo, close, ordered callbacks, a throwing handler, a handler that
 * never settles. Self-contained, so a spawned `bun` runs this same function from its source.
 */
function scenarioApp(make: typeof honey, adapter: WSAdapter) {
	const app = make<{}>().wsAdapter(adapter)
	app.ws("/echo").handler({ onMessage: (_ctx, ws, data) => ws.send(data) })
	app.ws("/close").handler({ onMessage: (_ctx, ws) => ws.close(4001, "é".repeat(100)) })
	app.ws("/order").handler({
		onMessage: (_ctx, ws, data) => ws.send(`msg:${String(data)}`),
		onOpen: async (_ctx, ws) => {
			await new Promise((resolve) => setTimeout(resolve, 30))
			ws.send("open")
		},
	})
	app.ws("/throw").handler({
		onMessage: (_ctx, ws, data) => {
			if (data === "boom") throw new Error("boom")
			ws.send(data)
		},
	})
	app.ws("/reject").handler({
		onMessage: async (_ctx, ws, data) => {
			if (data === "boom") throw new Error("boom")
			ws.send(data)
		},
		onOpen: () => {
			throw new Error("open failed")
		},
	})
	app.ws("/stall").handler({ onMessage: () => new Promise(() => {}) })
	return app
}

type Scenario = { headers?: Record<string, string>; path: string; protocols?: string[]; sends: (string | Uint8Array)[] }
type Outcome = { close?: number; protocol: string; reason?: string; received: string[]; status: number }

const evil = { cookie: "sid=1", origin: "https://evil.example" }
const SCENARIOS: [string, Scenario, Outcome][] = [
	[
		"echoes text and binary",
		{ path: "/echo", sends: ["hi", new Uint8Array([1, 2, 3])] },
		{ protocol: "", received: ["hi", "bin:1,2,3"], status: 101 },
	],
	[
		"selects the first offered subprotocol",
		{ path: "/echo", protocols: ["chat", "json"], sends: [] },
		{ protocol: "chat", received: [], status: 101 },
	],
	[
		"refuses a credentialed cross-origin upgrade (H18.12)",
		{ headers: evil, path: "/echo", sends: [] },
		{ protocol: "", received: [], status: 403 },
	],
	// v0: 6d1310444e
	[
		"closes with the code, the reason cut to 123 UTF-8 bytes",
		{ path: "/close", sends: ["x"] },
		{ close: 4001, protocol: "", reason: "é".repeat(61), received: [], status: 101 },
	],
	[
		"runs an async onOpen before the first message",
		{ path: "/order", sends: ["1"] },
		{ protocol: "", received: ["open", "msg:1"], status: 101 },
	],
	[
		"keeps serving after a handler throws",
		{ path: "/throw", sends: ["boom", "ok"] },
		{ protocol: "", received: ["ok"], status: 101 },
	],
	// v0: 3f7c9c098f
	[
		"stays a WebSocket and keeps serving after onOpen throws and onMessage rejects",
		{ path: "/reject", sends: ["boom", "still"] },
		{ protocol: "", received: ["still"], status: 101 },
	],
	// v0: 6f634ad036
	[
		"closes 1009 on a frame over maxPayload",
		{ path: "/echo", sends: ["x".repeat(2048)] },
		{ close: 1009, protocol: "", reason: expect.any(String), received: [], status: 101 },
	],
	[
		"closes 1008 once 1024 messages wait",
		{ path: "/stall", sends: Array.from({ length: 1100 }, () => "m") },
		{ close: 1008, protocol: "", reason: expect.any(String), received: [], status: 101 },
	],
]

const shown = (data: ArrayBuffer | string | Uint8Array) =>
	typeof data === "string" ? data : `bin:${[...new Uint8Array(data as ArrayBuffer)].join(",")}`

/** Settled once every expected frame and the expected close arrived, or after 1 s. */
const complete = (out: Outcome, expected: Outcome) =>
	out.received.length >= expected.received.length && (expected.close === undefined || out.close !== undefined)

/** A scenario through a real client against `base` (ws://host:port). */
function overSocket(base: string, scenario: Scenario, expected: Outcome): Promise<Outcome> {
	return new Promise((resolve) => {
		const client = new WsClient(base + scenario.path, scenario.protocols ?? [], {
			headers: scenario.headers,
			origin: scenario.headers?.origin,
		})
		const out: Outcome = { protocol: "", received: [], status: 101 }
		let done = false
		/* terminating fires a 1006 close of our own: nothing after the finish counts */
		const finish = () => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve({ ...out })
			client.terminate()
		}
		const timer = setTimeout(finish, 1_000)
		const check = () => complete(out, expected) && finish()
		client.on("unexpected-response", (_req, res) => {
			out.status = res.statusCode as number
			finish()
		})
		client.on("open", () => {
			out.protocol = client.protocol
			for (const data of scenario.sends) client.send(data)
			check()
		})
		client.on("message", (data, binary) => {
			out.received.push(binary ? shown(data as Buffer) : String(data))
			check()
		})
		client.on("close", (code, reason) => {
			Object.assign(out, { close: code, reason: reason.toString() })
			finish()
		})
		client.on("error", () => {})
	})
}

/** One side of a stubbed Workers WebSocketPair: events in, sends and closes recorded. */
class PairSocket extends EventTarget {
	closed: [number, string][] = []
	readyState = 1
	sent: (ArrayBuffer | string)[] = []
	accept() {}
	close(code: number, reason: string) {
		this.closed.push([code, reason])
	}
	send(data: ArrayBuffer | string) {
		this.sent.push(data)
	}
}

/** A scenario through cfWebSocket over a stubbed WebSocketPair, as Workers would run it. */
async function overWorkers(scenario: Scenario, expected: Outcome): Promise<Outcome> {
	const serverSides: PairSocket[] = []
	vi.stubGlobal("WebSocketPair", function WebSocketPair() {
		const server = new PairSocket()
		serverSides.push(server)
		return [new PairSocket(), server]
	})
	const app = scenarioApp(honey, cfWebSocket({ maxPayload: 1024 }))
	const headers: Record<string, string> = { connection: "Upgrade", upgrade: "websocket", ...scenario.headers }
	if (scenario.protocols) headers["sec-websocket-protocol"] = scenario.protocols.join(", ")
	const res = await app.fetch(new Request(`https://app.example.com${scenario.path}`, { headers }), {})
	const out: Outcome = { protocol: res.headers.get("sec-websocket-protocol") ?? "", received: [], status: res.status }
	const server = serverSides[0]
	if (server === undefined) return out
	for (const data of scenario.sends) {
		server.dispatchEvent(new MessageEvent("message", { data: typeof data === "string" ? data : data.slice().buffer }))
	}
	for (let waited = 0; waited < 1_000; waited += 10) {
		out.received = server.sent.map(shown)
		const [close] = server.closed
		if (close !== undefined) Object.assign(out, { close: close[0], reason: close[1] })
		if (complete(out, expected)) break
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	return out
}

const SRC = fileURLToPath(new URL("../../src/", import.meta.url))

/** A `bun` process serving scenarioApp; it prints its port, and exits on any stdin input. */
/** Whether Bun `version` drops an over-limit connection with no close frame, as it did before 1.4.4. */
const closesAbruptly = (version: string) => {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number)
	return major * 1e6 + minor * 1e3 + patch < 1_004_004
}

const BUN_APP = `
const { serve } = await import(${JSON.stringify(`${SRC}adapters/serve.ts`)})
const { honey } = await import(${JSON.stringify(`${SRC}routing/app.ts`)})
const { bunWebSocket } = await import(${JSON.stringify(`${SRC}ws/bun.ts`)})
const scenarioApp = ${scenarioApp.toString()}
const handle = await serve(scenarioApp(honey, bunWebSocket({ maxPayload: 1024 })), { hostname: "127.0.0.1", port: 0 })
console.log(handle.port, Bun.version)
process.stdin.once("data", () => process.exit(0))
`

describe("app.ws(path) through every adapter: one app, one outcome table", () => {
	it.each(SCENARIOS)("Node over a real socket: %s", async (_name, scenario, expected) => {
		const { port } = await listen(scenarioApp(honey, nodeWebSocket({ maxPayload: 1024 })))
		expect(await overSocket(`ws://127.0.0.1:${port}`, scenario, expected)).toEqual(expected)
	})

	it.each(SCENARIOS)("Workers over a WebSocketPair: %s", async (_name, scenario, expected) => {
		expect(await overWorkers(scenario, expected)).toEqual(expected)
	})

	it("Bun spawned, over real sockets: every scenario", async () => {
		const child = spawn("bun", ["-e", BUN_APP], { stdio: ["pipe", "pipe", "inherit"] })
		try {
			const line = String((await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next()).value)
			const [port, version] = line.split(" ") as [string, string]
			const outcomes = []
			for (const [, scenario, expected] of SCENARIOS)
				outcomes.push(await overSocket(`ws://127.0.0.1:${port}`, scenario, expected))
			/* Bun before 1.4.4 ends a connection over maxPayloadLength with no close frame: the client sees 1006 */
			const onBun = SCENARIOS.map(([name, , expected]) =>
				name.startsWith("closes 1009") && closesAbruptly(version) ? { ...expected, close: 1006, reason: "" } : expected,
			)
			expect(outcomes).toEqual(onBun)
		} finally {
			child.stdin.write("exit\n")
			child.kill()
		}
	}, 30_000)
})
