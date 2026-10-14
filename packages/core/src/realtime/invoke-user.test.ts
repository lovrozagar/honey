import { describe, expect, it, vi } from "vitest"
import { createEventQueue, invokeUser, reportUserError } from "./invoke-user.ts"

const boom = new Error("boom")

describe("invokeUser: a user callback never throws into the runtime", () => {
	it.each([
		["returns", () => "ok", true],
		["resolves", async () => "ok", true],
		["returns a plain object", () => ({ ok: 1 }), true],
		[
			"throws",
			() => {
				throw boom
			},
			false,
		],
		["rejects", () => Promise.reject(boom), false],
	])("a callback that %s settles to %s, never rejecting", async (_case, fn, ok) => {
		const onError = vi.fn()
		expect([await invokeUser(fn, { onError, phase: "message" }), onError.mock.calls.length]).toEqual([ok, ok ? 0 : 1])
	})
})

describe("reportUserError: where the failure goes", () => {
	it("to onError when given, else to the logger with the phase and fields", () => {
		const onError = vi.fn()
		const log = { error: vi.fn() }
		reportUserError(boom, { onError, phase: "open" })
		reportUserError(boom, { fields: { route: "/ws" }, log, phase: "open" })
		expect([onError.mock.calls, log.error.mock.calls]).toEqual([
			[[boom]],
			[[{ err: boom, phase: "open", route: "/ws" }, "callback failed"]],
		])
	})

	it("an onError that throws or rejects is logged under its own phase, and not called again", async () => {
		const log = { error: vi.fn() }
		const second = new Error("onError failed")
		const thrower = vi.fn(() => {
			throw second
		})
		reportUserError(boom, { log, onError: thrower, phase: "message" })
		reportUserError(boom, { log, onError: () => Promise.reject(second), phase: "message" })
		await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(2))
		expect([thrower.mock.calls.length, log.error.mock.calls.map(([fields]) => fields.phase)]).toEqual([
			1,
			["onError", "onError"],
		])
	})

	it("a logger that throws, or no logger at all, never takes the failure's place as what escapes", () => {
		const broken = {
			error: () => {
				throw new Error("logger down")
			},
		}
		expect(() => reportUserError(boom, { log: broken, phase: "close" })).not.toThrow()
		expect(() => reportUserError(boom, { phase: "close" })).not.toThrow()
		expect(() => reportUserError(boom, { log: {}, phase: "close" })).not.toThrow()
	})
})

describe("createEventQueue: one ordered lane", () => {
	it("runs each task after the previous one settled, and a failing task never stops the rest", async () => {
		const queue = createEventQueue()
		const order: string[] = []
		const slow = Promise.withResolvers<void>()
		void queue.push(async () => {
			await slow.promise
			order.push("first")
		})
		void queue.push(() => Promise.reject(boom))
		const last = queue.push(async () => {
			order.push("third")
		})
		slow.resolve()
		await last
		expect(order).toEqual(["first", "third"])
	})
})
