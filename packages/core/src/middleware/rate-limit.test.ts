import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PEER_ADDRESS } from "../context/peer.ts"
import { isHoneyResponse, NODE_OUTBOUND } from "../response/builder.ts"
import { honey } from "../routing/app.ts"
import { memoryStore, rateLimit, type RateLimitOptions } from "./rate-limit.ts"

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0)

beforeEach(() => {
	vi.useFakeTimers({ now: T0, toFake: ["Date"] })
})

afterEach(() => {
	vi.useRealTimers()
})

/** GET /t behind rateLimit(options); `handled` counts the requests that reached the handler. */
function app(options: RateLimitOptions) {
	const a = honey<{}>()
	const seen = { handled: 0 }
	a.use(rateLimit(options))
		.get("/t")
		.handler((ctx) => {
			seen.handled += 1
			return ctx.res.text("ok", "x")
		})
	return Object.assign(a, { seen })
}

function request(init: { headers?: Record<string, string>; peer?: string; node?: boolean } = {}) {
	const req = new Request("https://app.example.com/t", { headers: init.headers })
	if (init.peer !== undefined) Object.defineProperty(req, PEER_ADDRESS, { value: init.peer })
	if (init.node) Object.defineProperty(req, NODE_OUTBOUND, { value: true })
	return req
}

async function send(a: ReturnType<typeof app>, init?: Parameters<typeof request>[0]) {
	const res = await a.fetch(request(init), {})
	const body = (await res.json().catch(() => null)) as { error_key?: string } | null
	const header = (name: string) => res.headers.get(name)
	return {
		errorKey: body?.error_key ?? null,
		limit: header("x-ratelimit-limit"),
		remaining: header("x-ratelimit-remaining"),
		reset: header("x-ratelimit-reset"),
		res,
		retryAfter: header("retry-after"),
		status: res.status,
	}
}

describe("rateLimit(): the fixed window", () => {
	it("100 requests under a limit of 100 all pass, the last with X-RateLimit-Remaining 0", async () => {
		const a = app({ limit: 100, windowMs: 60_000 })
		const answers = []
		for (let i = 0; i < 100; i += 1) answers.push(await send(a, { peer: "203.0.113.7" }))
		expect([
			answers.every((answer) => answer.status === 200),
			answers[0]?.remaining,
			answers[99]?.remaining,
			a.seen.handled,
		]).toEqual([true, "99", "0", 100])
	})

	it("the 101st is 429 too_many_requests with Retry-After, and never reaches the handler", async () => {
		const a = app({ limit: 100, windowMs: 60_000 })
		for (let i = 0; i < 100; i += 1) await send(a, { peer: "203.0.113.7" })
		const refused = await send(a, { peer: "203.0.113.7" })
		expect([refused.status, refused.errorKey, refused.retryAfter, refused.remaining, a.seen.handled]).toEqual([
			429,
			"too_many_requests",
			"60",
			"0",
			100,
		])
	})

	it("X-RateLimit-Limit is the limit, X-RateLimit-Reset the window's end in epoch seconds", async () => {
		const { limit, reset } = await send(app({ limit: 5, windowMs: 60_000 }), { peer: "203.0.113.7" })
		expect([limit, reset]).toEqual(["5", String((T0 + 60_000) / 1000)])
	})

	it("Retry-After counts down to the window's end, in whole seconds rounded up", async () => {
		const a = app({ limit: 1, windowMs: 60_000 })
		await send(a, { peer: "203.0.113.7" })
		vi.setSystemTime(T0 + 30_500)
		expect((await send(a, { peer: "203.0.113.7" })).retryAfter).toBe("30")
	})

	it("a window elapsed: the counter starts over", async () => {
		const a = app({ limit: 1, windowMs: 60_000 })
		await send(a, { peer: "203.0.113.7" })
		const refused = await send(a, { peer: "203.0.113.7" })
		vi.setSystemTime(T0 + 60_000)
		const fresh = await send(a, { peer: "203.0.113.7" })
		expect([refused.status, fresh.status, fresh.remaining, fresh.reset]).toEqual([
			429,
			200,
			"0",
			String((T0 + 120_000) / 1000),
		])
	})
})

describe("rateLimit(): the key", () => {
	it("each ctx.ip has its own window", async () => {
		const a = app({ limit: 1, windowMs: 60_000 })
		const first = await send(a, { peer: "203.0.113.7" })
		const other = await send(a, { peer: "198.51.100.2" })
		const again = await send(a, { peer: "203.0.113.7" })
		expect([first.status, other.status, again.status]).toEqual([200, 200, 429])
	})

	it("X-Forwarded-For and X-Real-IP do not change the key: a client cannot rotate its window", async () => {
		const a = app({ limit: 1, windowMs: 60_000 })
		await send(a, { peer: "203.0.113.7" })
		const spoofed = await send(a, {
			headers: { "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.10" },
			peer: "203.0.113.7",
		})
		expect(spoofed.status).toBe(429)
	})

	it("no runtime-reported peer: those requests share one window rather than going unlimited", async () => {
		const a = app({ limit: 1, windowMs: 60_000 })
		expect([(await send(a)).status, (await send(a)).status]).toEqual([200, 429])
	})

	it("a key function picks the window instead (an API key, a user)", async () => {
		const a = app({ key: (ctx) => ctx.req.headers.get("x-api-key") ?? "anonymous", limit: 1, windowMs: 60_000 })
		const keyA = await send(a, { headers: { "x-api-key": "a" }, peer: "203.0.113.7" })
		const keyB = await send(a, { headers: { "x-api-key": "b" }, peer: "203.0.113.7" })
		const keyAgain = await send(a, { headers: { "x-api-key": "a" }, peer: "198.51.100.2" })
		expect([keyA.status, keyB.status, keyAgain.status]).toEqual([200, 200, 429])
	})
})

describe("rateLimit(): the memory store is bounded", () => {
	it("cap+1 distinct keys evict the least recently used; the store never grows past the cap", () => {
		const store = memoryStore({ maxKeys: 2, windowMs: 60_000 })
		store.hit("a")
		store.hit("b")
		store.hit("a")
		store.hit("c")
		const sizeAfterSpray = store.size
		expect([sizeAfterSpray, store.hit("a").count, store.hit("b").count]).toEqual([2, 3, 1])
	})

	it("a spray of distinct keys keeps the store at its cap", () => {
		const store = memoryStore({ maxKeys: 1000, windowMs: 60_000 })
		for (let i = 0; i < 50_000; i += 1) store.hit(`2001:db8::${i.toString(16)}`)
		expect(store.size).toBe(1000)
	})

	it("an expired window is replaced, not counted on", () => {
		const store = memoryStore({ maxKeys: 10, windowMs: 1000 })
		store.hit("a")
		vi.setSystemTime(T0 + 1000)
		expect(store.hit("a")).toEqual({ count: 1, resetAt: T0 + 2000 })
	})
})

describe("rateLimit(): a custom store", () => {
	it("its count and resetAt drive the answer, sync or async", async () => {
		const resetAt = T0 + 5000
		const async = app({ limit: 3, store: { hit: async () => ({ count: 4, resetAt }) } })
		const sync = app({ limit: 3, store: { hit: () => ({ count: 2, resetAt }) } })
		const [refused, passed] = [await send(async), await send(sync)]
		expect([refused.status, refused.retryAfter, refused.reset, passed.status, passed.remaining]).toEqual([
			429,
			"5",
			String(resetAt / 1000),
			200,
			"1",
		])
	})
})

describe("rateLimit(): the answer it edits", () => {
	it("on a Node-bridge answer the headers go on the plain header map", async () => {
		const { res } = await send(app({ limit: 5, windowMs: 60_000 }), { node: true, peer: "203.0.113.7" })
		expect([isHoneyResponse(res), res.headers.get("x-ratelimit-remaining")]).toEqual([true, "4"])
	})

	it("a 101 upgrade passes through untouched", async () => {
		const a = honey<{}>()
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		a.use(rateLimit({ limit: 5, windowMs: 60_000 }))
			.get("/t")
			.handler(() => upgraded as never)
		const res = await a.fetch(request({ peer: "203.0.113.7" }), {})
		expect([res === upgraded, res.headers.has("x-ratelimit-limit")]).toEqual([true, false])
	})
})

describe("rateLimit(): construction", () => {
	it.each([
		["a limit of 0", { limit: 0, windowMs: 1000 }, "rateLimit: limit must be a positive integer"],
		["a fractional limit", { limit: 1.5, windowMs: 1000 }, "rateLimit: limit must be a positive integer"],
		["a window of 0", { limit: 1, windowMs: 0 }, "rateLimit: windowMs must be a positive finite number"],
		["an infinite window", { limit: 1, windowMs: Infinity }, "rateLimit: windowMs must be a positive finite number"],
		["a cap of 0", { limit: 1, maxKeys: 0, windowMs: 1000 }, "rateLimit: maxKeys must be a positive integer"],
	] as const)("refuses %s", (_name, options, message) => {
		expect(() => rateLimit(options)).toThrow(message)
	})

	it("declares the error it answers with", () => {
		expect(rateLimit({ limit: 1, windowMs: 1000 }).errors).toEqual(["too_many_requests"])
	})
})
