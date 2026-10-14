import { describe, expect, it } from "vitest"
import { createMiddleware, defineMiddleware, type RuntimeMiddleware } from "../middleware/middleware.ts"
import {
	commonPrefix,
	describeMw,
	errorsOf,
	type MiddlewareSample,
	scopeGuard,
	timedMiddleware,
} from "./middleware-chain.ts"
import { parsePattern } from "./pattern.ts"

const ok = (): Response => new Response("ok")
const pass: RuntimeMiddleware = (_ctx, next) => next()
function recorder() {
	const samples: MiddlewareSample[] = []
	return { report: (s: MiddlewareSample) => samples.push(s), samples }
}

const authMw: RuntimeMiddleware = async function auth(_c, next) {
	return next()
}
const corsMw = function cors() {} as unknown as RuntimeMiddleware
const a: RuntimeMiddleware = (_c, next) => next()
const b: RuntimeMiddleware = (_c, next) => next()
const c: RuntimeMiddleware = (_c, next) => next()
const mark: RuntimeMiddleware = (ctx, next) => {
	ctx.marked = true
	return next()
}

describe("scopeGuard", () => {
	it("runs the middleware only for a request path inside the scope", () => {
		const guard = scopeGuard(parsePattern("/admin"), mark)
		const inside: Record<string, unknown> = { path: "/admin/users" }
		const outside: Record<string, unknown> = { path: "/public" }
		guard(inside, ok)
		guard(outside, ok)
		expect(inside.marked).toBe(true)
		expect(outside.marked).toBeUndefined()
	})

	it("keeps the middleware's name, error keys and meta", () => {
		const factory = { gone: () => null }
		const named = defineMiddleware({ errors: [factory, "gone"], fn: (_c, next) => next(), meta: { a: 1 } })
		Object.defineProperty(named, "name", { value: "auth" })
		const guard = scopeGuard(parsePattern("/x"), named as unknown as RuntimeMiddleware)
		expect(guard.name).toBe("auth")
		expect(errorsOf(guard)).toEqual(["gone"])
		expect((guard as { meta?: unknown }).meta).toEqual({ a: 1 })
		const plain = scopeGuard(parsePattern("/x"), pass)
		expect(errorsOf(plain)).toBeUndefined()
		expect((plain as { meta?: unknown }).meta).toBeUndefined()
	})
})

describe("timedMiddleware", () => {
	it("reports a sync middleware's duration and stays sync", () => {
		const { report, samples } = recorder()
		const timed = timedMiddleware(createMiddleware((_c, next) => next()) as unknown as RuntimeMiddleware, report)
		const out = timed({}, ok)
		expect(out).toBeInstanceOf(Response)
		expect(samples).toHaveLength(1)
		expect(samples[0]?.duration).toBeGreaterThanOrEqual(0)
		expect(samples[0]?.name).toBe("anonymous")
		expect(samples[0]).not.toHaveProperty("error")
	})

	it("reports an async middleware once it settles, with its name", async () => {
		const { report, samples } = recorder()
		const out = timedMiddleware(authMw, report)({}, ok)
		expect(out).toBeInstanceOf(Promise)
		await out
		expect(samples.map((s) => s.name)).toEqual(["auth"])
	})

	it("reports a sync throw and a rejection with the error, and rethrows", async () => {
		const { report, samples } = recorder()
		const boom = new Error("boom")
		const syncThrow: RuntimeMiddleware = () => {
			throw boom
		}
		const asyncThrow: RuntimeMiddleware = async () => Promise.reject(boom)
		expect(() => timedMiddleware(syncThrow, report)({}, ok)).toThrow(boom)
		await expect(timedMiddleware(asyncThrow, report)({}, ok)).rejects.toBe(boom)
		expect(samples.map((s) => s.error)).toEqual([boom, boom])
	})

	it("a reporter that throws never breaks the request", async () => {
		const timed = timedMiddleware(pass, () => {
			throw new Error("telemetry down")
		})
		expect(timed({}, ok)).toBeInstanceOf(Response)
		const asyncTimed = timedMiddleware(
			async (_c, next) => next(),
			() => {
				throw new Error("telemetry down")
			},
		)
		expect(await asyncTimed({}, ok)).toBeInstanceOf(Response)
	})
})

describe("commonPrefix", () => {
	it("is the longest run every chain starts with", () => {
		expect(
			commonPrefix([
				[a, b, c],
				[a, b],
				[a, b, a],
			]),
		).toEqual([a, b])
		expect(commonPrefix([[a], [b]])).toEqual([])
		expect(commonPrefix([[a, b]])).toEqual([a, b])
		expect(commonPrefix([])).toEqual([])
	})
})

describe("describeMw", () => {
	it("names a middleware, or calls it anonymous", () => {
		expect(describeMw(corsMw)).toBe('"cors"')
		expect(
			describeMw(Object.defineProperty(() => undefined, "name", { value: "" }) as unknown as RuntimeMiddleware),
		).toBe("an anonymous middleware")
	})
})
