import type { ServerFrame } from "./protocol.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface LongPollBus {
	subscribe(token: string, cb: (frame: ServerFrame) => void): () => void
	deliverMessage(token: string, payload: unknown): boolean
}

interface LongPollBuffer {
	replay(token: string, lastId: number): Array<{ id: number; data: unknown }> | null
}

export type LongPollHandlerOpts = {
	bus: LongPollBus
	buffer: LongPollBuffer
	defaultWait?: number
	maxWait?: number
}

const DEFAULT_WAIT_S = 25
const MAX_WAIT_S = 30

const JSON_HEADERS = { "Content-Type": "application/json" }

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { headers: JSON_HEADERS, status })
}

function parseWait(raw: string | null, defaultWait: number, maxWait: number): number {
	if (raw === null) return defaultWait

	const parsed = Number(raw)
	if (!Number.isFinite(parsed)) return defaultWait
	if (parsed < 0) return 0
	return Math.min(parsed, maxWait)
}

export function createLongPollHandler(opts: LongPollHandlerOpts): {
	poll(req: Request): Promise<Response>
	send(req: Request): Promise<Response>
} {
	const defaultWait = opts.defaultWait ?? DEFAULT_WAIT_S
	const maxWait = opts.maxWait ?? MAX_WAIT_S

	function poll(req: Request): Promise<Response> {
		const url = new URL(req.url)
		const token = url.searchParams.get("reconnectToken")

		if (!token) {
			return Promise.resolve(jsonResponse({ error: "missing reconnectToken" }, 400))
		}

		const lastId = Number(url.searchParams.get("lastId") ?? "0") || 0
		const wait = parseWait(url.searchParams.get("wait"), defaultWait, maxWait)

		const entries = opts.buffer.replay(token, lastId)

		if (entries === null) {
			return Promise.resolve(jsonResponse([{ reason: "server_restart", t: "bye" }], 404))
		}

		if (entries.length > 0) {
			const frames: ServerFrame[] = entries.map((e) => ({
				data: e.data,
				id: e.id,
				t: "msg" as const,
			}))
			return Promise.resolve(jsonResponse(frames))
		}

		if (wait === 0) {
			return Promise.resolve(jsonResponse([]))
		}

		return new Promise<Response>((resolve) => {
			let settled = false

			function settle(body: ServerFrame[]): void {
				if (settled) return
				settled = true
				cleanup()
				resolve(jsonResponse(body))
			}

			const unsubscribe = opts.bus.subscribe(token, (frame) => {
				settle([frame])
			})

			const timer = setTimeout(() => {
				settle([])
			}, wait * 1000)

			function cleanup(): void {
				unsubscribe()
				clearTimeout(timer)
				req.signal.removeEventListener("abort", onAbort)
			}

			function onAbort(): void {
				settle([])
			}

			if (req.signal.aborted) {
				settle([])
				return
			}
			req.signal.addEventListener("abort", onAbort)
		})
	}

	async function send(req: Request): Promise<Response> {
		let parsed: unknown
		try {
			const text = await req.text()
			if (!text) return jsonResponse({ error: "empty body" }, 400)
			parsed = JSON.parse(text)
		} catch {
			return jsonResponse({ error: "invalid JSON" }, 400)
		}

		if (!isRecord(parsed)) {
			return jsonResponse({ error: "invalid body" }, 400)
		}

		const body = parsed

		const token = body.reconnectToken
		if (typeof token !== "string") {
			return jsonResponse({ error: "missing reconnectToken" }, 400)
		}

		if (!("data" in body)) {
			return jsonResponse({ error: "missing data" }, 400)
		}

		const delivered = opts.bus.deliverMessage(token, body.data)
		if (!delivered) {
			return jsonResponse({ error: "unknown token" }, 404)
		}

		return jsonResponse({ ok: true })
	}

	return { poll, send }
}
