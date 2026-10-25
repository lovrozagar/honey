import { type HTTPClient, REFRESH_AUTH } from "./http.ts"
import {
	RealtimeConnectError,
	type ResumableConnectionOpts,
	type ServerFrame,
	type TransportAdapter,
	type TransportConnection,
	type TransportOpts,
} from "./realtime.ts"
import { Resumable } from "./realtime-connection.ts"
import type { RequestOptions } from "./request.ts"
import { isEventStream } from "./response.ts"
import { createTypedWebSocket } from "./ws.ts"

type Target = { http: HTTPClient; opts: RequestOptions; path: string }

export type RealtimeOptions = Omit<ResumableConnectionOpts, "headers" | "signal" | "transports" | "url">

/** A payload's JSON when it parses, else its text. */
function payloadOf(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

/** A payload's frame: `last_event_id` or `id` the cursor (a transport's id first), `reconnect_token` the token. */
function frameOf(data: unknown, id?: string): Extract<ServerFrame, { t: "msg" }> {
	const fields = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>
	const cursor = [fields.last_event_id, fields.id].find((v) => typeof v === "string" || typeof v === "number")
	const reconnectToken = typeof fields.reconnect_token === "string" ? fields.reconnect_token : undefined
	return { data, id: id ?? (cursor === undefined ? undefined : String(cursor)), reconnectToken, t: "msg" }
}

const ready = (opts: TransportOpts): ServerFrame => ({ reconnectToken: opts.reconnectToken ?? "", t: "ready" })

/** The cursor in the query: the reconnect token, and the last event id when `withId`. */
function cursorOpts(at: Target, opts: TransportOpts, withId: boolean): RequestOptions {
	const search = { ...at.opts.search }
	if (opts.reconnectToken) search.reconnect_token = opts.reconnectToken
	if (withId && opts.lastEventId) search.last_event_id = opts.lastEventId
	return { ...at.opts, search }
}

function connection(close: () => void, send: (data: string) => Promise<void> | void): TransportConnection {
	return { close, onClose: () => {}, onError: () => {}, onFrame: () => {}, send }
}

/** An HTTP transport: `run` until closed; a send POSTs through the client. */
function httpConnection(at: Target, run: (conn: TransportConnection, signal: AbortSignal) => Promise<void>) {
	const abort = new AbortController()
	const post = (data: string) => at.http.request("POST", at.path, { ...at.opts, json: JSON.parse(data) }).then(() => {})
	const conn = connection(() => abort.abort(), post)
	run(conn, abort.signal).catch((err: unknown) => abort.signal.aborted || conn.onError(err))
	return conn
}

/** The platform WebSocket: no credential; a failure before open is a refused upgrade. */
function wsAdapter(at: Target): TransportAdapter {
	return {
		connect(_url, opts) {
			const refused = () => new RealtimeConnectError("the WebSocket upgrade failed", "upgrade_refused")
			if (typeof WebSocket === "undefined") {
				const absent = connection(
					() => {},
					() => {},
				)
				queueMicrotask(() => absent.onError(refused()))
				return absent
			}
			const socket = createTypedWebSocket(at.http.buildWSUrl(at.path, cursorOpts(at, opts, true)))
			const conn = connection(
				() => socket.close(),
				(data) => socket.send(data),
			)
			let open = false
			socket.on("open", () => {
				open = true
				conn.onFrame(ready(opts))
			})
			socket.on("message", (text) => conn.onFrame(frameOf(payloadOf(text))))
			socket.on("error", (err) => conn.onError(open ? err : refused()))
			socket.on("close", (code, reason) => (open ? conn.onClose(reason || `${code}`) : conn.onError(refused())))
			return conn
		},
	}
}

/** An event stream through the client, Last-Event-ID the cursor; any other answer fails it. */
function sseAdapter(at: Target): TransportAdapter {
	return {
		connect: (_url, opts) =>
			httpConnection(at, async (conn, signal) => {
				let stream = false
				const events = at.http.streamOperation({
					method: "GET",
					onOpen: (response) => {
						stream = isEventStream(response)
						if (stream) conn.onFrame(ready(opts))
					},
					opts: { ...cursorOpts(at, opts, false), lastEventId: opts.lastEventId, signal },
					path: at.path,
					refreshes: false,
				})
				for await (const event of events)
					if (stream) conn.onFrame(frameOf(payloadOf(event.data), event.id || undefined))
				if (stream) conn.onClose("end")
				else conn.onError(new RealtimeConnectError("the answer is no event stream", "not_event_stream"))
			}),
	}
}

/** GETs through the client, the cursor in the query; a 204 polls again. */
function pollAdapter(at: Target): TransportAdapter {
	return {
		connect: (_url, opts) =>
			httpConnection(at, async (conn, signal) => {
				const cursor = { ...opts }
				for (let polls = 0; !signal.aborted; polls++) {
					const poll = { ...cursorOpts(at, cursor, true), signal }
					const data = await at.http.requestOperation({
						method: "GET",
						opts: poll,
						path: at.path,
						refreshes: false,
						shouldThrow: true,
					})
					if (polls === 0) conn.onFrame(ready(opts))
					if (data === null || data === undefined || data === "") continue
					const frame = frameOf(data)
					cursor.lastEventId = frame.id ?? cursor.lastEventId
					cursor.reconnectToken = frame.reconnectToken || cursor.reconnectToken
					conn.onFrame(frame)
				}
			}),
	}
}

/** An x-realtime op's chain, as Go's: WebSocket, SSE, long-poll; no JSON keepalive unless set. */
export function realtimeConnection(http: HTTPClient, path: string, input: RequestOptions & RealtimeOptions) {
	const { baseURL, cookies, headers, params, search, signal, ...opts } = input
	const at = { http, opts: { baseURL, cookies, headers, params, search }, path }
	const transports = [wsAdapter(at), sseAdapter(at), pollAdapter(at)]
	return new Resumable({ keepaliveInterval: 0, ...opts, signal, transports, url: path }, () => http[REFRESH_AUTH]())
}
