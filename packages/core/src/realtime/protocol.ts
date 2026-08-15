export type ServerFrame =
	| { data: unknown; id: number; t: "msg" }
	| { t: "pong" }
	| { reason: string; t: "bye" }
	| { reconnectToken: string; t: "ready" }

export type ClientFrame =
	| { t: "ping" }
	| { data: unknown; t: "msg" }
	| { lastId: number; reconnectToken: string; t: "resume" }

export type ProtocolBuffer = {
	push(frame: { data: unknown; id: number; t: "msg" }): void
	getAfter(lastId: number): Array<{ data: unknown; id: number; t: "msg" }>
}

export type Protocol = {
	handleClientFrame(raw: string): ServerFrame | null
	handleConnect(): ServerFrame
	handleResume(lastId: number, reconnectToken: string): ServerFrame[]
	readonly lastId: number
	readonly reconnectToken: string
	sendBye(reason: string): ServerFrame
	sendMessage(data: unknown): ServerFrame
}

export function encodeServerFrame(frame: ServerFrame): string {
	return JSON.stringify(frame)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function decodeClientFrame(raw: string): ClientFrame | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}

	if (!isRecord(parsed)) {
		return null
	}

	const obj = parsed

	if (obj.t === "ping") {
		return { t: "ping" }
	}

	if (obj.t === "msg") {
		if (!("data" in obj)) return null
		return { data: obj.data, t: "msg" }
	}

	if (obj.t === "resume") {
		if (
			typeof obj.lastId !== "number" ||
			obj.lastId < 0 ||
			!Number.isInteger(obj.lastId) ||
			typeof obj.reconnectToken !== "string"
		) {
			return null
		}
		return { lastId: obj.lastId, reconnectToken: obj.reconnectToken, t: "resume" }
	}

	return null
}

export function createProtocol(opts?: { reconnectBuffer?: ProtocolBuffer }): Protocol {
	const token = crypto.randomUUID()
	const buffer = opts?.reconnectBuffer ?? null
	let idCounter = 0

	function handleConnect(): ServerFrame {
		return { reconnectToken: token, t: "ready" }
	}

	function handleResume(lastId: number, reconnectToken: string): ServerFrame[] {
		if (reconnectToken !== token || !buffer) {
			return [{ reason: "server_restart", t: "bye" }]
		}

		const missed = buffer.getAfter(lastId)
		return [...missed, { reconnectToken: token, t: "ready" }]
	}

	function handleClientFrame(raw: string): ServerFrame | null {
		const frame = decodeClientFrame(raw)
		if (!frame) return null

		if (frame.t === "ping") {
			return { t: "pong" }
		}

		return null
	}

	function sendMessage(data: unknown): ServerFrame {
		idCounter++
		const frame: ServerFrame = { data, id: idCounter, t: "msg" }
		if (buffer) {
			buffer.push({ data, id: idCounter, t: "msg" })
		}
		return frame
	}

	function sendBye(reason: string): ServerFrame {
		return { reason, t: "bye" }
	}

	return {
		handleClientFrame,
		handleConnect,
		handleResume,
		get lastId() {
			return idCounter
		},
		get reconnectToken() {
			return token
		},
		sendBye,
		sendMessage,
	}
}
