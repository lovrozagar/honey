export interface RealtimeBus {
	subscribe(connId: string, topic: string): void
	unsubscribe(connId: string, topic: string): void
	unsubscribeAll(connId: string): void
	publish(topic: string, data: unknown): void
	onMessage(connId: string, handler: (data: unknown) => void): void
	removeHandler(connId: string): void
	presence(topic: string): string[]
}

export function createBus(): RealtimeBus {
	/* topic -> set of connIds subscribed to it */
	const topicSubs = new Map<string, Set<string>>()
	/* connId -> set of topics it is subscribed to (reverse lookup for unsubscribeAll) */
	const connTopics = new Map<string, Set<string>>()
	/* connId -> message handler */
	const handlers = new Map<string, (data: unknown) => void>()

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

	function publish(topic: string, data: unknown): void {
		const subs = topicSubs.get(topic)
		if (!subs) return

		for (const connId of subs) {
			const handler = handlers.get(connId)
			if (!handler) continue
			try {
				handler(data)
			} catch {
				/* swallow — error isolation: one broken handler must not block others */
			}
		}
	}

	function onMessage(connId: string, handler: (data: unknown) => void): void {
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

	return { onMessage, presence, publish, removeHandler, subscribe, unsubscribe, unsubscribeAll }
}
