import { describe, expect, it } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import { ABORT_CONTEXT, HoneyContext, NO_ROUTE, type RequestState, TAPS } from "./context.ts"

function makeCtx(state?: Partial<RequestState<{ DB: string }>>) {
	return new HoneyContext(
		{ env: { DB: "test" }, executionCtx: undefined, logger: SILENT, path: "/test", req: makeReq(), ...state },
		NO_ROUTE,
		{},
	)
}

function makeReq(url = "http://localhost/test", headers?: Record<string, string>): Request {
	return new Request(url, { headers })
}

/* Anyrow's saas derived `Object.assign(Object.create(ctx), { shardDb })`: on 1.0.0-rc.4 every lazy getter threw
   "Cannot read private member", since a private field lives only on the instance the constructor built. */
function derive(ctx: HoneyContext<{ DB: string }>) {
	return Object.assign(Object.create(ctx) as typeof ctx, { shardDb: "s1" })
}

describe("HoneyContext > a context derived with Object.create", () => {
	it("reads every lazy view the base has, as the base's own", () => {
		const base = makeCtx({
			req: makeReq("http://localhost/test?a=1&a=2", { cookie: "sid=abc", "x-k": "v" }),
		})
		const derived = derive(base)
		expect(derived.log).toBe(base.log)
		expect(derived.cookies).toEqual({ sid: "abc" })
		expect(derived.headers).toBe(base.headers)
		expect(derived.search).toEqual({ a: "1" })
		expect(derived.searchAll).toBe(base.searchAll)
		expect(derived.signal).toBe(base.signal)
		expect((derived as { shardDb?: string }).shardDb).toBe("s1")
	})

	it("reads every getter on the class without throwing, so a new one cannot bring the fault back", () => {
		const derived = derive(makeCtx())
		const getters = Reflect.ownKeys(HoneyContext.prototype).filter(
			(key) => Object.getOwnPropertyDescriptor(HoneyContext.prototype, key)?.get !== undefined,
		)
		expect(getters.length).toBeGreaterThanOrEqual(8)
		for (const key of getters) expect(() => Reflect.get(derived, key)).not.toThrow()
	})

	it("logs as the request, whichever context asks first, even one that shadows path", () => {
		const bound: Record<string, unknown>[] = []
		const logger = { ...SILENT, child: (bindings: Record<string, unknown>) => (bound.push(bindings), SILENT) }
		const base = makeCtx({ logger })
		const derived = Object.assign(Object.create(base) as typeof base, { path: "/shadowed" })
		void derived.log
		void base.log
		expect(bound).toHaveLength(1)
		expect(bound[0]).toMatchObject({ path: "/test" })
	})

	it("shares the base's state: a view built through it, its taps and its abort", () => {
		const base = makeCtx()
		const derived = derive(base)
		const signal = derived.signal
		expect(base.signal).toBe(signal)
		derived.tap("billing.paid", { id: 1 })
		expect(base[TAPS]).toEqual([{ key: "billing.paid", payload: { id: 1 } }])
		derived[ABORT_CONTEXT]("timeout")
		expect(base.signal.aborted).toBe(true)
		expect(base.signal.reason).toBe("timeout")
	})
})
