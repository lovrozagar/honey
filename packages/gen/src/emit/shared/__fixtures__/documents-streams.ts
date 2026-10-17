/**
 * The phase-d fixture documents (contract 20 §4.3), each under bearer auth: `sse`, the event streams (a typed
 * one with a query, a header and a typed response header; a string one; a POST with a JSON body; one with a
 * path param); `ws`, the WebSockets (one with a path param, a query and a declared `reconnect_token` the
 * stream field folds over; one with nothing); and `realtime`, the resumable connections (a typed one with a
 * required query and a header; one declaring every stream field's own name, its events untyped). A WebSocket-only
 * crate (`ws`) ships no realtime files, so it is built on its own.
 */

type Json = Readonly<Record<string, unknown>>

const STRING = { type: "string" }
const INTEGER = { type: "integer" }
const param = (where: string, name: string, schema: Json = STRING, required = false): Json => ({
	in: where,
	name,
	required,
	schema,
})
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const events = (schema: Json, extra: Json = {}): Json => ({
	200: { content: { "text/event-stream": { schema } }, description: "ok", ...extra },
})
const UPGRADE = { 101: { description: "upgrade" } }
const BEARER = { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } }

/** `paths` under bearer auth, with `schemas` beside the security scheme. */
const document = (title: string, paths: Json, schemas: Json = {}): Json => ({
	components: { ...BEARER, schemas },
	info: { title, version: "1" },
	openapi: "3.1.0",
	paths,
	security: [{ bearer: [] }],
})

/** `sse`: `ticks.stream` (typed `Tick`, `X-Stream-Id`), `text.stream`, `chat.send` (POST JSON) and `pending.stream`. */
export function sse(): Json {
	const chat = { properties: { q: STRING }, required: ["q"], type: "object" }
	const ticks = {
		operationId: "ticks.stream",
		parameters: [param("header", "x-tenant"), param("query", "since", INTEGER)],
		responses: events(ref("Tick"), { headers: { "X-Stream-Id": { schema: STRING } } }),
	}
	return document(
		"Sse",
		{
			"/chat": {
				post: {
					operationId: "chat.send",
					parameters: [param("query", "model")],
					requestBody: { content: { "application/json": { schema: chat } }, required: true },
					responses: events(STRING),
				},
			},
			"/pending/{id}": {
				get: {
					operationId: "pending.stream",
					parameters: [param("path", "id", STRING, true)],
					responses: events(STRING),
				},
			},
			"/text": { get: { operationId: "text.stream", responses: events(STRING) } },
			"/ticks": { get: ticks },
		},
		{ Tick: { properties: { n: INTEGER }, required: ["n"], type: "object" } },
	)
}

/** `ws`: `rooms.socket` (path `room`, query `since`, a declared query `reconnect_token`) and `plain.socket`. */
export function ws(): Json {
	const socket = (operationId: string, parameters: readonly Json[]) => ({
		get: { operationId, parameters, responses: UPGRADE, "x-websocket": true },
	})
	return document("Ws", {
		"/plain": socket("plain.socket", []),
		"/rooms/{room}": socket("rooms.socket", [
			param("path", "room", STRING, true),
			param("query", "since", INTEGER),
			param("query", "reconnect_token"),
		]),
	})
}

/** `realtime`: `feed.live` (typed `Payload`, required `channel`, header `x-tenant`) and `feed.resume` (every stream field declared, untyped events). */
export function realtime(): Json {
	const live = (operationId: string, parameters: readonly Json[], schema: Json) => ({
		get: { operationId, parameters, responses: events(schema), "x-realtime": true, "x-websocket": true },
	})
	return document(
		"Realtime",
		{
			"/feed": live(
				"feed.live",
				[param("query", "channel", STRING, true), param("header", "x-tenant")],
				ref("Payload"),
			),
			"/resume": live(
				"feed.resume",
				[
					param("query", "reconnect_token"),
					param("query", "last_event_id"),
					param("query", "protocols"),
					param("header", "Last-Event-ID"),
				],
				STRING,
			),
		},
		{ Payload: { properties: { n: INTEGER, reconnect_token: STRING }, type: "object" } },
	)
}
