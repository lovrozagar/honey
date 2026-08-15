const DEFAULT_SIZE = 100
const DEFAULT_TTL = 300_000

type BufferEntry = { id: number; data: unknown }

type ConnectionBuffer = {
	entries: BufferEntry[]
	head: number
	count: number
	nextId: number
	capacity: number
	ttlTimer: ReturnType<typeof setTimeout> | null
}

export class ReconnectBuffer {
	private readonly size: number
	private readonly ttl: number
	private readonly connections = new Map<string, ConnectionBuffer>()

	constructor(opts?: { size?: number; ttl?: number }) {
		const size = opts?.size ?? DEFAULT_SIZE
		if (size <= 0) {
			throw new Error("ReconnectBuffer size must be greater than 0")
		}
		this.size = size
		this.ttl = opts?.ttl ?? DEFAULT_TTL
	}

	create(existingToken?: string): string {
		const token = existingToken ?? crypto.randomUUID()
		this.connections.set(token, {
			capacity: this.size,
			count: 0,
			entries: Array.from<BufferEntry>({ length: this.size }),
			head: 0,
			nextId: 1,
			ttlTimer: null,
		})
		return token
	}

	push(token: string, data: unknown): number {
		const conn = this.connections.get(token)
		if (!conn) {
			throw new Error(`Unknown reconnect token: ${token}`)
		}

		/* Cancel any pending TTL timer on reconnect */
		if (conn.ttlTimer !== null) {
			clearTimeout(conn.ttlTimer)
			conn.ttlTimer = null
		}

		const id = conn.nextId++
		const index = (conn.head + conn.count) % conn.capacity

		if (conn.count < conn.capacity) {
			conn.entries[index] = { data, id }
			conn.count++
		} else {
			/* Ring is full — overwrite oldest at head, advance head */
			conn.entries[conn.head] = { data, id }
			conn.head = (conn.head + 1) % conn.capacity
		}

		return id
	}

	replay(token: string, lastId: number): Array<{ id: number; data: unknown }> | null {
		const conn = this.connections.get(token)
		if (!conn) return null

		const result: Array<{ id: number; data: unknown }> = []
		for (let i = 0; i < conn.count; i++) {
			const entry = conn.entries[(conn.head + i) % conn.capacity]
			if (entry.id > lastId) {
				result.push(entry)
			}
		}
		return result
	}

	disconnect(token: string): void {
		const conn = this.connections.get(token)
		if (!conn) return

		conn.ttlTimer = setTimeout(() => {
			this.connections.delete(token)
		}, this.ttl)
	}

	destroy(token: string): void {
		const conn = this.connections.get(token)
		if (!conn) return

		if (conn.ttlTimer !== null) {
			clearTimeout(conn.ttlTimer)
		}
		this.connections.delete(token)
	}
}
