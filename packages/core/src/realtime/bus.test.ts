import { describe, expect, it } from "vitest"
import { createBus, encodeRealtimeFrame, type RealtimeBus } from "./bus.ts"

/** A bus with each connection's received frames recorded. */
function busWith(...conns: string[]) {
	const bus = createBus()
	const got: Record<string, string[]> = {}
	for (const conn of conns) {
		got[conn] = []
		bus.onMessage(conn, (frame) => (got[conn] as string[]).push(frame))
	}
	return { bus, got }
}

describe("createBus: subscriptions", () => {
	// v0: 186ec64301
	// v0: ca2b0483f0
	// v0: c68c15df5b
	// v0: 3d838d3982
	// v0: e46b3b9f2e
	// v0: 0e9367d1ac
	// v0: 2ee9889caa
	it("subscribes any number of connections to any number of topics, idempotently, and tracks membership", () => {
		const bus = createBus()
		bus.subscribe("a", "t1")
		bus.subscribe("a", "t1")
		bus.subscribe("a", "t2")
		bus.subscribe("b", "t1")
		expect([
			bus.presence("t1"),
			bus.presence("t2"),
			bus.topicCount("a"),
			bus.isSubscribed("a", "t2"),
			bus.isSubscribed("b", "t2"),
			bus.isSubscribed("ghost", "t1"),
		]).toEqual([["a", "b"], ["a"], 2, true, false, false])
	})

	// v0: d0cf7f0dbb
	// v0: 5fd3a994df
	// v0: fcd637edb6
	// v0: c22dd7f717
	// v0: ff2803cb7d
	// v0: 12f1d01419
	it("unsubscribe drops one topic, unsubscribeAll every topic; neither throws for what was never joined", () => {
		const bus = createBus()
		for (const topic of ["t1", "t2", "t3"]) bus.subscribe("a", topic)
		bus.subscribe("b", "t1")
		bus.unsubscribe("a", "t1")
		bus.unsubscribe("a", "never")
		bus.unsubscribe("ghost", "t1")
		bus.unsubscribeAll("ghost")
		const afterOne = [bus.presence("t1"), bus.topicCount("a")]
		bus.unsubscribeAll("a")
		expect([afterOne, bus.presence("t2"), bus.presence("t3"), bus.topicCount("a"), bus.presence("t1")]).toEqual([
			[["b"], 2],
			[],
			[],
			0,
			["b"],
		])
	})
})

describe("createBus: presence and scale", () => {
	// v0: 46b30313b8
	// v0: 6537088442
	// v0: 30ef0ebe0c
	// v0: b7813f1774
	it("presence is a snapshot of the connection ids, empty for a topic nobody joined", () => {
		const bus = createBus()
		bus.subscribe("a", "t")
		const snapshot = bus.presence("t")
		bus.subscribe("b", "t")
		expect([snapshot, bus.presence("t"), bus.presence("nobody")]).toEqual([["a"], ["a", "b"], []])
	})

	// v0: 944a7ecb7a
	// v0: 41ab30c4d0
	// v0: 7830de45de
	it("handles many topics per connection, empty-string ids and topics, and a resubscribe after leaving", () => {
		const { bus, got } = busWith("", "a")
		for (let i = 0; i < 1000; i++) bus.subscribe("a", `t${i}`)
		bus.subscribe("", "")
		bus.unsubscribe("a", "t7")
		bus.subscribe("a", "t7")
		bus.publish("", "x")
		bus.publish("t7", "y")
		expect([bus.topicCount("a"), got[""], got.a]).toEqual([1000, ['"x"'], ['"y"']])
	})
})

describe("createBus: delivery", () => {
	// v0: fd9083a08a
	// v0: d66fe3cb53
	// v0: 74819f167f
	// v0: 4ff1738f6b
	// v0: 1c61459313
	it("delivers each publish, in order, to every subscriber and to nobody else", () => {
		const { bus, got } = busWith("a", "b", "outsider")
		bus.subscribe("a", "room")
		bus.subscribe("b", "room")
		bus.publish("room", { n: 1 })
		bus.publish("room", { n: 2 })
		expect(got).toEqual({ a: ['{"n":1}', '{"n":2}'], b: ['{"n":1}', '{"n":2}'], outsider: [] })
	})

	// v0: ed674ddaa9
	// v0: f4b6368ad4
	// v0: 0612bee6d7
	it("keeps topics apart: a connection on two topics hears both, then only the one it kept", () => {
		const { bus, got } = busWith("both", "onlyB")
		bus.subscribe("both", "A")
		bus.subscribe("both", "B")
		bus.subscribe("onlyB", "B")
		bus.publish("A", "a1")
		bus.publish("B", "b1")
		bus.unsubscribe("both", "A")
		bus.publish("A", "a2")
		bus.publish("B", "b2")
		expect(got).toEqual({ both: ['"a1"', '"b1"', '"b2"'], onlyB: ['"b1"', '"b2"'] })
	})

	// v0: ab1694013a
	// v0: e4f7861be9
	// v0: 5748068bf9
	it("a topic nobody joined, or subscribers without a handler, take a publish quietly; any JSON value goes", () => {
		const { bus, got } = busWith("a")
		bus.subscribe("silent", "t")
		bus.subscribe("a", "t")
		bus.publish("nobody", 1)
		for (const value of [1, "s", true, null, [1, 2], { nested: { x: 1 } }]) bus.publish("t", value)
		expect(got.a).toEqual(["1", '"s"', "true", "null", "[1,2]", '{"nested":{"x":1}}'])
	})
})

describe("createBus: frame sinks", () => {
	// v0: 705d16fe14
	// v0: 141ed42d02
	// v0: 5adc44b381
	// v0: 439202b0b5
	// v0: 0ec3f336e6
	// v0: 9dc8524ed9
	// v0: 794a1b1f66
	it("onMessage sets a connection's sink, a second replaces it, removeHandler stops delivery but keeps the subscription", () => {
		const bus = createBus()
		const first: string[] = []
		const second: string[] = []
		bus.subscribe("a", "t")
		bus.onMessage("a", (frame) => first.push(frame))
		bus.publish("t", 1)
		bus.onMessage("a", (frame) => second.push(frame))
		bus.publish("t", 2)
		bus.removeHandler("a")
		bus.removeHandler("never-had-one")
		bus.publish("t", 3)
		expect([first, second, bus.presence("t")]).toEqual([["1"], ["2"], ["a"]])
	})

	// v0: 3785e80946
	it("unsubscribeAll leaves the sink: a later subscribe delivers again", () => {
		const { bus, got } = busWith("a")
		bus.subscribe("a", "t")
		bus.unsubscribeAll("a")
		bus.publish("t", 1)
		bus.subscribe("a", "t")
		bus.publish("t", 2)
		expect(got.a).toEqual(["2"])
	})

	// v0: 7dd213ebcf
	// v0: 4f5c5e914b
	it("a sink that throws, or that unsubscribes itself while delivering, never skips the others", () => {
		const bus = createBus()
		const got: string[] = []
		for (const conn of ["thrower", "leaver", "listener"]) bus.subscribe(conn, "t")
		bus.onMessage("thrower", () => {
			throw new Error("sink failed")
		})
		bus.onMessage("leaver", () => bus.unsubscribeAll("leaver"))
		bus.onMessage("listener", (frame) => got.push(frame))
		bus.publish("t", "x")
		expect([got, bus.presence("t")]).toEqual([['"x"'], ["thrower", "listener"]])
	})
})

describe("createBus: one JSON text per publish", () => {
	// v0: 71baef6a4e
	it("serializes once and hands every subscriber the same frame; publishFrame sends text as it is", () => {
		const { bus, got } = busWith("a", "b")
		bus.subscribe("a", "t")
		bus.subscribe("b", "t")
		bus.publish("t", { n: 1 })
		bus.publishFrame("t", "raw text")
		expect(got).toEqual({ a: ['{"n":1}', "raw text"], b: ['{"n":1}', "raw text"] })
	})

	// v0: a0c2293e9d
	it.each([
		["undefined", undefined],
		["a function", () => {}],
		["a symbol", Symbol("s")],
	])("refuses %s before anything is delivered", (kind, value) => {
		const { bus, got } = busWith("a")
		bus.subscribe("a", "t")
		expect(() => bus.publish("t", value)).toThrow(`realtime payload is not JSON-serializable (got ${typeof value})`)
		expect([got.a, kind]).toEqual([[], kind])
	})

	it("a BigInt or a cycle throws JSON's own TypeError", () => {
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		expect(() => encodeRealtimeFrame(1n)).toThrow(TypeError)
		expect(() => encodeRealtimeFrame(cycle)).toThrow(TypeError)
	})

	it("is the RealtimeBus interface", () => {
		const bus: RealtimeBus = createBus()
		expect(Object.keys(bus).toSorted()).toEqual([
			"isSubscribed",
			"onMessage",
			"presence",
			"publish",
			"publishFrame",
			"removeHandler",
			"subscribe",
			"topicCount",
			"unsubscribe",
			"unsubscribeAll",
		])
	})
})
