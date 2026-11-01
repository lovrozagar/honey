import { describe, expect, it, vi } from "vitest"
import { WSContextImpl } from "../ws/contract.ts"
import { resolveRealtimeConfig } from "./route.ts"
import { createRealtimeSession } from "./server.ts"

/** Every task the session's lane holds has run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/* 1.0 keeps a session's state in private fields, which a session derived with Object.create lacks: on
   1.0.0-rc.4 every method threw "Cannot read private member". It runs on the original's state now. */
describe("createRealtimeSession: a session derived with Object.create", () => {
	it("attaches, takes frames, reports errors and closes as the original", async () => {
		const got: unknown[] = []
		const closed: string[] = []
		const config = resolveRealtimeConfig("/rt", {
			handler: (_ctx, conn) => {
				conn.on("message", (p) => void got.push(p))
				conn.on("close", (reason) => void closed.push(reason))
			},
		})
		const log = { error: vi.fn<(fields: Record<string, unknown>, msg?: string) => void>() }
		const base = createRealtimeSession({ config, ctx: {}, log, userId: null })
		const derived = Object.assign(Object.create(base) as typeof base, { tag: "derived" })
		derived.attach(new WSContextImpl({ bufferedAmount: 0, close: vi.fn(), readyState: 1, send: vi.fn() }))
		derived.message('{"text":"hello"}')
		base.message('"str"')
		derived.error(new Error("socket"))
		await flush()
		derived.close("bye")
		await flush()
		expect([got, closed, log.error.mock.calls.length]).toEqual([[{ text: "hello" }, "str"], ["bye"], 1])
	})
})
