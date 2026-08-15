import { describe, expect, it, vi } from "vitest"
import { createBus } from "../../../src/realtime/bus.ts"
import type { RealtimeBus } from "../../../src/realtime/bus.ts"

describe("createBus", () => {
	it("returns an object implementing the RealtimeBus interface", () => {
		const bus = createBus()

		expect(bus.subscribe).toBeTypeOf("function")
		expect(bus.unsubscribe).toBeTypeOf("function")
		expect(bus.unsubscribeAll).toBeTypeOf("function")
		expect(bus.publish).toBeTypeOf("function")
		expect(bus.onMessage).toBeTypeOf("function")
		expect(bus.removeHandler).toBeTypeOf("function")
		expect(bus.presence).toBeTypeOf("function")
	})
})

describe("subscribe / unsubscribe", () => {
	it("subscribes a connection to a topic", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "chat")

		expect(bus.presence("chat")).toEqual(["conn-1"])
	})

	it("subscribes multiple connections to the same topic", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-2", "chat")
		bus.subscribe("conn-3", "chat")

		const members = bus.presence("chat")
		expect(members).toHaveLength(3)
		expect(members).toContain("conn-1")
		expect(members).toContain("conn-2")
		expect(members).toContain("conn-3")
	})

	it("subscribes one connection to multiple topics", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-1", "notifications")
		bus.subscribe("conn-1", "presence")

		expect(bus.presence("chat")).toEqual(["conn-1"])
		expect(bus.presence("notifications")).toEqual(["conn-1"])
		expect(bus.presence("presence")).toEqual(["conn-1"])
	})

	it("unsubscribes a connection from a topic", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-2", "chat")
		bus.unsubscribe("conn-1", "chat")

		expect(bus.presence("chat")).toEqual(["conn-2"])
	})

	it("unsubscribeAll removes connection from all topics", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-1", "notifications")
		bus.subscribe("conn-1", "presence")
		bus.subscribe("conn-2", "chat")

		bus.unsubscribeAll("conn-1")

		expect(bus.presence("chat")).toEqual(["conn-2"])
		expect(bus.presence("notifications")).toEqual([])
		expect(bus.presence("presence")).toEqual([])
	})

	it("unsubscribe from a topic not subscribed to does not throw", () => {
		const bus = createBus()

		expect(() => bus.unsubscribe("conn-1", "nonexistent")).not.toThrow()
	})

	it("unsubscribeAll on a connection with no subscriptions does not throw", () => {
		const bus = createBus()

		expect(() => bus.unsubscribeAll("conn-unknown")).not.toThrow()
	})
})

describe("publish / fanout", () => {
	it("publishes to topic and all subscribers receive the message", () => {
		const bus = createBus()
		const handler1 = vi.fn<(data: unknown) => void>()
		const handler2 = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-2", "chat")
		bus.onMessage("conn-1", handler1)
		bus.onMessage("conn-2", handler2)

		bus.publish("chat", { text: "hello" })

		expect(handler1).toHaveBeenCalledOnce()
		expect(handler1).toHaveBeenCalledWith({ text: "hello" })
		expect(handler2).toHaveBeenCalledOnce()
		expect(handler2).toHaveBeenCalledWith({ text: "hello" })
	})

	it("publishes to topic with no subscribers without error", () => {
		const bus = createBus()

		expect(() => bus.publish("empty-topic", { data: 1 })).not.toThrow()
	})

	it("non-subscribers do not receive published messages", () => {
		const bus = createBus()
		const subscriberHandler = vi.fn<(data: unknown) => void>()
		const nonSubscriberHandler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.onMessage("conn-1", subscriberHandler)
		bus.onMessage("conn-2", nonSubscriberHandler)

		bus.publish("chat", "msg")

		expect(subscriberHandler).toHaveBeenCalledOnce()
		expect(nonSubscriberHandler).not.toHaveBeenCalled()
	})

	it("delivers messages with the correct data payload", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "events")
		bus.onMessage("conn-1", handler)

		const payload = { nested: { deep: true }, type: "user_joined", userId: 42 }
		bus.publish("events", payload)

		expect(handler).toHaveBeenCalledWith(payload)
	})

	it("multiple publishes deliver in order to each subscriber", () => {
		const bus = createBus()
		const received: unknown[] = []
		const handler = vi.fn<(data: unknown) => void>((data: unknown) => received.push(data))

		bus.subscribe("conn-1", "ordered")
		bus.onMessage("conn-1", handler)

		bus.publish("ordered", "first")
		bus.publish("ordered", "second")
		bus.publish("ordered", "third")

		expect(handler).toHaveBeenCalledTimes(3)
		expect(received).toEqual(["first", "second", "third"])
	})

	it("concurrent subscribers to one topic all get the message", () => {
		const bus = createBus()
		const handlers = Array.from({ length: 50 }, () => vi.fn<(data: unknown) => void>())

		for (let i = 0; i < 50; i++) {
			const connId = `conn-${i}`
			bus.subscribe(connId, "broadcast")
			bus.onMessage(connId, handlers[i])
		}

		bus.publish("broadcast", "mass-message")

		for (const handler of handlers) {
			expect(handler).toHaveBeenCalledOnce()
			expect(handler).toHaveBeenCalledWith("mass-message")
		}
	})
})

describe("topic isolation", () => {
	it("messages published to topic A are not received by subscribers of topic B", () => {
		const bus = createBus()
		const handlerA = vi.fn<(data: unknown) => void>()
		const handlerB = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "topic-a")
		bus.subscribe("conn-2", "topic-b")
		bus.onMessage("conn-1", handlerA)
		bus.onMessage("conn-2", handlerB)

		bus.publish("topic-a", "for-a-only")

		expect(handlerA).toHaveBeenCalledWith("for-a-only")
		expect(handlerB).not.toHaveBeenCalled()
	})

	it("connection subscribed to A and B receives messages from both", () => {
		const bus = createBus()
		const received: Array<{ data: unknown; topic: string }> = []
		const handler = vi.fn<(data: unknown) => void>((data: unknown) => received.push({ data, topic: "unknown" }))

		bus.subscribe("conn-1", "topic-a")
		bus.subscribe("conn-1", "topic-b")
		bus.onMessage("conn-1", handler)

		bus.publish("topic-a", "msg-a")
		bus.publish("topic-b", "msg-b")

		expect(handler).toHaveBeenCalledTimes(2)
		expect(handler).toHaveBeenCalledWith("msg-a")
		expect(handler).toHaveBeenCalledWith("msg-b")
	})

	it("after unsubscribing from A, connection still receives B but not A", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "topic-a")
		bus.subscribe("conn-1", "topic-b")
		bus.onMessage("conn-1", handler)

		bus.unsubscribe("conn-1", "topic-a")

		bus.publish("topic-a", "should-not-receive")
		bus.publish("topic-b", "should-receive")

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith("should-receive")
	})
})

describe("message handler", () => {
	it("onMessage registers a handler for a connection", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.onMessage("conn-1", handler)
		bus.subscribe("conn-1", "test")
		bus.publish("test", "data")

		expect(handler).toHaveBeenCalledOnce()
	})

	it("published messages to subscribed topics invoke the handler", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "events")
		bus.onMessage("conn-1", handler)

		bus.publish("events", 123)
		bus.publish("events", "text")
		bus.publish("events", null)

		expect(handler).toHaveBeenCalledTimes(3)
		expect(handler).toHaveBeenNthCalledWith(1, 123)
		expect(handler).toHaveBeenNthCalledWith(2, "text")
		expect(handler).toHaveBeenNthCalledWith(3, null)
	})

	it("removeHandler stops delivery to that connection", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.onMessage("conn-1", handler)

		bus.publish("chat", "before-remove")
		bus.removeHandler("conn-1")
		bus.publish("chat", "after-remove")

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith("before-remove")
	})

	it("replacing a handler via onMessage replaces the previous one", () => {
		const bus = createBus()
		const firstHandler = vi.fn<(data: unknown) => void>()
		const secondHandler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.onMessage("conn-1", firstHandler)

		bus.publish("chat", "to-first")

		bus.onMessage("conn-1", secondHandler)
		bus.publish("chat", "to-second")

		expect(firstHandler).toHaveBeenCalledOnce()
		expect(firstHandler).toHaveBeenCalledWith("to-first")
		expect(secondHandler).toHaveBeenCalledOnce()
		expect(secondHandler).toHaveBeenCalledWith("to-second")
	})

	it("removeHandler on a connection with no handler does not throw", () => {
		const bus = createBus()

		expect(() => bus.removeHandler("conn-unknown")).not.toThrow()
	})
})

describe("presence", () => {
	it("returns list of connIds subscribed to a topic", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "room")
		bus.subscribe("conn-2", "room")
		bus.subscribe("conn-3", "room")

		const members = bus.presence("room")
		expect(members).toHaveLength(3)
		expect(members).toContain("conn-1")
		expect(members).toContain("conn-2")
		expect(members).toContain("conn-3")
	})

	it("returns empty array for empty or nonexistent topic", () => {
		const bus = createBus()

		expect(bus.presence("nonexistent")).toEqual([])
	})

	it("after unsubscribe, connId is removed from presence", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "room")
		bus.subscribe("conn-2", "room")

		bus.unsubscribe("conn-1", "room")

		expect(bus.presence("room")).toEqual(["conn-2"])
	})

	it("after unsubscribeAll, connId is removed from all topics presence", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "room-a")
		bus.subscribe("conn-1", "room-b")
		bus.subscribe("conn-2", "room-a")

		bus.unsubscribeAll("conn-1")

		expect(bus.presence("room-a")).toEqual(["conn-2"])
		expect(bus.presence("room-b")).toEqual([])
	})

	it("presence returns a snapshot, not a live reference", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "room")

		const snapshot = bus.presence("room")
		bus.subscribe("conn-2", "room")

		/* snapshot should not reflect the new subscription */
		expect(snapshot).toEqual(["conn-1"])
		expect(bus.presence("room")).toHaveLength(2)
	})
})

describe("edge cases", () => {
	it("subscribing same connection to same topic twice is idempotent", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-1", "chat")
		bus.onMessage("conn-1", handler)

		bus.publish("chat", "hello")

		/* handler should be called exactly once, not twice */
		expect(handler).toHaveBeenCalledOnce()
		expect(bus.presence("chat")).toEqual(["conn-1"])
	})

	it("publish with no handlers registered for any subscriber does not crash", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-2", "chat")

		/* no onMessage registered for either connection */
		expect(() => bus.publish("chat", "data")).not.toThrow()
	})

	it("handler that throws does not prevent delivery to other subscribers", () => {
		const bus = createBus()
		const throwingHandler = vi.fn<(data: unknown) => void>(() => {
			throw new Error("handler exploded")
		})
		const safeHandler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.subscribe("conn-2", "chat")
		bus.onMessage("conn-1", throwingHandler)
		bus.onMessage("conn-2", safeHandler)

		bus.publish("chat", "test")

		expect(throwingHandler).toHaveBeenCalledOnce()
		expect(safeHandler).toHaveBeenCalledOnce()
		expect(safeHandler).toHaveBeenCalledWith("test")
	})

	it("publish delivers data types beyond plain objects", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "varied")
		bus.onMessage("conn-1", handler)

		bus.publish("varied", 42)
		bus.publish("varied", "string-data")
		bus.publish("varied", null)
		bus.publish("varied", undefined)
		bus.publish("varied", [1, 2, 3])
		bus.publish("varied", true)

		expect(handler).toHaveBeenCalledTimes(6)
		expect(handler).toHaveBeenNthCalledWith(1, 42)
		expect(handler).toHaveBeenNthCalledWith(2, "string-data")
		expect(handler).toHaveBeenNthCalledWith(3, null)
		expect(handler).toHaveBeenNthCalledWith(4, undefined)
		expect(handler).toHaveBeenNthCalledWith(5, [1, 2, 3])
		expect(handler).toHaveBeenNthCalledWith(6, true)
	})

	it("unsubscribe then resubscribe restores delivery", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.onMessage("conn-1", handler)
		bus.unsubscribe("conn-1", "chat")

		bus.publish("chat", "while-unsubscribed")
		expect(handler).not.toHaveBeenCalled()

		bus.subscribe("conn-1", "chat")
		bus.publish("chat", "after-resubscribe")

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith("after-resubscribe")
	})

	it("removeHandler does not affect subscription — presence still shows connId", () => {
		const bus = createBus()

		bus.subscribe("conn-1", "chat")
		bus.onMessage("conn-1", vi.fn<(data: unknown) => void>())
		bus.removeHandler("conn-1")

		expect(bus.presence("chat")).toEqual(["conn-1"])
	})

	it("unsubscribeAll does not remove the message handler", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("conn-1", "chat")
		bus.onMessage("conn-1", handler)
		bus.unsubscribeAll("conn-1")

		/* handler is still registered, so resubscribing should resume delivery */
		bus.subscribe("conn-1", "chat")
		bus.publish("chat", "after-unsub-all")

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith("after-unsub-all")
	})

	it("large number of topics per connection", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()
		const topicCount = 1000

		bus.onMessage("conn-1", handler)
		for (let i = 0; i < topicCount; i++) {
			bus.subscribe("conn-1", `topic-${i}`)
		}

		bus.publish("topic-500", "needle")

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith("needle")
	})

	it("empty string connId and topic are valid", () => {
		const bus = createBus()
		const handler = vi.fn<(data: unknown) => void>()

		bus.subscribe("", "")
		bus.onMessage("", handler)
		bus.publish("", "empty-strings")

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith("empty-strings")
		expect(bus.presence("")).toEqual([""])
	})
})

describe("type contracts", () => {
	it("createBus returns RealtimeBus", () => {
		const bus = createBus()
		const _typed: RealtimeBus = bus
		expect(_typed).toBe(bus)
	})

	it("presence returns string array", () => {
		const bus = createBus()
		const result = bus.presence("any")
		const _typed: string[] = result
		expect(Array.isArray(_typed)).toBe(true)
	})

	it("onMessage handler receives unknown data", () => {
		const bus = createBus()
		bus.subscribe("conn-1", "t")

		bus.onMessage("conn-1", (data) => {
			const _typed: unknown = data
			expect(_typed).toBeDefined()
		})

		bus.publish("t", { key: "value" })
	})
})
