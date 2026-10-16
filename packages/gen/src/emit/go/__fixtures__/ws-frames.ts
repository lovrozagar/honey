/**
 * The RFC 6455 wire, as the stream server (stream-server.ts) speaks it on Node built-ins: the
 * accept key, what makes a handshake acceptable, server frames out (FIN, unmasked, 7/16/64-bit
 * lengths) and client frames in (unmasked as read, then checked: masked, unfragmented, no RSV bits,
 * a known opcode, a short control payload, UTF-8 text).
 */
import { createHash } from "node:crypto"
import type { IncomingMessage } from "node:http"

/* RFC 6455 §1.3: the GUID the accept key hashes in */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** The opcodes this server reads and writes (RFC 6455 §5.2). */
export const TEXT = 0x1
export const BINARY = 0x2
export const CLOSE = 0x8
export const PING = 0x9
export const PONG = 0xa

/** The `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
	return createHash("sha1").update(`${key}${GUID}`).digest("base64")
}

/** Why `req` is no WebSocket handshake a server may accept, or null. */
export function handshakeProblem(req: IncomingMessage): string | null {
	const tokens = (name: "connection" | "upgrade") => (req.headers[name] ?? "").toLowerCase().split(/\s*,\s*/)
	if (req.method !== "GET") return `the handshake is a ${req.method}, not a GET`
	if (!tokens("upgrade").includes("websocket")) return "the handshake has no upgrade: websocket"
	if (!tokens("connection").includes("upgrade")) return "the handshake has no connection: upgrade"
	if (req.headers["sec-websocket-version"] !== "13") return "the handshake is not sec-websocket-version 13"
	const key = Buffer.from(req.headers["sec-websocket-key"] ?? "", "base64")
	return key.byteLength === 16 ? null : "the handshake's sec-websocket-key is not 16 bytes in base64"
}

/** A server frame: FIN, `opcode`, unmasked, its length in 7, 16 or 64 bits. */
export function frameOf(opcode: number, payload: Buffer): Buffer {
	const n = payload.byteLength
	const head = Buffer.alloc(n < 126 ? 2 : n < 65_536 ? 4 : 10)
	head[0] = 0x80 | opcode
	if (n < 126) head[1] = n
	else if (n < 65_536) {
		head[1] = 126
		head.writeUInt16BE(n, 2)
	} else {
		head[1] = 127
		head.writeBigUInt64BE(BigInt(n), 2)
	}
	return Buffer.concat([head, payload])
}

/** A close frame's payload: the code, then the reason. */
export function closePayload(code: number, reason: string): Buffer {
	const payload = Buffer.alloc(2)
	payload.writeUInt16BE(code)
	return Buffer.concat([payload, Buffer.from(reason)])
}

/** A frame as read off the wire, its payload unmasked, and the bytes it took. */
export type Frame = { fin: boolean; masked: boolean; opcode: number; payload: Buffer; rsv: number; size: number }

/** The first frame of `buf`, or undefined while it is incomplete. */
export function readFrame(buf: Buffer): Frame | undefined {
	if (buf.byteLength < 2) return undefined
	const b0 = buf[0] as number
	const b1 = buf[1] as number
	const wide = (b1 & 0x7f) === 126 ? 2 : (b1 & 0x7f) === 127 ? 8 : 0
	if (buf.byteLength < 2 + wide) return undefined
	const length = wide === 0 ? b1 & 0x7f : wide === 2 ? buf.readUInt16BE(2) : Number(buf.readBigUInt64BE(2))
	const masked = (b1 & 0x80) !== 0
	const start = 2 + wide + (masked ? 4 : 0)
	if (buf.byteLength < start + length) return undefined
	const payload = Buffer.from(buf.subarray(start, start + length))
	if (masked) for (let i = 0; i < length; i++) payload[i] = (payload[i] as number) ^ (buf[2 + wide + (i & 3)] as number)
	return { fin: (b0 & 0x80) !== 0, masked, opcode: b0 & 0x0f, payload, rsv: b0 & 0x70, size: start + length }
}

/** Why a client may not send `f`, or null. */
export function frameProblem(f: Frame): string | null {
	if (!f.masked) return "an unmasked client frame"
	if (f.rsv !== 0) return "a frame with RSV bits set, and no extension was negotiated"
	if (!f.fin || f.opcode === 0) return "a fragmented message, which this fixture does not reassemble"
	if (![TEXT, BINARY, CLOSE, PING, PONG].includes(f.opcode)) return `a frame with the unknown opcode ${f.opcode}`
	if (f.opcode >= CLOSE && f.payload.byteLength > 125) return "a control frame over 125 bytes"
	if (f.opcode === CLOSE && f.payload.byteLength === 1) return "a close frame with a 1-byte payload"
	if (f.opcode !== TEXT) return null
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(f.payload)
		return null
	} catch {
		return "a text frame that is not UTF-8"
	}
}

/** A client frame as received: text as sent, binary by size and SHA-256, a close frame's code (null without one) and reason. */
export type Received =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "binary"; readonly sha256: string; readonly size: number }
	| { readonly code: number | null; readonly kind: "close"; readonly reason: string }

/** A client data or close frame as the record keeps it; undefined for a ping or pong. */
export function receivedOf(f: Frame): Received | undefined {
	if (f.opcode === TEXT) return { kind: "text", text: f.payload.toString("utf8") }
	if (f.opcode === BINARY)
		return { kind: "binary", sha256: createHash("sha256").update(f.payload).digest("hex"), size: f.payload.byteLength }
	if (f.opcode !== CLOSE) return undefined
	const code = f.payload.byteLength >= 2 ? f.payload.readUInt16BE(0) : null
	return { code, kind: "close", reason: f.payload.subarray(2).toString("utf8") }
}
