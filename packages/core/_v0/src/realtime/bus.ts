/**
 * In-process topic bus behind `app.realtime()`. Topics are opaque keys here; the realtime server
 * namespaces them per route before they reach the bus. Each publish serializes its payload once and
 * hands every subscriber the same JSON text frame.
 */
export interface RealtimeBus {
	subscribe(connId: string, topic: string): void
	unsubscribe(connId: string, topic: string): void
	unsubscribeAll(connId: string): void
	/** Serialize `data` once and deliver the frame to every subscriber of `topic`. Throws when `data` is not JSON-serializable. */
	publish(topic: string, data: unknown): void
	/** Deliver an already-serialized frame to every subscriber of `topic`. */
	publishFrame(topic: string, frame: string): void
	onMessage(connId: string, handler: (frame: string) => void): void
	removeHandler(connId: string): void
	presence(topic: string): string[]
	/** Number of topics `connId` is subscribed to. */
	topicCount(connId: string): number
	isSubscribed(connId: string, topic: string): boolean
}

/**
 * The wire format of the shipped bus: every frame, in both directions, is one JSON text.
 * Throws a `TypeError` for values JSON cannot represent (`undefined`, functions, symbols, BigInt, cycles).
 */
export function encodeRealtimeFrame(data: unknown): string {
	const frame = JSON.stringify(data) as string | undefined
	if (frame === undefined) {
		throw new TypeError(`realtime payload is not JSON-serializable (got ${typeof data})`)
	}
	return frame
}

export function createBus(): RealtimeBus {
	/* topic -> set of connIds subscribed to it */
	const topicSubs = new Map<string, Set<string>>()
	/* connId -> set of topics it is subscribed to (reverse lookup for unsubscribeAll) */
	const connTopics = new Map<string, Set<string>>()
	/* connId -> frame sink */
	const handlers = new Map<string, (frame: string) => void>()

	function subscribe(connId: string, topic: string): void {
		let subs = topicSubs.get(topic)
		if (!subs) {
			subs = new Set()
			topicSubs.set(topic, subs)
		}
		subs.add(connId)

		let topics = connTopics.get(connId)
		if (!topics) {
			topics = new Set()
			connTopics.set(connId, topics)
		}
		topics.add(topic)
	}

	function unsubscribe(connId: string, topic: string): void {
		const subs = topicSubs.get(topic)
		if (subs) {
			subs.delete(connId)
			if (subs.size === 0) topicSubs.delete(topic)
		}

		const topics = connTopics.get(connId)
		if (topics) {
			topics.delete(topic)
			if (topics.size === 0) connTopics.delete(connId)
		}
	}

	function unsubscribeAll(connId: string): void {
		const topics = connTopics.get(connId)
		if (!topics) return

		for (const topic of topics) {
			const subs = topicSubs.get(topic)
			if (subs) {
				subs.delete(connId)
				if (subs.size === 0) topicSubs.delete(topic)
			}
		}
		connTopics.delete(connId)
	}

	function publishFrame(topic: string, frame: string): void {
		const subs = topicSubs.get(topic)
		if (!subs) return

		/* snapshot: a sink that closes its connection unsubscribes while we iterate */
		for (const connId of Array.from(subs)) {
			const handler = handlers.get(connId)
			if (!handler) continue
			try {
				handler(frame)
			} catch {
				/* sinks are internal and contain their own errors; one must never block the others */
			}
		}
	}

	function publish(topic: string, data: unknown): void {
		publishFrame(topic, encodeRealtimeFrame(data))
	}

	function onMessage(connId: string, handler: (frame: string) => void): void {
		handlers.set(connId, handler)
	}

	function removeHandler(connId: string): void {
		handlers.delete(connId)
	}

	function presence(topic: string): string[] {
		const subs = topicSubs.get(topic)
		if (!subs) return []
		return [...subs]
	}

	function topicCount(connId: string): number {
		return connTopics.get(connId)?.size ?? 0
	}

	function isSubscribed(connId: string, topic: string): boolean {
		return connTopics.get(connId)?.has(topic) ?? false
	}

	return {
		isSubscribed,
		onMessage,
		presence,
		publish,
		publishFrame,
		removeHandler,
		subscribe,
		topicCount,
		unsubscribe,
		unsubscribeAll,
	}
}
