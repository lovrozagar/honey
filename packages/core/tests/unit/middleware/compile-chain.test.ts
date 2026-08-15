import { describe, expect, it } from "vitest"
import type { RuntimeMiddleware } from "../../../src/middleware.ts"
import { compileChain, executeChain } from "../../../src/middleware.ts"

function ok(body = "ok"): Response {
	return new Response(body, { status: 200 })
}

describe("compileChain", () => {
	describe("0 middleware", () => {
		it("sync handler returns Response directly (no Promise wrapping)", () => {
			const chain = compileChain([], () => ok())
			const result = chain({})
			/* sync path must NOT wrap in a Promise */
			expect(result).toBeInstanceOf(Response)
			expect(result).not.toBeInstanceOf(Promise)
		})

		it("async handler returns Promise<Response>", async () => {
			const chain = compileChain([], async () => ok("async"))
			const result = chain({})
			expect(result).toBeInstanceOf(Promise)
			const res = await result
			expect(res).toBeInstanceOf(Response)
			expect(await res.text()).toBe("async")
		})

		it("handler returns null throws helpful error", () => {
			const chain = compileChain([], () => null as unknown as Response)
			expect(() => chain({})).toThrow("handler must return a Response")
		})

		it("handler returns undefined throws helpful error", () => {
			const chain = compileChain([], () => undefined as unknown as Response)
			expect(() => chain({})).toThrow("handler must return a Response")
		})

		it("sync handler result is not a Promise", () => {
			const chain = compileChain([], () => ok("sync-check"))
			const result = chain({})
			/* verify no Promise wrapping — instanceof check + typeof .then */
			expect(typeof (result as Promise<Response>).then).not.toBe("function")
		})
	})

	describe("1 middleware", () => {
		it("calls middleware then handler", async () => {
			const order: string[] = []
			const mw: RuntimeMiddleware = async (_ctx, next) => {
				order.push("mw")
				return next()
			}
			const chain = compileChain([mw], () => {
				order.push("handler")
				return ok()
			})
			await chain({})
			expect(order).toEqual(["mw", "handler"])
		})

		it("middleware adds context via next({key: value})", async () => {
			const mw: RuntimeMiddleware = async (_ctx, next) => {
				return next({ userId: "42" })
			}
			const ctx: Record<string, unknown> = {}
			const chain = compileChain([mw], (c) => {
				expect((c as Record<string, unknown>).userId).toBe("42")
				return ok()
			})
			await chain(ctx)
			expect(ctx.userId).toBe("42")
		})

		it("next() called twice throws", async () => {
			const mw: RuntimeMiddleware = async (_ctx, next) => {
				await next()
				return next()
			}
			const chain = compileChain([mw], () => ok())
			await expect(chain({})).rejects.toThrow("next() called multiple times")
		})

		it("middleware returns null throws helpful error", async () => {
			const mw: RuntimeMiddleware = async (_ctx, next) => {
				await next()
				return null as unknown as Response
			}
			const chain = compileChain([mw], () => ok())
			await expect(chain({})).rejects.toThrow("middleware must return a Response")
		})
	})

	describe("multiple middleware", () => {
		it("executes in order", async () => {
			const order: string[] = []
			const mw1: RuntimeMiddleware = async (_ctx, next) => {
				order.push("mw1")
				return next()
			}
			const mw2: RuntimeMiddleware = async (_ctx, next) => {
				order.push("mw2")
				return next()
			}
			const chain = compileChain([mw1, mw2], () => {
				order.push("handler")
				return ok()
			})
			await chain({})
			expect(order).toEqual(["mw1", "mw2", "handler"])
		})

		it("each can add context", async () => {
			const mw1: RuntimeMiddleware = async (_ctx, next) => {
				return next({ a: 1 })
			}
			const mw2: RuntimeMiddleware = async (_ctx, next) => {
				return next({ b: 2 })
			}
			const ctx: Record<string, unknown> = {}
			const chain = compileChain([mw1, mw2], (c) => {
				const rc = c as Record<string, unknown>
				expect(rc.a).toBe(1)
				expect(rc.b).toBe(2)
				return ok()
			})
			await chain(ctx)
		})
	})

	describe("reserved keys", () => {
		const reservedKeys = [
			"background",
			"cookies",
			"env",
			"headers",
			"params",
			"req",
			"res",
			"search",
		]

		for (const key of reservedKeys) {
			it(`"${key}" is NOT merged into context`, async () => {
				const mw: RuntimeMiddleware = async (_ctx, next) => {
					return next({ [key]: "overwritten" })
				}
				const ctx: Record<string, unknown> = { [key]: "original" }
				const chain = compileChain([mw], () => ok())
				await chain(ctx)
				expect(ctx[key]).toBe("original")
			})
		}

		it("non-reserved keys ARE merged into context", async () => {
			const mw: RuntimeMiddleware = async (_ctx, next) => {
				return next({ customKey: "value", userId: 123 })
			}
			const ctx: Record<string, unknown> = {}
			const chain = compileChain([mw], () => ok())
			await chain(ctx)
			expect(ctx.customKey).toBe("value")
			expect(ctx.userId).toBe(123)
		})
	})
})

describe("executeChain", () => {
	it("executes middleware in order then handler", async () => {
		const order: string[] = []
		const mw1: RuntimeMiddleware = async (_ctx, next) => {
			order.push("mw1")
			return next()
		}
		const mw2: RuntimeMiddleware = async (_ctx, next) => {
			order.push("mw2")
			return next()
		}
		const res = await executeChain([mw1, mw2], {}, () => {
			order.push("handler")
			return ok()
		})
		expect(order).toEqual(["mw1", "mw2", "handler"])
		expect(res).toBeInstanceOf(Response)
	})

	it("each middleware can add context", async () => {
		const mw1: RuntimeMiddleware = async (_ctx, next) => next({ a: 1 })
		const mw2: RuntimeMiddleware = async (_ctx, next) => next({ b: 2 })
		const ctx: Record<string, unknown> = {}
		await executeChain([mw1, mw2], ctx, (c) => {
			const rc = c as Record<string, unknown>
			expect(rc.a).toBe(1)
			expect(rc.b).toBe(2)
			return ok()
		})
	})

	it("index tracking prevents re-entry (next called twice)", async () => {
		const mw: RuntimeMiddleware = async (_ctx, next) => {
			await next()
			return next()
		}
		await expect(executeChain([mw], {}, () => ok())).rejects.toThrow("next() called multiple times")
	})

	it("handler returning null throws helpful error", async () => {
		const mw: RuntimeMiddleware = async (_ctx, next) => next()
		await expect(executeChain([mw], {}, () => null as unknown as Response)).rejects.toThrow(
			"handler must return a Response",
		)
	})

	it("middleware returning null throws helpful error", async () => {
		const mw: RuntimeMiddleware = async (_ctx, next) => {
			await next()
			return null as unknown as Response
		}
		await expect(executeChain([mw], {}, () => ok())).rejects.toThrow(
			"middleware must return a Response",
		)
	})

	it("reserved keys are NOT merged in general path", async () => {
		const mw: RuntimeMiddleware = async (_ctx, next) => {
			return next({ customKey: "good", env: "bad" })
		}
		const ctx: Record<string, unknown> = { env: "original" }
		await executeChain([mw], ctx, () => ok())
		expect(ctx.env).toBe("original")
		expect(ctx.customKey).toBe("good")
	})
})
