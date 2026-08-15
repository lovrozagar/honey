import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"

describe("ctx.executionCtx", () => {
	it("returns execution context when provided", async () => {
		const app = honey<{}>()
		let captured: unknown

		app.get("/test").handler((ctx) => {
			captured = ctx.executionCtx
			return ctx.res.text("ok", "ok")
		})

		const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
		await app.fetch(new Request("http://localhost/test"), {}, { waitUntil })
		expect(captured).toEqual({ waitUntil })
	})

	it("is undefined when not provided", async () => {
		const app = honey<{}>()
		let captured: unknown = "not-set"

		app.get("/test").handler((ctx) => {
			captured = ctx.executionCtx
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(captured).toBeUndefined()
	})

	it("ctx.background still works alongside executionCtx", async () => {
		const app = honey<{}>()
		const waitUntil = vi.fn<(p: Promise<unknown>) => void>()

		app.get("/test").handler((ctx) => {
			ctx.background(Promise.resolve("bg"))
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/test"), {}, { waitUntil })
		expect(waitUntil).toHaveBeenCalledOnce()
	})

	/**
	 * Regression: workerd's ExecutionContext.waitUntil is a native method that
	 * throws "Illegal invocation" when called with the wrong `this`. Earlier
	 * mocks used vi.fn() (a plain arrow-like function) which hid the bug —
	 * HoneyContext was capturing opts.waitUntil detached and invoking it without
	 * its owning executionCtx. This test models workerd's contract.
	 */
	it("ctx.background preserves `this` binding when executionCtx.waitUntil is a method", async () => {
		const app = honey<{}>()
		const captured: Promise<unknown>[] = []
		const executionCtx = {
			waitUntil(p: Promise<unknown>): void {
				if (this !== executionCtx) {
					throw new TypeError(
						"Illegal invocation: function called with incorrect `this` reference.",
					)
				}
				captured.push(p)
			},
		}

		app.get("/test").handler((ctx) => {
			ctx.background(Promise.resolve("bg"))
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(
			new Request("http://localhost/test"),
			{},
			executionCtx,
		)
		expect(res.status).toBe(200)
		expect(captured).toHaveLength(1)
	})

	/**
	 * Regression: when a handler throws and app.onError runs, the logger may
	 * call ctx.background to flush telemetry. If the binding is wrong, the
	 * error pipeline crashes with TypeError and the real error is masked —
	 * the user sees a 500 instead of the intended status.
	 */
	it("ctx.background preserves `this` binding on the error path", async () => {
		const app = honey<{}>()
		const captured: Promise<unknown>[] = []
		const executionCtx = {
			waitUntil(p: Promise<unknown>): void {
				if (this !== executionCtx) {
					throw new TypeError(
						"Illegal invocation: function called with incorrect `this` reference.",
					)
				}
				captured.push(p)
			},
		}

		app.get("/boom").handler((ctx) => {
			ctx.background(Promise.resolve("bg-before-throw"))
			throw new Error("boom")
		})

		const res = await app.fetch(
			new Request("http://localhost/boom"),
			{},
			executionCtx,
		)
		expect(res.status).toBe(500)
		expect(captured).toHaveLength(1)
	})

	/**
	 * Regression: unmatched routes go through the 404 handler, which also
	 * constructs a HoneyContext. Background calls from chain middleware on
	 * that path must not crash with Illegal invocation either.
	 */
	it("ctx.background preserves `this` binding on the 404 path", async () => {
		const captured: Promise<unknown>[] = []
		const executionCtx = {
			waitUntil(p: Promise<unknown>): void {
				if (this !== executionCtx) {
					throw new TypeError(
						"Illegal invocation: function called with incorrect `this` reference.",
					)
				}
				captured.push(p)
			},
		}

		const app = honey<{}>().use((ctx, next) => {
			ctx.background(Promise.resolve("bg-404"))
			return next()
		})

		const res = await app.fetch(
			new Request("http://localhost/does-not-exist"),
			{},
			executionCtx,
		)
		expect(res.status).toBe(404)
		expect(captured).toHaveLength(1)
	})
})
