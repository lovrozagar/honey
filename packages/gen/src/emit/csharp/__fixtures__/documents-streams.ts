/**
 * C#'s phase-d realtime document (contract 50 §4.1): the shared `realtime` document (bit 13's, in
 * shared/__fixtures__/documents-streams.ts, byte-identical for Rust and Python) and one path only the C# legs
 * drive: `clash.feed`, whose declared queries `max_reconnect_attempts` and `reconnect_delay` share their
 * identifiers with the realtime fields, so the emitter claims them `maxReconnectAttempts2` and `reconnectDelay2`
 * and the fold runs executed (Python's clash ran on a Python-only path the same way).
 */
import { realtime } from "../../shared/__fixtures__/documents-streams.ts"

type Json = Readonly<Record<string, unknown>>

/** A query parameter `name` of JSON type `type`. */
const query = (name: string, type: string, required = false): Json => ({
	in: "query",
	name,
	required,
	schema: { type },
})

/** `GET /realtime-clash/feed`: a typed `Payload` feed, a required `channel` and two queries named like stream fields. */
function clashPath(): Json {
	return {
		"/realtime-clash/feed": {
			get: {
				operationId: "clash.feed",
				parameters: [
					query("channel", "string", true),
					query("max_reconnect_attempts", "integer"),
					query("reconnect_delay", "integer"),
				],
				responses: {
					200: {
						content: { "text/event-stream": { schema: { $ref: "#/components/schemas/Payload" } } },
						description: "ok",
					},
				},
				"x-realtime": true,
				"x-websocket": true,
			},
		},
	}
}

/** The shared `realtime` document with `clash.feed` beside its own paths. */
export function csharpRealtime(): Json {
	const shared = realtime()
	return { ...shared, paths: { ...(shared.paths as Json), ...clashPath() } }
}
