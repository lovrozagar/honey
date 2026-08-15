import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { ReconnectBuffer } from "../../../src/realtime/buffer.ts"

/* ------------------------------------------------------------------ */
/*  Basic operations                                                   */
/* ------------------------------------------------------------------ */

describe("ReconnectBuffer — basic operations", () => {
	it("creates with default size of 100", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()

		for (let i = 0; i < 100; i++) {
			buf.push(token, `msg-${i}`)
		}

		const result = buf.replay(token, 0)
		expect(result).toHaveLength(100)
	})

	it("creates with custom size", () => {
		const buf = new ReconnectBuffer({ size: 10 })
		const token = buf.create()

		for (let i = 0; i < 10; i++) {
			buf.push(token, `msg-${i}`)
		}

		const result = buf.replay(token, 0)
		expect(result).toHaveLength(10)
	})

	it("push returns monotonic IDs starting at 1", () => {
		const buf = new ReconnectBuffer({ size: 10 })
		const token = buf.create()

		const id1 = buf.push(token, "a")
		const id2 = buf.push(token, "b")
		const id3 = buf.push(token, "c")

		expect(id1).toBe(1)
		expect(id2).toBe(2)
		expect(id3).toBe(3)
	})

	it("push and retrieve a single message", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()

		buf.push(token, { payload: 42, type: "hello" })

		const result = buf.replay(token, 0)
		expect(result).toEqual([{ data: { payload: 42, type: "hello" }, id: 1 }])
	})

	it("create returns a non-empty string token", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()

		expect(typeof token).toBe("string")
		expect(token.length).toBeGreaterThan(0)
	})

	it("preserves message order in replay", () => {
		const buf = new ReconnectBuffer({ size: 5 })
		const token = buf.create()

		buf.push(token, "first")
		buf.push(token, "second")
		buf.push(token, "third")

		const result = buf.replay(token, 0)
		expect(result).toEqual([
			{ data: "first", id: 1 },
			{ data: "second", id: 2 },
			{ data: "third", id: 3 },
		])
	})
})

/* ------------------------------------------------------------------ */
/*  Ring behavior                                                      */
/* ------------------------------------------------------------------ */

describe("ReconnectBuffer — ring behavior", () => {
	it("evicts oldest when capacity exceeded", () => {
		const buf = new ReconnectBuffer({ size: 5 })
		const token = buf.create()

		for (let i = 1; i <= 7; i++) {
			buf.push(token, `msg-${i}`)
		}

		const result = buf.replay(token, 0)
		expect(result).toHaveLength(5)
		/* oldest two (id 1, 2) should be evicted, remaining are ids 3-7 */
		expect(result).toEqual([
			{ data: "msg-3", id: 3 },
			{ data: "msg-4", id: 4 },
			{ data: "msg-5", id: 5 },
			{ data: "msg-6", id: 6 },
			{ data: "msg-7", id: 7 },
		])
	})

	it("buffer of size 1 always holds only the last message", () => {
		const buf = new ReconnectBuffer({ size: 1 })
		const token = buf.create()

		buf.push(token, "a")
		buf.push(token, "b")
		buf.push(token, "c")

		const result = buf.replay(token, 0)
		expect(result).toEqual([{ data: "c", id: 3 }])
	})

	it("IDs continue incrementing after wrap-around", () => {
		const buf = new ReconnectBuffer({ size: 3 })
		const token = buf.create()

		for (let i = 1; i <= 10; i++) {
			const id = buf.push(token, `m-${i}`)
			expect(id).toBe(i)
		}

		const result = buf.replay(token, 0)
		expect(result).toEqual([
			{ data: "m-8", id: 8 },
			{ data: "m-9", id: 9 },
			{ data: "m-10", id: 10 },
		])
	})

	it("exact capacity fill does not evict", () => {
		const buf = new ReconnectBuffer({ size: 3 })
		const token = buf.create()

		buf.push(token, "x")
		buf.push(token, "y")
		buf.push(token, "z")

		const result = buf.replay(token, 0)
		expect(result).toHaveLength(3)
		expect(result?.[0]?.id).toBe(1)
	})

	it("large overfill preserves only last N", () => {
		const buf = new ReconnectBuffer({ size: 5 })
		const token = buf.create()

		for (let i = 1; i <= 1000; i++) {
			buf.push(token, i)
		}

		const result = buf.replay(token, 0)
		expect(result).toHaveLength(5)
		expect(result?.[0]?.id).toBe(996)
		expect(result?.[4]?.id).toBe(1000)
	})
})

/* ------------------------------------------------------------------ */
/*  Resume semantics                                                   */
/* ------------------------------------------------------------------ */

describe("ReconnectBuffer — resume semantics", () => {
	it("replay(token, lastId) returns messages where id > lastId", () => {
		const buf = new ReconnectBuffer({ size: 10 })
		const token = buf.create()

		for (let i = 1; i <= 5; i++) {
			buf.push(token, `msg-${i}`)
		}

		const result = buf.replay(token, 3)
		expect(result).toEqual([
			{ data: "msg-4", id: 4 },
			{ data: "msg-5", id: 5 },
		])
	})

	it("replay(token, 0) returns all buffered messages", () => {
		const buf = new ReconnectBuffer({ size: 10 })
		const token = buf.create()

		buf.push(token, "a")
		buf.push(token, "b")

		const result = buf.replay(token, 0)
		expect(result).toHaveLength(2)
		expect(result?.[0]?.id).toBe(1)
		expect(result?.[1]?.id).toBe(2)
	})

	it("replay(token, currentMax) returns empty array", () => {
		const buf = new ReconnectBuffer({ size: 10 })
		const token = buf.create()

		buf.push(token, "a")
		buf.push(token, "b")
		buf.push(token, "c")

		const result = buf.replay(token, 3)
		expect(result).toEqual([])
	})

	it("replay(unknownToken, 0) returns null", () => {
		const buf = new ReconnectBuffer()
		const result = buf.replay("nonexistent-token", 0)

		expect(result).toBeNull()
	})

	it("replay with lastId in the evicted range returns only what remains", () => {
		const buf = new ReconnectBuffer({ size: 3 })
		const token = buf.create()

		for (let i = 1; i <= 6; i++) {
			buf.push(token, `msg-${i}`)
		}

		/* ids 1-3 evicted, buffer has 4-6. lastId=2 is evicted, so return all remaining */
		const result = buf.replay(token, 2)
		expect(result).toEqual([
			{ data: "msg-4", id: 4 },
			{ data: "msg-5", id: 5 },
			{ data: "msg-6", id: 6 },
		])
	})
})

/* ------------------------------------------------------------------ */
/*  Token management                                                   */
/* ------------------------------------------------------------------ */

describe("ReconnectBuffer — token management", () => {
	it("create returns a unique token each time", () => {
		const buf = new ReconnectBuffer()
		const tokens = new Set<string>()

		for (let i = 0; i < 50; i++) {
			tokens.add(buf.create())
		}

		expect(tokens.size).toBe(50)
	})

	it("multiple connections have independent buffers", () => {
		const buf = new ReconnectBuffer({ size: 5 })
		const tokenA = buf.create()
		const tokenB = buf.create()

		buf.push(tokenA, "a1")
		buf.push(tokenA, "a2")
		buf.push(tokenB, "b1")

		const resultA = buf.replay(tokenA, 0)
		const resultB = buf.replay(tokenB, 0)

		expect(resultA).toEqual([
			{ data: "a1", id: 1 },
			{ data: "a2", id: 2 },
		])
		expect(resultB).toEqual([{ data: "b1", id: 1 }])
	})

	it("IDs are monotonic per connection, not global", () => {
		const buf = new ReconnectBuffer()
		const tokenA = buf.create()
		const tokenB = buf.create()

		const idA1 = buf.push(tokenA, "x")
		const idB1 = buf.push(tokenB, "y")
		const idA2 = buf.push(tokenA, "z")

		/* both connections start at 1 independently */
		expect(idA1).toBe(1)
		expect(idB1).toBe(1)
		expect(idA2).toBe(2)
	})

	it("destroy removes the buffer immediately", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()
		buf.push(token, "data")

		buf.destroy(token)

		const result = buf.replay(token, 0)
		expect(result).toBeNull()
	})

	it("destroy on unknown token does not throw", () => {
		const buf = new ReconnectBuffer()
		expect(() => buf.destroy("nonexistent")).not.toThrow()
	})
})

/* ------------------------------------------------------------------ */
/*  TTL / expiry                                                       */
/* ------------------------------------------------------------------ */

describe("ReconnectBuffer — TTL / expiry", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("disconnected buffer expires after default TTL (5 minutes)", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()
		buf.push(token, "important")

		buf.disconnect(token)

		/* just before expiry — still available */
		vi.advanceTimersByTime(5 * 60 * 1000 - 1)
		expect(buf.replay(token, 0)).toEqual([{ data: "important", id: 1 }])

		/* at expiry — gone */
		vi.advanceTimersByTime(1)
		expect(buf.replay(token, 0)).toBeNull()
	})

	it("disconnected buffer expires after custom TTL", () => {
		const buf = new ReconnectBuffer({ ttl: 10_000 })
		const token = buf.create()
		buf.push(token, "data")

		buf.disconnect(token)

		vi.advanceTimersByTime(9_999)
		expect(buf.replay(token, 0)).not.toBeNull()

		vi.advanceTimersByTime(1)
		expect(buf.replay(token, 0)).toBeNull()
	})

	it("active buffer (not disconnected) does not expire", () => {
		const buf = new ReconnectBuffer({ ttl: 1_000 })
		const token = buf.create()
		buf.push(token, "data")

		/* advance well past TTL without calling disconnect */
		vi.advanceTimersByTime(60_000)

		const result = buf.replay(token, 0)
		expect(result).toEqual([{ data: "data", id: 1 }])
	})

	it("expired token returns null on replay", () => {
		const buf = new ReconnectBuffer({ ttl: 2_000 })
		const token = buf.create()
		buf.push(token, "x")

		buf.disconnect(token)
		vi.advanceTimersByTime(2_000)

		expect(buf.replay(token, 0)).toBeNull()
	})

	it("push after disconnect but before expiry still works", () => {
		const buf = new ReconnectBuffer({ ttl: 10_000 })
		const token = buf.create()
		buf.push(token, "before")

		buf.disconnect(token)
		vi.advanceTimersByTime(5_000)

		/* reconnected — push more data */
		const id = buf.push(token, "after")
		expect(id).toBe(2)

		const result = buf.replay(token, 0)
		expect(result).toEqual([
			{ data: "before", id: 1 },
			{ data: "after", id: 2 },
		])
	})
})

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("ReconnectBuffer — edge cases", () => {
	it("empty buffer replay returns empty array", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()

		const result = buf.replay(token, 0)
		expect(result).toEqual([])
	})

	it("push after replay works correctly", () => {
		const buf = new ReconnectBuffer({ size: 10 })
		const token = buf.create()

		buf.push(token, "a")
		const replayed = buf.replay(token, 0)
		expect(replayed).toHaveLength(1)

		buf.push(token, "b")
		const replayed2 = buf.replay(token, 0)
		expect(replayed2).toHaveLength(2)
		expect(replayed2).toEqual([
			{ data: "a", id: 1 },
			{ data: "b", id: 2 },
		])
	})

	it("large lastId beyond buffer range returns empty array", () => {
		const buf = new ReconnectBuffer({ size: 5 })
		const token = buf.create()

		buf.push(token, "a")
		buf.push(token, "b")

		const result = buf.replay(token, 999)
		expect(result).toEqual([])
	})

	it("buffer size 0 throws on construction", () => {
		expect(() => new ReconnectBuffer({ size: 0 })).toThrow()
	})

	it("negative buffer size throws on construction", () => {
		expect(() => new ReconnectBuffer({ size: -1 })).toThrow()
	})

	it("push to unknown token throws", () => {
		const buf = new ReconnectBuffer()
		expect(() => buf.push("bogus-token", "data")).toThrow()
	})

	it("disconnect on unknown token does not throw", () => {
		const buf = new ReconnectBuffer()
		expect(() => buf.disconnect("bogus-token")).not.toThrow()
	})

	it("data types are preserved through push/replay", () => {
		const buf = new ReconnectBuffer({ size: 10 })
		const token = buf.create()

		buf.push(token, null)
		buf.push(token, undefined)
		buf.push(token, 0)
		buf.push(token, "")
		buf.push(token, false)
		buf.push(token, [1, 2, 3])
		buf.push(token, { nested: { deep: true } })

		const result = buf.replay(token, 0)
		expect(result).toEqual([
			{ data: null, id: 1 },
			{ data: undefined, id: 2 },
			{ data: 0, id: 3 },
			{ data: "", id: 4 },
			{ data: false, id: 5 },
			{ data: [1, 2, 3], id: 6 },
			{ data: { nested: { deep: true } }, id: 7 },
		])
	})
})

/* ------------------------------------------------------------------ */
/*  Type contracts                                                     */
/* ------------------------------------------------------------------ */

describe("ReconnectBuffer — type contracts", () => {
	it("create() returns string", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()
		expectTypeOf(token).toEqualTypeOf<string>()
	})

	it("push() returns number (the assigned id)", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()
		const id = buf.push(token, "data")
		expectTypeOf(id).toEqualTypeOf<number>()
	})

	it("replay() returns array of {id, data} or null", () => {
		const buf = new ReconnectBuffer()
		const token = buf.create()
		const result = buf.replay(token, 0)
		expectTypeOf(result).toEqualTypeOf<Array<{ data: unknown; id: number }> | null>()
	})

	it("constructor accepts optional partial config", () => {
		expectTypeOf(ReconnectBuffer).toBeConstructibleWith()
		expectTypeOf(ReconnectBuffer).toBeConstructibleWith({})
		expectTypeOf(ReconnectBuffer).toBeConstructibleWith({ size: 50 })
		expectTypeOf(ReconnectBuffer).toBeConstructibleWith({ ttl: 1000 })
		expectTypeOf(ReconnectBuffer).toBeConstructibleWith({ size: 50, ttl: 1000 })
	})
})
