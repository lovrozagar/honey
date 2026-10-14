/**
 * The in-process topic bus behind `realtime()`. Topics are opaque keys here; the realtime server
 * namespaces them per route before they reach the bus. A publish serializes its payload once and
 * hands every subscriber the same JSON text frame. Pass one bus to several routes to share topics.
 */
export type RealtimeBus = {
	subscribe(connId: string, topic: string): void
	unsubscribe(connId: string, topic: string): void
	unsubscribeAll(connId: string): void
	/** Serialize `data` once and deliver the frame to every subscriber of `topic`; throws when `data` is not JSON. */
	publish(topic: string, data: unknown): void
	/** Deliver an already-serialized frame to every subscriber of `topic`. */
	publishFrame(topic: string, frame: string): void
	onMessage(connId: string, sink: (frame: string) => void): void
	removeHandler(connId: string): void
	/** The connections on `topic`, as a snapshot. */
	presence(topic: string): string[]
	/** How many topics `connId` is on. */
	topicCount(connId: string): number
	isSubscribed(connId: string, topic: string): boolean
}

/** The wire format: every frame, both ways, is one JSON text. A value JSON cannot represent is a TypeError. */
export function encodeRealtimeFrame(data: unknown): string {
	const frame = JSON.stringify(data) as string | undefined
	if (frame === undefined) throw new TypeError(`realtime payload is not JSON-serializable (got ${typeof data})`)
	return frame
}

/** Remove `member` from the set under `key`, and the set once it is empty. */
function removeFrom(map: Map<string, Set<string>>, key: string, member: string): void {
	const set = map.get(key)
	if (set === undefined) return
	set.delete(member)
	if (set.size === 0) map.delete(key)
}

function addTo(map: Map<string, Set<string>>, key: string, member: string): void {
	let set = map.get(key)
	if (set === undefined) {
		set = new Set()
		map.set(key, set)
	}
	set.add(member)
}

export function createBus(): RealtimeBus {
	/* topic → connections on it, and connection → its topics (for unsubscribeAll) */
	const topicSubs = new Map<string, Set<string>>()
	const connTopics = new Map<string, Set<string>>()
	const sinks = new Map<string, (frame: string) => void>()

	const publishFrame = (topic: string, frame: string): void => {
		const subs = topicSubs.get(topic)
		if (subs === undefined) return
		/* a snapshot: a sink that closes its connection unsubscribes while this iterates */
		const snapshot = [...subs]
		for (const connId of snapshot) {
			try {
				sinks.get(connId)?.(frame)
			} catch {
				/* sinks contain their own errors; one must never block the others */
			}
		}
	}

	return {
		isSubscribed: (connId, topic) => connTopics.get(connId)?.has(topic) ?? false,
		onMessage: (connId, sink) => void sinks.set(connId, sink),
		presence: (topic) => [...(topicSubs.get(topic) ?? [])],
		publish: (topic, data) => publishFrame(topic, encodeRealtimeFrame(data)),
		publishFrame,
		removeHandler: (connId) => void sinks.delete(connId),
		subscribe(connId, topic) {
			addTo(topicSubs, topic, connId)
			addTo(connTopics, connId, topic)
		},
		topicCount: (connId) => connTopics.get(connId)?.size ?? 0,
		unsubscribe(connId, topic) {
			removeFrom(topicSubs, topic, connId)
			removeFrom(connTopics, connId, topic)
		},
		unsubscribeAll(connId) {
			for (const topic of connTopics.get(connId) ?? []) removeFrom(topicSubs, topic, connId)
			connTopics.delete(connId)
		},
	}
}
