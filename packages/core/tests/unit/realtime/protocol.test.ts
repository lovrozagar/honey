import { describe, expect, expectTypeOf, it } from "vitest"
import {
	createProtocol,
	decodeClientFrame,
	encodeServerFrame,
} from "../../../src/realtime/protocol.ts"
import type {
	ClientFrame,
	ServerFrame,
} from "../../../src/realtime/protocol.ts"

/* ------------------------------------------------------------------ */
/*  Envelope encoding                                                 */
/* ------------------------------------------------------------------ */

describe("encodeServerFrame", () => {
	it("encodes a msg frame with id and data", () => {
		const frame: ServerFrame = { data: { text: "hello" }, id: 1, t: "msg" }
		const json = encodeServerFrame(frame)
		const parsed = JSON.parse(json)

		expect(parsed).toEqual({ data: { text: "hello" }, id: 1, t: "msg" })
	})

	it("encodes a pong frame", () => {
		const frame: ServerFrame = { t: "pong" }
		const json = encodeServerFrame(frame)
		const parsed = JSON.parse(json)

		expect(parsed).toEqual({ t: "pong" })
	})

	it("encodes a bye frame with reason", () => {
		const frame: ServerFrame = { reason: "kicked", t: "bye" }
		const json = encodeServerFrame(frame)
		const parsed = JSON.parse(json)

		expect(parsed).toEqual({ reason: "kicked", t: "bye" })
	})

	it("encodes a ready frame with reconnectToken", () => {
		const frame: ServerFrame = { reconnectToken: "abc", t: "ready" }
		const json = encodeServerFrame(frame)
		const parsed = JSON.parse(json)

		expect(parsed).toEqual({ reconnectToken: "abc", t: "ready" })
	})

	it("produces valid JSON for msg frames with complex nested data", () => {
		const data = { nested: { arr: [1, 2, { deep: true }], n: null } }
		const frame: ServerFrame = { data, id: 99, t: "msg" }
		const json = encodeServerFrame(frame)

		expect(() => JSON.parse(json)).not.toThrow()
		expect(JSON.parse(json).data).toEqual(data)
	})
})

/* ------------------------------------------------------------------ */
/*  Envelope decoding                                                 */
/* ------------------------------------------------------------------ */

describe("decodeClientFrame", () => {
	it("decodes a ping frame from JSON string", () => {
		const result = decodeClientFrame(JSON.stringify({ t: "ping" }))
		expect(result).toEqual({ t: "ping" })
	})

	it("decodes a msg frame from JSON string", () => {
		const result = decodeClientFrame(
			JSON.stringify({ data: { action: "click" }, t: "msg" }),
		)
		expect(result).toEqual({ data: { action: "click" }, t: "msg" })
	})

	it("decodes a resume frame from JSON string", () => {
		const result = decodeClientFrame(
			JSON.stringify({ lastId: 42, reconnectToken: "tok-x", t: "resume" }),
		)
		expect(result).toEqual({
			lastId: 42,
			reconnectToken: "tok-x",
			t: "resume",
		})
	})

	it("returns null for invalid JSON", () => {
		const result = decodeClientFrame("not json {{{")
		expect(result).toBeNull()
	})

	it("returns null for valid JSON but unknown frame type", () => {
		const result = decodeClientFrame(JSON.stringify({ t: "unknown_type" }))
		expect(result).toBeNull()
	})

	it("returns null when required fields are missing from msg frame", () => {
		/* msg frame requires data field */
		const result = decodeClientFrame(JSON.stringify({ t: "msg" }))
		expect(result).toBeNull()
	})

	it("returns null when required fields are missing from resume frame", () => {
		/* resume frame requires lastId and reconnectToken */
		const result = decodeClientFrame(
			JSON.stringify({ lastId: 5, t: "resume" }),
		)
		expect(result).toBeNull()
	})

	it("returns null for empty string", () => {
		const result = decodeClientFrame("")
		expect(result).toBeNull()
	})

	it("returns null for JSON array instead of object", () => {
		const result = decodeClientFrame(JSON.stringify([1, 2, 3]))
		expect(result).toBeNull()
	})

	it("returns null for JSON primitive", () => {
		const result = decodeClientFrame(JSON.stringify(42))
		expect(result).toBeNull()
	})
})

/* ------------------------------------------------------------------ */
/*  Protocol state machine — creation and connect                     */
/* ------------------------------------------------------------------ */

describe("createProtocol", () => {
	it("returns a protocol object with expected shape", () => {
		const proto = createProtocol()

		expect(proto).toHaveProperty("handleConnect")
		expect(proto).toHaveProperty("handleResume")
		expect(proto).toHaveProperty("handleClientFrame")
		expect(proto).toHaveProperty("sendMessage")
		expect(proto).toHaveProperty("sendBye")
		expect(proto).toHaveProperty("lastId")
		expect(proto).toHaveProperty("reconnectToken")
	})

	it("starts with lastId of 0", () => {
		const proto = createProtocol()
		expect(proto.lastId).toBe(0)
	})

	it("generates a non-empty reconnectToken", () => {
		const proto = createProtocol()
		expect(typeof proto.reconnectToken).toBe("string")
		expect(proto.reconnectToken.length).toBeGreaterThan(0)
	})

	it("generates unique reconnectTokens across instances", () => {
		const a = createProtocol()
		const b = createProtocol()
		expect(a.reconnectToken).not.toBe(b.reconnectToken)
	})
})

/* ------------------------------------------------------------------ */
/*  Protocol — handleConnect                                          */
/* ------------------------------------------------------------------ */

describe("Protocol.handleConnect", () => {
	it("returns a ready frame", () => {
		const proto = createProtocol()
		const frame = proto.handleConnect()

		expect(frame).toEqual({
			reconnectToken: proto.reconnectToken,
			t: "ready",
		})
	})

	it("ready frame reconnectToken matches protocol reconnectToken", () => {
		const proto = createProtocol()
		const frame = proto.handleConnect()

		expect(frame.t).toBe("ready")
		if (frame.t === "ready") {
			expect(frame.reconnectToken).toBe(proto.reconnectToken)
		}
	})
})

/* ------------------------------------------------------------------ */
/*  Protocol — sendMessage (monotonic IDs)                            */
/* ------------------------------------------------------------------ */

describe("Protocol.sendMessage", () => {
	it("first message gets id=1", () => {
		const proto = createProtocol()
		const frame = proto.sendMessage({ text: "hello" })

		expect(frame).toEqual({
			data: { text: "hello" },
			id: 1,
			t: "msg",
		})
	})

	it("sequential messages get incrementing ids", () => {
		const proto = createProtocol()

		const f1 = proto.sendMessage("a")
		const f2 = proto.sendMessage("b")
		const f3 = proto.sendMessage("c")

		expect(f1).toMatchObject({ id: 1, t: "msg" })
		expect(f2).toMatchObject({ id: 2, t: "msg" })
		expect(f3).toMatchObject({ id: 3, t: "msg" })
	})

	it("updates lastId after each message", () => {
		const proto = createProtocol()

		expect(proto.lastId).toBe(0)
		proto.sendMessage("x")
		expect(proto.lastId).toBe(1)
		proto.sendMessage("y")
		expect(proto.lastId).toBe(2)
	})

	it("independent connections have independent counters", () => {
		const a = createProtocol()
		const b = createProtocol()

		a.sendMessage("a1")
		a.sendMessage("a2")
		a.sendMessage("a3")

		const bFrame = b.sendMessage("b1")

		expect(a.lastId).toBe(3)
		expect(b.lastId).toBe(1)
		expect(bFrame).toMatchObject({ id: 1, t: "msg" })
	})

	it("preserves arbitrary data shapes", () => {
		const proto = createProtocol()

		const f1 = proto.sendMessage(null)
		const f2 = proto.sendMessage(42)
		const f3 = proto.sendMessage([1, 2, 3])
		const f4 = proto.sendMessage("plain string")

		expect(f1).toMatchObject({ data: null, id: 1 })
		expect(f2).toMatchObject({ data: 42, id: 2 })
		expect(f3).toMatchObject({ data: [1, 2, 3], id: 3 })
		expect(f4).toMatchObject({ data: "plain string", id: 4 })
	})
})

/* ------------------------------------------------------------------ */
/*  Protocol — sendBye                                                */
/* ------------------------------------------------------------------ */

describe("Protocol.sendBye", () => {
	it("returns a bye frame with the given reason", () => {
		const proto = createProtocol()
		const frame = proto.sendBye("session_expired")

		expect(frame).toEqual({ reason: "session_expired", t: "bye" })
	})

	it("does not alter lastId", () => {
		const proto = createProtocol()
		proto.sendMessage("a")
		expect(proto.lastId).toBe(1)

		proto.sendBye("done")
		expect(proto.lastId).toBe(1)
	})
})

/* ------------------------------------------------------------------ */
/*  Protocol — handleClientFrame (dispatch)                           */
/* ------------------------------------------------------------------ */

describe("Protocol.handleClientFrame", () => {
	it("returns pong for a ping frame", () => {
		const proto = createProtocol()
		const result = proto.handleClientFrame(JSON.stringify({ t: "ping" }))

		expect(result).toEqual({ t: "pong" })
	})

	it("returns null for invalid JSON", () => {
		const proto = createProtocol()
		const result = proto.handleClientFrame("broken{{{")

		expect(result).toBeNull()
	})

	it("returns null for unknown frame type", () => {
		const proto = createProtocol()
		const result = proto.handleClientFrame(
			JSON.stringify({ t: "doesnotexist" }),
		)

		expect(result).toBeNull()
	})

	it("returns null for msg frame (server does not echo back)", () => {
		const proto = createProtocol()
		const result = proto.handleClientFrame(
			JSON.stringify({ data: "hi", t: "msg" }),
		)

		/*
		 * Client msg frames are dispatched to the application handler,
		 * not auto-responded by the protocol. The protocol returns null
		 * to indicate no automatic server reply.
		 */
		expect(result).toBeNull()
	})
})

/* ------------------------------------------------------------------ */
/*  Protocol — handleResume                                           */
/* ------------------------------------------------------------------ */

describe("Protocol.handleResume", () => {
	it("returns a bye frame array for an invalid reconnectToken", () => {
		const proto = createProtocol()
		proto.handleConnect()

		const result = proto.handleResume(0, "wrong-token")

		expect(result).toHaveLength(1)
		expect(result[0].t).toBe("bye")
	})

	it("returns a bye frame array when no reconnect buffer is configured", () => {
		const proto = createProtocol()
		proto.handleConnect()

		const result = proto.handleResume(0, proto.reconnectToken)

		/*
		 * Without a reconnect buffer, there are no frames to replay,
		 * so the protocol should send bye indicating replay is not possible.
		 */
		expect(result.length).toBeGreaterThanOrEqual(1)
		expect(result[result.length - 1].t).toBe("bye")
	})

	it("replays frames after lastId when buffer is available", () => {
		const buffer = createSimpleReconnectBuffer()
		const proto = createProtocol({ reconnectBuffer: buffer })
		proto.handleConnect()

		proto.sendMessage("one")
		proto.sendMessage("two")
		proto.sendMessage("three")

		const result = proto.handleResume(1, proto.reconnectToken)

		/*
		 * Should replay messages with id > 1 (i.e., id=2 and id=3),
		 * followed by a ready frame.
		 */
		const msgFrames = result.filter((f) => f.t === "msg")
		expect(msgFrames).toHaveLength(2)

		if (msgFrames[0].t === "msg" && msgFrames[1].t === "msg") {
			expect(msgFrames[0].id).toBe(2)
			expect(msgFrames[1].id).toBe(3)
		}
	})

	it("returns ready frame at the end of a successful resume", () => {
		const buffer = createSimpleReconnectBuffer()
		const proto = createProtocol({ reconnectBuffer: buffer })
		proto.handleConnect()

		proto.sendMessage("a")
		proto.sendMessage("b")

		const result = proto.handleResume(0, proto.reconnectToken)

		const last = result[result.length - 1]
		expect(last.t).toBe("ready")
	})

	it("replays zero frames when lastId matches current lastId", () => {
		const buffer = createSimpleReconnectBuffer()
		const proto = createProtocol({ reconnectBuffer: buffer })
		proto.handleConnect()

		proto.sendMessage("only")

		const result = proto.handleResume(1, proto.reconnectToken)

		const msgFrames = result.filter((f) => f.t === "msg")
		expect(msgFrames).toHaveLength(0)

		/* Should still end with ready */
		expect(result[result.length - 1].t).toBe("ready")
	})
})

/* ------------------------------------------------------------------ */
/*  Edge cases — boundary values and adversarial inputs               */
/* ------------------------------------------------------------------ */

describe("edge cases", () => {
	it("encodeServerFrame handles msg with empty object data", () => {
		const frame: ServerFrame = { data: {}, id: 1, t: "msg" }
		const json = encodeServerFrame(frame)
		expect(JSON.parse(json).data).toEqual({})
	})

	it("encodeServerFrame handles bye with empty string reason", () => {
		const frame: ServerFrame = { reason: "", t: "bye" }
		const json = encodeServerFrame(frame)
		expect(JSON.parse(json).reason).toBe("")
	})

	it("decodeClientFrame handles frame with extra unknown fields gracefully", () => {
		const raw = JSON.stringify({ extra: "ignored", t: "ping", x: 123 })
		const result = decodeClientFrame(raw)

		/* Should still decode as a valid ping frame */
		expect(result).not.toBeNull()
		expect(result?.t).toBe("ping")
	})

	it("decodeClientFrame handles resume with lastId=0", () => {
		const raw = JSON.stringify({
			lastId: 0,
			reconnectToken: "tok",
			t: "resume",
		})
		const result = decodeClientFrame(raw)

		expect(result).toEqual({ lastId: 0, reconnectToken: "tok", t: "resume" })
	})

	it("decodeClientFrame rejects resume with negative lastId", () => {
		const raw = JSON.stringify({
			lastId: -1,
			reconnectToken: "tok",
			t: "resume",
		})
		const result = decodeClientFrame(raw)
		expect(result).toBeNull()
	})

	it("decodeClientFrame rejects resume with non-integer lastId", () => {
		const raw = JSON.stringify({
			lastId: 1.5,
			reconnectToken: "tok",
			t: "resume",
		})
		const result = decodeClientFrame(raw)
		expect(result).toBeNull()
	})

	it("decodeClientFrame rejects resume with string lastId", () => {
		const raw = JSON.stringify({
			lastId: "not-a-number",
			reconnectToken: "tok",
			t: "resume",
		})
		const result = decodeClientFrame(raw)
		expect(result).toBeNull()
	})

	it("sendMessage handles large data payload without error", () => {
		const proto = createProtocol()
		const largeArray = Array.from({ length: 10_000 }, (_, i) => ({
			index: i,
			value: `item-${i}`,
		}))
		const frame = proto.sendMessage(largeArray)

		expect(frame.t).toBe("msg")
		if (frame.t === "msg") {
			expect(frame.id).toBe(1)
			expect((frame.data as unknown[]).length).toBe(10_000)
		}
	})

	it("protocol handles many sequential messages without id overflow within safe integer range", () => {
		const proto = createProtocol()

		/* Send 1000 messages to verify monotonic behavior at scale */
		for (let i = 0; i < 1000; i++) {
			proto.sendMessage(i)
		}

		expect(proto.lastId).toBe(1000)

		const next = proto.sendMessage("after-batch")
		expect(next).toMatchObject({ id: 1001, t: "msg" })
	})
})

/* ------------------------------------------------------------------ */
/*  Type contracts                                                    */
/* ------------------------------------------------------------------ */

describe("type contracts", () => {
	it("ServerFrame discriminated union narrows correctly on t field", () => {
		const frame = { data: "hi", id: 1, t: "msg" as const } satisfies ServerFrame

		if (frame.t === "msg") {
			expectTypeOf(frame.id).toBeNumber()
			expectTypeOf(frame.data).toEqualTypeOf<unknown>()
		}

		const pong = { t: "pong" as const } satisfies ServerFrame
		expectTypeOf(pong).toMatchTypeOf<ServerFrame>()

		const bye = {
			reason: "x",
			t: "bye" as const,
		} satisfies ServerFrame
		expectTypeOf(bye.reason).toBeString()
	})

	it("ClientFrame discriminated union narrows correctly on t field", () => {
		const ping = { t: "ping" as const } satisfies ClientFrame
		expectTypeOf(ping).toMatchTypeOf<ClientFrame>()

		const resume = {
			lastId: 1,
			reconnectToken: "tok",
			t: "resume" as const,
		} satisfies ClientFrame

		if (resume.t === "resume") {
			expectTypeOf(resume.lastId).toBeNumber()
			expectTypeOf(resume.reconnectToken).toBeString()
		}
	})

	it("encodeServerFrame accepts ServerFrame and returns string", () => {
		expectTypeOf(encodeServerFrame).parameter(0).toMatchTypeOf<ServerFrame>()
		expectTypeOf(encodeServerFrame).returns.toBeString()
	})

	it("decodeClientFrame returns ClientFrame | null", () => {
		expectTypeOf(decodeClientFrame).parameter(0).toBeString()
		expectTypeOf(decodeClientFrame).returns.toEqualTypeOf<ClientFrame | null>()
	})

	it("Protocol.sendMessage returns ServerFrame", () => {
		const proto = createProtocol()
		expectTypeOf(proto.sendMessage).returns.toMatchTypeOf<ServerFrame>()
	})

	it("Protocol.handleResume returns ServerFrame[]", () => {
		const proto = createProtocol()
		expectTypeOf(proto.handleResume).returns.toEqualTypeOf<ServerFrame[]>()
	})

	it("Protocol.lastId is readonly number", () => {
		const proto = createProtocol()
		expectTypeOf(proto.lastId).toBeNumber()
	})

	it("Protocol.reconnectToken is readonly string", () => {
		const proto = createProtocol()
		expectTypeOf(proto.reconnectToken).toBeString()
	})
})

/* ------------------------------------------------------------------ */
/*  Test helper: minimal reconnect buffer for resume tests            */
/* ------------------------------------------------------------------ */

/**
 * A minimal in-memory reconnect buffer for testing.
 * Matches the expected interface the protocol will accept.
 */
function createSimpleReconnectBuffer() {
	const frames: Array<{ data: unknown; id: number; t: "msg" }> = []

	return {
		getAfter(lastId: number) {
			return frames.filter((f) => f.id > lastId)
		},
		push(frame: { data: unknown; id: number; t: "msg" }) {
			frames.push(frame)
		},
	}
}
