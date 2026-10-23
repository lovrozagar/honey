/**
 * A realtime operation's method (bit 16 phase d2b, R1/R8; C#'s `realtime.ts`, Fd6/Fd7): `ResumableConnection<T>`, `T`
 * the declared event schema's type, else `JsonNode`, connected through `Realtime.open` over WebSocket, else SSE, else
 * long-poll before the method returns. Its five fields are `TransportOptions.of`'s: the resume cursor (`lastEventId`,
 * `reconnectToken`), the offered `protocols` and the reconnect policy (`maxReconnectAttempts`, `reconnectDelay`). The
 * runtime puts the cursor on each dial, so none of them is a Call arg; a declared `last_event_id` or `reconnect_token`
 * query, or a Last-Event-ID header, folds in, and a param spelled like a field claims `…2`. A realtime method is the
 * same text in either mode: it answers no Result.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { type JavaTypeContext, javaTypeOf } from "./models.ts"
import { assigned, docOf, layout } from "./sdk-decl.ts"
import { CURSOR, isLastEventIdHeader } from "./sse.ts"
import { isReconnectTokenQuery, PROTOCOLS, TOKEN } from "./ws.ts"

/** The reconnect policy's Params fields. */
export const MAX_RECONNECT_ATTEMPTS = "maxReconnectAttempts"
export const RECONNECT_DELAY = "reconnectDelay"

/** A realtime op's own fields in `TransportOptions.of`'s order, each with its Java type. */
export const REALTIME_FIELDS = [
	{ field: CURSOR, type: "String" },
	{ field: TOKEN, type: "String" },
	{ field: PROTOCOLS, type: "List<String>" },
	{ field: MAX_RECONNECT_ATTEMPTS, type: "java.lang.Integer" },
	{ field: RECONNECT_DELAY, type: "Duration" },
] as const

/** Whether a declared param is on a realtime resume channel the cursor fields carry (C#'s `carries`). */
export const carriesRealtime = (name: string, where: "query" | "header") =>
	where === "query" ? isReconnectTokenQuery(name) || name === "last_event_id" : isLastEventIdHeader(name)

/**
 * The realtime runtime's files: the connection, its loop and options, the transport contract and the three default
 * adapters; only an SDK with a realtime operation ships them (with the WebSocket files, which its WebSocket adapter dials
 * through).
 */
export const REALTIME_FILES = [
	"ConnectionState",
	"LongPollAdapter",
	"Realtime",
	"RealtimeLoop",
	"ResumableConnection",
	"SseAdapter",
	"TransportAdapter",
	"TransportConnection",
	"TransportKind",
	"TransportMessage",
	"TransportOptions",
	"WsAdapter",
]

/** The type a realtime op's messages decode to: the declared event schema's, else `JsonNode`. */
const messageTypeOf = (op: SdkOp, ctx: JavaTypeContext) =>
	op.events === undefined ? "JsonNode" : javaTypeOf(op.events, { ...ctx, fieldName: "Event", parentName: op.id })

/** What a realtime method's lines need: its name and constant, its Params, and its Call's lines. */
export type RealtimeSite = {
	readonly name: string
	readonly constant: string
	readonly params: string
	readonly call: readonly string[]
}

/** A realtime method's lines: `op(params)`, delegating to `op(params, options)`, which connects. */
export function realtimeMethodLines(op: SdkOp, site: RealtimeSite, ctx: JavaTypeContext): string[] {
	const { call, constant, name, params } = site
	const type = messageTypeOf(op, ctx)
	const doc = docOf(
		`${op.id}: the connection over WebSocket, else SSE, else long-poll. It reconnects after a drop and resumes after the last message it delivered; close() ends it.`,
	)
	const signature = (args: readonly string[]) =>
		layout(`public ResumableConnection<${type}> ${name}(`, args, ") {", "  ")
	return [
		doc,
		...signature([`${params} params`]),
		`    return ${name}(params, null);`,
		"  }",
		"",
		doc,
		...signature([`${params} params`, "RequestOptions options"]),
		...call,
		...assigned("    ", "TransportOptions transport", {
			items: REALTIME_FIELDS.map((f) => `params.${f.field}()`),
			prefix: "TransportOptions.of(",
			suffix: ");",
		}),
		...layout(
			"return Realtime.open(",
			["exchange", constant, "call", "options", "transport", `new TypeReference<${type}>() {}`],
			");",
			"    ",
		),
		"  }",
		"",
	]
}
