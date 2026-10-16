/**
 * The recording server's streams (recording-server.ts): server-sent events written step by step as
 * a script gives them, and scripted WebSocket endpoints on Node built-ins alone (the wire is
 * ws-frames.ts): the subprotocol, the client's data and close frames recorded, the close handshake
 * both ways, ping answered with pong. No `ws` package: honey/boundaries keeps it out of gen. A
 * client breaking the protocol is a violation the stage collects, and the recording server's
 * `close()` rejects with it, so a fixture or client bug fails the test instead of passing quietly.
 */
import { type IncomingMessage, STATUS_CODES, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import type { Json } from "./recording-server.ts"
import {
	acceptKey,
	BINARY,
	CLOSE,
	closePayload,
	type Frame,
	frameOf,
	frameProblem,
	handshakeProblem,
	PING,
	PONG,
	readFrame,
	type Received,
	receivedOf,
	TEXT,
} from "./ws-frames.ts"

export type { Received } from "./ws-frames.ts"

/** Raw text, written and flushed as given (CRLF, CR, a BOM, half an event), or a pause. */
export type SseStep = string | { readonly waitMs: number }

/**
 * An event stream: chunked, no content-length, `text/event-stream` unless `contentType`. Its end:
 * `close` finishes the body; `drop` ends the connection once the steps reached it, with no final
 * chunk; `hold` keeps it open until the client leaves or the server closes.
 */
export type SseScript = {
	readonly contentType?: string
	readonly end: "close" | "drop" | "hold"
	readonly steps: readonly SseStep[]
}

/**
 * One WebSocket step: a server frame (`text` as given, `json` stringified, `binary` that many bytes
 * `i & 0xff`), a pause, a wait until the client sent `receive` data messages in all, a close frame
 * then the client's echo, or `drop`: the connection ends with no close frame. The script stops at
 * `close` and `drop`.
 */
export type WsStep =
	| { readonly text: string }
	| { readonly json: Json }
	| { readonly binary: number }
	| { readonly waitMs: number }
	| { readonly receive: number }
	| { readonly close: { readonly code: number; readonly reason: string } }
	| { readonly drop: true }

/** A WebSocket endpoint: the subprotocol it answers with (as given, offered or not), then its steps; it holds after them. */
export type WsScript = { readonly protocol?: string; readonly steps: readonly WsStep[] }

/**
 * One stream, filled while it runs: the client's frames (always empty for SSE) and whether the
 * client left first: an SSE body it closed before the server ended it, or a socket it ended with
 * no close frame. A server `drop` or the server closing is never the client leaving.
 */
export type StreamRecord = { clientGone: boolean; readonly received: Received[] }

/** What one server's streams share: the sockets and pauses `stop` ends, and the violations seen. */
export type Stage = {
	/** keep `socket` until it closes, its errors swallowed (a client may reset it) */
	hold(socket: Duplex): void
	/** end every pause and destroy every held socket; the violations seen */
	stop(): readonly string[]
	readonly stopped: boolean
	violation(text: string): void
	/** a pause: true once `ms` passed, false at once when the stage stops */
	wait(ms: number): Promise<boolean>
}

/** A new stage, nothing held and nothing seen. */
export function streamStage(): Stage {
	const sockets = new Set<Duplex>()
	const pauses = new Set<() => void>()
	const violations: string[] = []
	let stopped = false
	return {
		hold(socket) {
			sockets.add(socket)
			socket.on("error", () => undefined)
			socket.once("close", () => sockets.delete(socket))
		},
		stop() {
			stopped = true
			for (const end of pauses) end()
			for (const socket of sockets) socket.destroy()
			return violations
		},
		get stopped() {
			return stopped
		},
		violation: (text) => void violations.push(text),
		wait: (ms) =>
			new Promise((resolve) => {
				if (stopped) return resolve(false)
				const end = (passed: boolean) => {
					clearTimeout(timer)
					pauses.delete(stop)
					resolve(passed)
				}
				const stop = () => end(false)
				const timer = setTimeout(() => end(true), ms)
				pauses.add(stop)
			}),
	}
}

/** Serve `script` on `res` with `status` and `headers` (over the default content-type); its record. */
export function serveSse(
	res: ServerResponse,
	head: { readonly headers?: Readonly<Record<string, string>>; readonly status: number },
	script: SseScript,
	stage: Stage,
): StreamRecord {
	const record: StreamRecord = { clientGone: false, received: [] }
	let ended = false
	res.once("close", () => {
		if (!ended && !stage.stopped) record.clientGone = true
		ended = true
	})
	res.writeHead(head.status, { "content-type": script.contentType ?? "text/event-stream", ...head.headers })
	res.flushHeaders()
	void (async () => {
		for (const step of script.steps) {
			if (ended) return
			/* a write waits until it left: a `drop` that ends the socket on a write still corked in Node's response loses it */
			if (typeof step === "string") await new Promise((flushed) => res.write(step, flushed))
			else await stage.wait(step.waitMs)
		}
		if (ended || script.end === "hold") return
		ended = true
		if (script.end === "close") res.end()
		else res.socket?.end()
	})()
	return record
}

/** Answer an upgrade request on `socket` as plain HTTP, the connection closed after it: a refused handshake. */
export function refuseUpgrade(
	socket: Duplex,
	status: number,
	headers: Readonly<Record<string, string>>,
	body: Buffer | string,
): void {
	const bytes = Buffer.from(body)
	const fields = { ...headers, connection: "close", "content-length": String(bytes.byteLength) }
	const lines = [
		`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`,
		...Object.entries(fields).map(([n, v]) => `${n}: ${v}`),
	]
	socket.end(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), bytes]))
}

/** Accept the upgrade `req` on `socket` (`head`: bytes after its headers) and run `script`; its record. */
export function acceptUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	reply: { readonly headers?: Readonly<Record<string, string>>; readonly ws: WsScript; readonly stage: Stage },
): StreamRecord {
	const { stage, ws } = reply
	const record: StreamRecord = { clientGone: false, received: [] }
	const problem = handshakeProblem(req)
	if (problem !== null) {
		stage.violation(`ws ${req.url}: ${problem}`)
		refuseUpgrade(socket, 400, {}, problem)
		return record
	}
	const fields: Record<string, string> = {
		connection: "Upgrade",
		"sec-websocket-accept": acceptKey(req.headers["sec-websocket-key"] as string),
		upgrade: "websocket",
		...(ws.protocol === undefined ? {} : { "sec-websocket-protocol": ws.protocol }),
		...reply.headers,
	}
	const lines = ["HTTP/1.1 101 Switching Protocols", ...Object.entries(fields).map(([n, v]) => `${n}: ${v}`)]
	socket.write(`${lines.join("\r\n")}\r\n\r\n`)
	const session = wsSession(socket, record, stage, (text) => stage.violation(`ws ${req.url}: ${text}`))
	session.feed(head)
	socket.on("data", (chunk: Buffer) => session.feed(chunk))
	void runWs(session, ws.steps, stage)
	return record
}

/** One accepted socket: frames in and out, and how its script waits on it. */
type Session = {
	readonly done: () => boolean
	feed(chunk: Buffer): void
	/** a close frame out; the socket ends on the client's echo */
	close(code: number, reason: string): void
	/** the connection ends once what was written reached it, with no close frame */
	drop(): void
	/** resolves once the client sent `n` data messages in all, or the socket closed */
	messages(n: number): Promise<void>
	send(opcode: number, payload: Buffer): void
}

/** A session's state: bytes not yet framed, data messages received, the close handshake, and who waits on the count. */
type SessionState = {
	count: number
	pending: Buffer
	state: "open" | "closing" | "closed" | "dropped"
	readonly waiters: Set<() => void>
}

/** `frame` written to `socket` while it can take it. */
const sendOn = (socket: Duplex, opcode: number, payload: Buffer) =>
	void (socket.writable && socket.write(frameOf(opcode, payload)))

/** A valid client frame: recorded, a ping answered, a close echoed (unless it echoes the server's) and the socket ended. */
function frameIn(socket: Duplex, at: SessionState, record: StreamRecord, f: Frame): void {
	const received = receivedOf(f)
	if (received !== undefined) record.received.push(received)
	if (f.opcode === PING) sendOn(socket, PONG, f.payload)
	if (received?.kind === "text" || received?.kind === "binary") {
		at.count++
		for (const check of at.waiters) check()
	}
	if (f.opcode !== CLOSE) return
	if (at.state === "open") sendOn(socket, CLOSE, f.payload.subarray(0, 2))
	at.state = "closed"
	socket.end()
}

/** The session of `socket`, recording into `record` and reporting a protocol violation to `fail`. */
function wsSession(socket: Duplex, record: StreamRecord, stage: Stage, fail: (text: string) => void): Session {
	const at: SessionState = { count: 0, pending: Buffer.alloc(0), state: "open", waiters: new Set() }
	/* an upgraded socket is half-open: the client ending its side ends the connection */
	socket.once("end", () => socket.end())
	socket.once("close", () => {
		/* open, or a server close frame the client never echoed: it left without one */
		if (!stage.stopped && (at.state === "open" || at.state === "closing")) record.clientGone = true
		if (at.state !== "dropped") at.state = "closed"
		for (const check of at.waiters) check()
	})
	return {
		close(code, reason) {
			sendOn(socket, CLOSE, closePayload(code, reason))
			at.state = "closing"
		},
		done: () => at.state === "closed" || at.state === "dropped" || socket.destroyed,
		drop() {
			at.state = "dropped"
			socket.end()
		},
		feed(chunk) {
			at.pending = Buffer.concat([at.pending, chunk])
			for (let f = readFrame(at.pending); f !== undefined && at.state !== "closed"; f = readFrame(at.pending)) {
				at.pending = at.pending.subarray(f.size)
				const problem = frameProblem(f)
				if (problem !== null) {
					fail(problem)
					at.state = "dropped"
					return void socket.destroy()
				}
				frameIn(socket, at, record, f)
			}
		},
		messages: (n) =>
			new Promise((resolve) => {
				const check = () => {
					if (at.count < n && !socket.destroyed && !socket.readableEnded) return
					at.waiters.delete(check)
					resolve()
				}
				at.waiters.add(check)
				check()
			}),
		send: (opcode, payload) => sendOn(socket, opcode, payload),
	}
}

/** Run a WebSocket script's steps on `session`, stopping when it ends or the stage stops. */
async function runWs(session: Session, steps: readonly WsStep[], stage: Stage): Promise<void> {
	for (const step of steps) {
		if (session.done() || stage.stopped) return
		if ("waitMs" in step) await stage.wait(step.waitMs)
		else if ("receive" in step) await session.messages(step.receive)
		else if ("close" in step) return session.close(step.close.code, step.close.reason)
		else if ("drop" in step) return session.drop()
		else if ("text" in step) session.send(TEXT, Buffer.from(step.text))
		else if ("json" in step) session.send(TEXT, Buffer.from(JSON.stringify(step.json)))
		else session.send(BINARY, Buffer.from(Array.from({ length: step.binary }, (_, i) => i & 0xff)))
	}
}
