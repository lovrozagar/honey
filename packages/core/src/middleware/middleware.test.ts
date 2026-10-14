import { describe, expect, expectTypeOf, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import {
	collectMiddlewareMeta,
	compileChain,
	createMiddleware,
	defineMiddleware,
	type MiddlewareFn,
	namedMiddleware,
	type RuntimeMiddleware,
} from "./middleware.ts"

function ok(body = "ok"): Response {
	return new Response(body, { status: 200 })
}

/** The error boundary under test: a throw becomes a 500 whose body is the message. */
function convert(thrown: unknown): Response {
	return new Response(thrown instanceof Error ? thrown.message : String(thrown), { status: 500 })
}

const pass: RuntimeMiddleware = (_ctx, next) => next()
const addUser: RuntimeMiddleware = (_ctx, next) => next({ user: "alice" })
const addA: RuntimeMiddleware = (_ctx, next) => next({ a: 1 })
const addB: RuntimeMiddleware = (_ctx, next) => next({ b: 2 })
const addCustom: RuntimeMiddleware = async (_ctx, next) => next({ customKey: "value", userId: 123 })
const passFn = (_ctx: object, next: () => Response | Promise<Response>) => next()

const nextTwice: RuntimeMiddleware = async (_ctx, next) => {
	await next()
	return next()
}

const thrower: RuntimeMiddleware = () => {
	throw new HoneyError({ errorKey: "nope", status: "forbidden" })
}

const outerStatus: RuntimeMiddleware = async (_ctx, next) => {
	const res = await next()
	return new Response(`outer saw ${res.status}`)
}

async function run(chain: (ctx: object) => Response | Promise<Response>, ctx: object = {}): Promise<Response> {
	return chain(ctx)
}

describe("compileChain > 0 middleware", () => {
	// v0: e822c1372b
	// v0: 1481082cfb
	it("sync handler returns Response directly (no Promise wrapping)", () => {
		const result = compileChain([], () => ok(), convert)({})
		expect(result).toBeInstanceOf(Response)
		expect(result).not.toBeInstanceOf(Promise)
	})

	// v0: c14493256c
	it("async handler returns Promise<Response>", async () => {
		const result = compileChain([], async () => ok("async"), convert)({})
		expect(result).toBeInstanceOf(Promise)
		expect(await (await result).text()).toBe("async")
	})

	// v0: 32c6a1c07b
	// v0: f3de139e1f
	it("handler returns null throws helpful error", async () => {
		const res = await run(compileChain([], () => null as unknown as Response, convert))
		expect(res.status).toBe(500)
		expect(await res.text()).toBe("handler must return a Response — did you forget 'return ctx.res...()'?")
		const later = await run(compileChain([], async () => null as unknown as Response, convert))
		expect(await later.text()).toContain("handler must return a Response")
	})

	// v0: ed36da9f9a
	it("handler returns undefined throws helpful error", async () => {
		expect(await (await run(compileChain([], () => undefined as unknown as Response, convert))).text()).toContain(
			"handler must return a Response",
		)
	})

	it("a sync throw and an async rejection both reach the boundary with the ctx", async () => {
		const seen: unknown[] = []
		const record = (thrown: unknown, ctx: object) => {
			seen.push(thrown, ctx)
			return ok("converted")
		}
		const ctx = {}
		const sync = compileChain(
			[],
			() => {
				throw new Error("sync")
			},
			record,
		)(ctx)
		expect(sync).toBeInstanceOf(Response)
		await compileChain([], async () => Promise.reject(new Error("async")), record)(ctx)
		expect(seen.map((x) => (x instanceof Error ? x.message : x))).toEqual(["sync", ctx, "async", ctx])
	})
})

describe("compileChain > 1 middleware", () => {
	// v0: 4fd6a4c8bd
	it("calls middleware then handler", async () => {
		const order: string[] = []
		const mw: RuntimeMiddleware = async (_ctx, next) => {
			order.push("mw")
			return next()
		}
		await run(
			compileChain(
				[mw],
				() => {
					order.push("handler")
					return ok()
				},
				convert,
			),
		)
		expect(order).toEqual(["mw", "handler"])
	})

	// v0: 80b14f0a2f
	it("middleware adds context via next({key: value})", async () => {
		const res = await run(compileChain([addUser], (c) => ok(String((c as { user?: string }).user)), convert))
		expect(await res.text()).toBe("alice")
	})

	// v0: 106b34869a
	// v0: ca99e0a009
	it("next() called twice throws", async () => {
		expect(await (await run(compileChain([nextTwice], () => ok(), convert))).text()).toBe(
			"next() called multiple times",
		)
	})

	// v0: e0ebd6d122
	// v0: 8829ab598f
	it("middleware returns null throws helpful error", async () => {
		const mw = (async () => null) as unknown as RuntimeMiddleware
		const res = await run(compileChain([mw], () => ok(), convert))
		expect(await res.text()).toBe("middleware must return a Response — did you forget 'return next(...)'?")
		const sync = compileChain([(() => undefined) as unknown as RuntimeMiddleware], () => ok(), convert)({})
		expect(await (sync as Response).text()).toContain("middleware must return a Response")
	})
})

describe("compileChain > multiple middleware", () => {
	// v0: 9d66082220
	// v0: 4f6cf35dc8
	it("executes in order", async () => {
		const order: string[] = []
		const mw1: RuntimeMiddleware = async (_ctx, next) => {
			order.push("mw1")
			return next()
		}
		const mw2: RuntimeMiddleware = (_ctx, next) => {
			order.push("mw2")
			return next()
		}
		await run(
			compileChain(
				[mw1, mw2],
				() => {
					order.push("handler")
					return ok()
				},
				convert,
			),
		)
		expect(order).toEqual(["mw1", "mw2", "handler"])
	})

	// v0: ad03072861
	// v0: 3968c5070a
	it("each can add context", async () => {
		const ctx: Record<string, unknown> = {}
		await run(
			compileChain([addA, addB], () => ok(), convert),
			ctx,
		)
		expect(ctx).toEqual({ a: 1, b: 2 })
	})
})

describe("compileChain > sync spine", () => {
	it("sync middleware over a sync handler returns a Response, not a Promise", () => {
		const result = compileChain([pass, pass], () => ok("sync"), convert)({})
		expect(result).toBeInstanceOf(Response)
	})

	it("next() hands a sync middleware the downstream Response itself", () => {
		let seen: unknown
		const peek: RuntimeMiddleware = (_ctx, next) => {
			seen = next()
			return seen as Response
		}
		compileChain([peek], () => ok(), convert)({})
		expect(seen).toBeInstanceOf(Response)
	})

	it("a sync throw in a middleware is converted at that layer, without a Promise", async () => {
		const result = compileChain([pass, thrower], () => ok(), convert)({})
		expect(result).toBeInstanceOf(Response)
		expect(await (result as Response).text()).toBe("nope")
	})

	it("an outer middleware sees the converted response of an inner throw", async () => {
		const res = await run(compileChain([outerStatus], async () => Promise.reject(new Error("x")), convert))
		expect(await res.text()).toBe("outer saw 500")
	})
})

describe("compileChain > reserved keys", () => {
	for (const key of ["background", "cookies", "env", "headers", "params", "req", "res", "search"]) {
		// v0: 425dab9d38
		// v0: 39e01ebfb2
		it(`"${key}" is NOT merged into context`, async () => {
			const mw: RuntimeMiddleware = async (_ctx, next) => next({ [key]: "overwritten" })
			const ctx: Record<string, unknown> = { [key]: "original" }
			await run(
				compileChain([mw], () => ok(), convert),
				ctx,
			)
			expect(ctx[key]).toBe("original")
		})
	}

	// v0: 63c031cebf
	it("non-reserved keys ARE merged into context", async () => {
		const ctx: Record<string, unknown> = {}
		await run(
			compileChain([addCustom], () => ok(), convert),
			ctx,
		)
		expect(ctx).toEqual({ customKey: "value", userId: 123 })
	})
})

describe("middleware factories and meta", () => {
	it("createMiddleware returns the function and freezes its meta", () => {
		const mw = createMiddleware(passFn, { meta: { auth: "bearer" } })
		expect(mw).toBe(passFn)
		expect(mw.meta).toEqual({ auth: "bearer" })
		expect(Object.isFrozen(mw.meta)).toBe(true)
		expect(createMiddleware(async (_ctx, next) => next()).meta).toBeUndefined()
	})

	// v0: 989f510b71
	it("middleware meta may not set internal, to either value", () => {
		expect(() => createMiddleware((_ctx, next) => next(), { meta: { internal: true } })).toThrow(
			'cannot set "internal"',
		)
		expect(() => defineMiddleware({ fn: (_ctx, next) => next(), meta: { internal: false } })).toThrow(
			'cannot set "internal"',
		)
	})

	// v0: e83975eeb1
	it("defineMiddleware stores the error keys it names and its meta", () => {
		const factory = { gone: () => new HoneyError({ errorKey: "gone", status: "gone" }), nope: () => null }
		const mw = defineMiddleware({ errors: [factory, "gone"], fn: (_ctx, next) => next(), meta: { a: 1 } })
		expect(mw.errors).toEqual(["gone"])
		expect(mw.meta).toEqual({ a: 1 })
		const bare = defineMiddleware({ fn: (_ctx, next) => next() })
		expect(bare.errors).toBeUndefined()
		expect(bare.meta).toBeUndefined()
	})

	it("namedMiddleware stamps a stable name", () => {
		expect(namedMiddleware("cors", () => undefined).name).toBe("cors")
	})

	it("collectMiddlewareMeta merges in run order, later wins, null when none", () => {
		const a = createMiddleware((_c, next) => next(), { meta: { auth: "a", x: 1 } }) as unknown as RuntimeMiddleware
		const b = createMiddleware((_c, next) => next(), { meta: { auth: "b" } }) as unknown as RuntimeMiddleware
		expect(collectMiddlewareMeta([[a, pass], [b]])).toEqual({ auth: "b", x: 1 })
		expect(collectMiddlewareMeta([[pass]])).toBeNull()
	})
})

describe("middleware types", () => {
	it("next() may answer synchronously: await it, never .then it", () => {
		const mw = createMiddleware(async (_ctx: { user: string }, next) => {
			const res = await next({ role: "admin" })
			expectTypeOf(res).toExtend<Response>()
			return res
		})
		expectTypeOf(mw).toExtend<MiddlewareFn<{ user: string }, { role: string }>>()
		const sync = createMiddleware((_ctx, next) => next({ n: 1 }))
		expectTypeOf(sync).toExtend<MiddlewareFn<{}, { n: number }>>()
	})
})
