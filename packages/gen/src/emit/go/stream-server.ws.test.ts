import { createHash } from "node:crypto"
import { once } from "node:events"
import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import { recordingServer, type Reply, served } from "./__fixtures__/recording-server.ts"
import { acceptKey } from "./__fixtures__/ws-frames.ts"

/* RFC 6455 §1.3's sample nonce and the accept key it must produce */
const KEY = "dGhlIHNhbXBsZSBub25jZQ=="
const ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
const HANDSHAKE = {
	connection: "Upgrade",
	"sec-websocket-key": KEY,
	"sec-websocket-version": "13",
	upgrade: "websocket",
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const counting = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i & 0xff))

/** Node's own WebSocket client at `url`, open: every message as it came (binary as a Buffer), and how it closed. */
async function opened(url: string, protocols: string[] = []) {
	const ws = new WebSocket(url.replace("http://", "ws://"), protocols)
	ws.binaryType = "arraybuffer"
	const messages: (Buffer | string)[] = []
	ws.addEventListener("message", (e) => messages.push(typeof e.data === "string" ? e.data : Buffer.from(e.data)))
	const closed = new Promise<{ code: number; reason: string; wasClean: boolean }>((resolve) =>
		ws.addEventListener("close", ({ code, reason, wasClean }) => resolve({ code, reason, wasClean })),
	)
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve)
		ws.addEventListener("error", reject)
	})
	return { closed, messages, ws }
}

/** A client frame: FIN unless `fin: false`, masked unless `mask: false`, `rsv` bits as given; a 7- or 16-bit length. */
function clientFrame(opcode: number, payload: Buffer, shape: { fin?: false; mask?: false; rsv?: number } = {}): Buffer {
	const key = Buffer.from([1, 2, 3, 4])
	const body = shape.mask === false ? payload : payload.map((byte, i) => byte ^ (key[i & 3] as number))
	const wide = payload.length < 126 ? [payload.length] : [126, payload.length >> 8, payload.length & 0xff]
	const head = Buffer.from([(shape.fin === false ? 0 : 0x80) | (shape.rsv ?? 0) | opcode, ...wide])
	if (shape.mask === false) return Buffer.concat([head, body])
	head[1] = (head[1] as number) | 0x80
	return Buffer.concat([head, key, body])
}

/** A raw TCP client sending a handshake for `path` with `headers`: what came back, its frames (7-bit lengths), and its close. */
async function raw(url: string, path: string, headers: Readonly<Record<string, string>> = HANDSHAKE) {
	const socket = connect(Number(new URL(url).port), "127.0.0.1")
	let data = Buffer.alloc(0)
	socket.on("data", (chunk: Buffer) => (data = Buffer.concat([data, chunk])))
	socket.on("error", () => undefined)
	const closed = once(socket, "close")
	await once(socket, "connect")
	const fields = Object.entries({ host: "x", ...headers }).map(([name, value]) => `${name}: ${value}\r\n`)
	socket.write(`GET ${path} HTTP/1.1\r\n${fields.join("")}\r\n`)
	const split = () => data.indexOf("\r\n\r\n") + 4
	const frames = () => {
		const out: { opcode: number; payload: string }[] = []
		for (let at = split(); at + 2 <= data.length; at += 2 + (data[at + 1] as number))
			out.push({
				opcode: (data[at] as number) & 0x0f,
				payload: data.subarray(at + 2, at + 2 + (data[at + 1] as number)).toString(),
			})
		return out
	}
	return {
		closed,
		frames,
		head: () => data.subarray(0, split()).toString(),
		rest: () => data.subarray(split()),
		socket,
	}
}

describe("the stream server: the WebSocket handshake", () => {
	it("answers RFC 6455's sample key with its accept key, 101 and the scripted subprotocol, and records the hop", async () => {
		expect(acceptKey(KEY)).toBe(ACCEPT)
		const reply: Reply = { headers: { "x-extra": "e" }, status: 101, ws: { protocol: "v1", steps: [] } }
		const [head, hops] = await served([reply], async (server) => {
			const client = await raw(server.url, "/rooms/a?since=1")
			await sleep(100)
			return [client.head(), server.hops] as const
		})
		expect(head.split("\r\n")).toEqual([
			"HTTP/1.1 101 Switching Protocols",
			"connection: Upgrade",
			`sec-websocket-accept: ${ACCEPT}`,
			"upgrade: websocket",
			"sec-websocket-protocol: v1",
			"x-extra: e",
			"",
			"",
		])
		expect(hops.map(({ body, method, url }) => ({ method, size: body.size, url }))).toEqual([
			{ method: "GET", size: 0, url: "/rooms/a?since=1" },
		])
	})

	it("negotiates with Node's client: the protocols it offered on the hop, the one scripted picked", async () => {
		const [protocol, hops] = await served([{ status: 101, ws: { protocol: "v1", steps: [] } }], async (server) => {
			const { ws } = await opened(`${server.url}/live`, ["v2", "v1"])
			ws.close()
			return [ws.protocol, server.hops] as const
		})
		expect({ headers: hops[0]?.headers, protocol }).toMatchObject({
			headers: { "sec-websocket-protocol": "v2, v1", "sec-websocket-version": "13", upgrade: "websocket" },
			protocol: "v1",
		})
	})
})

describe("the stream server: WebSocket handshakes it refuses", () => {
	it("refuses the handshake as plain HTTP for any reply without ws: status, headers, body, the connection closed", async () => {
		const replies: Reply[] = [{ headers: { "x-why": "policy" }, json: { message: "no" }, status: 403 }]
		const [refused, fallback, streams] = await served(replies, async (server) => {
			const first = await raw(server.url, "/rooms/a")
			const second = await raw(server.url, "/rooms/b")
			await Promise.all([first.closed, second.closed])
			return [first.head() + first.rest().toString(), second.head() + second.rest().toString(), server.streams]
		})
		expect((refused as string).split("\r\n")).toEqual([
			"HTTP/1.1 403 Forbidden",
			"content-length: 16",
			"content-type: application/json",
			"x-why: policy",
			"connection: close",
			"",
			'{"message":"no"}',
		])
		expect(fallback).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n\{\}$/)
		expect(streams).toEqual([undefined, undefined])
	})

	it("refuses a broken handshake with 400 and an sse reply to an upgrade as plain HTTP, and close() names both", async () => {
		const server = await recordingServer([
			{ status: 101, ws: { steps: [] } },
			{ sse: { end: "close", steps: [] }, status: 200 },
		])
		const broken = await raw(server.url, "/a", { ...HANDSHAKE, "sec-websocket-key": "short" })
		const sse = await raw(server.url, "/b")
		await Promise.all([broken.closed, sse.closed])
		expect([broken.head().split("\r\n")[0], sse.head().split("\r\n")[0]]).toEqual([
			"HTTP/1.1 400 Bad Request",
			"HTTP/1.1 200 OK",
		])
		await expect(server.close()).rejects.toThrow(
			"ws /a: the handshake's sec-websocket-key is not 16 bytes in base64\nGET /b: an sse reply to an upgrade request",
		)
	})
})

describe("the stream server: WebSocket frames", () => {
	it("sends text, JSON and binary frames at 7-, 16- and 64-bit lengths that Node's client reads intact", async () => {
		const steps = [
			{ text: "hi" },
			{ json: { n: 1 } },
			{ binary: 3 },
			{ text: "y".repeat(200) },
			{ json: "x".repeat(70_000) },
		]
		const messages = await served([{ status: 101, ws: { steps } }], async (server) => {
			const client = await opened(server.url)
			for (let i = 0; i < 100 && client.messages.length < 5; i++) await sleep(10)
			client.ws.close()
			return client.messages
		})
		expect(messages).toEqual(["hi", '{"n":1}', counting(3), "y".repeat(200), JSON.stringify("x".repeat(70_000))])
	})
})

describe("the stream server: WebSocket client frames", () => {
	it("decodes masked client frames of every length, holds a step until enough arrived, and echoes the client's close code", async () => {
		const reply: Reply = { status: 101, ws: { steps: [{ receive: 3 }, { text: "got" }] } }
		const [early, client, closed, streams] = await served([reply], async (server) => {
			const opening = await opened(server.url)
			opening.ws.send("a")
			opening.ws.send(counting(70_000))
			await sleep(150)
			const before = [...opening.messages]
			opening.ws.send("z".repeat(300))
			for (let i = 0; i < 100 && opening.messages.length < 1; i++) await sleep(10)
			opening.ws.close(4000, "bye")
			return [before, opening.messages, await opening.closed, server.streams] as const
		})
		expect({ client, closed, early, streams }).toEqual({
			client: ["got"],
			closed: { code: 4000, reason: "", wasClean: true },
			early: [],
			streams: [
				{
					clientGone: false,
					received: [
						{ kind: "text", text: "a" },
						{ kind: "binary", sha256: sha(counting(70_000)), size: 70_000 },
						{ kind: "text", text: "z".repeat(300) },
						{ code: 4000, kind: "close", reason: "bye" },
					],
				},
			],
		})
	})
})

describe("the stream server: the WebSocket close", () => {
	it("closes with the scripted code and reason, then records the client's echo", async () => {
		const reply: Reply = { status: 101, ws: { steps: [{ close: { code: 1001, reason: "done" } }] } }
		const [closed, streams] = await served([reply], async (server) => {
			const client = await opened(server.url)
			return [await client.closed, server.streams] as const
		})
		expect({ closed, streams }).toEqual({
			closed: { code: 1001, reason: "done", wasClean: true },
			streams: [{ clientGone: false, received: [{ code: 1001, kind: "close", reason: "" }] }],
		})
	})

	it("drops the connection with no close frame after what it wrote arrived, the client not gone", async () => {
		const reply: Reply = {
			status: 101,
			ws: { steps: [{ text: "1" }, { waitMs: 50 }, { drop: true }, { text: "never" }] },
		}
		const [messages, closed, streams] = await served([reply], async (server) => {
			const client = await opened(server.url)
			return [client.messages, await client.closed, server.streams] as const
		})
		expect({ closed, messages, streams }).toEqual({
			closed: { code: 1006, reason: "", wasClean: false },
			messages: ["1"],
			streams: [{ clientGone: false, received: [] }],
		})
	})
})

describe("the stream server: control frames, and clients that leave", () => {
	it("answers a ping with a pong of its payload, and an empty close frame with an empty one, recorded with a null code", async () => {
		const [frames, streams] = await served([{ status: 101, ws: { steps: [] } }], async (server) => {
			const client = await raw(server.url, "/")
			client.socket.write(clientFrame(0x9, Buffer.from("p-1")))
			client.socket.write(clientFrame(0x8, Buffer.alloc(0)))
			await client.closed
			return [client.frames(), server.streams] as const
		})
		expect({ frames, streams }).toEqual({
			frames: [
				{ opcode: 0xa, payload: "p-1" },
				{ opcode: 0x8, payload: "" },
			],
			streams: [{ clientGone: false, received: [{ code: null, kind: "close", reason: "" }] }],
		})
	})

	it("records a client that ends the socket with no close frame as gone, and one cut off by close() as not", async () => {
		const server = await recordingServer([
			{ status: 101, ws: { steps: [] } },
			{ status: 101, ws: { steps: [{ close: { code: 1000, reason: "" } }] } },
			{ status: 101, ws: { steps: [] } },
		])
		const left = await raw(server.url, "/left")
		const unechoed = await raw(server.url, "/unechoed")
		const held = await opened(server.url)
		await sleep(100)
		left.socket.end()
		unechoed.socket.end()
		await Promise.all([left.closed, unechoed.closed])
		await sleep(50)
		await server.close()
		expect({ held: await held.closed, streams: server.streams.map((s) => s?.clientGone) }).toEqual({
			held: { code: 1006, reason: "", wasClean: false },
			streams: [true, true, false],
		})
	})
})

describe("the stream server: WebSocket protocol violations", () => {
	it("fails loudly on a client frame RFC 6455 forbids or this fixture cannot read: close() lists each, its socket destroyed", async () => {
		const bad = [
			clientFrame(0x1, Buffer.from("a"), { mask: false }),
			clientFrame(0x1, Buffer.from("a"), { fin: false }),
			clientFrame(0x0, Buffer.from("a")),
			clientFrame(0x1, Buffer.from("a"), { rsv: 0x40 }),
			clientFrame(0x3, Buffer.from("a")),
			clientFrame(0x9, Buffer.alloc(126)),
			clientFrame(0x8, Buffer.from([3])),
			clientFrame(0x1, Buffer.from([0xff])),
		]
		const server = await recordingServer(bad.map(() => ({ status: 101, ws: { steps: [] } })))
		for (const [i, frame] of bad.entries()) {
			const client = await raw(server.url, `/${i}`)
			client.socket.write(frame)
			await client.closed
		}
		const problems = await server.close().then(
			() => [],
			(error: Error) => error.message.split("\n").slice(1),
		)
		expect(problems).toEqual([
			"ws /0: an unmasked client frame",
			"ws /1: a fragmented message, which this fixture does not reassemble",
			"ws /2: a fragmented message, which this fixture does not reassemble",
			"ws /3: a frame with RSV bits set, and no extension was negotiated",
			"ws /4: a frame with the unknown opcode 3",
			"ws /5: a control frame over 125 bytes",
			"ws /6: a close frame with a 1-byte payload",
			"ws /7: a text frame that is not UTF-8",
		])
	})
})
