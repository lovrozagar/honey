/**
 * An SSE operation's method (bit 16 phase d1, J1/J3/J7; C#'s `sse.ts`): `EventStream<T>`, `T` the declared event
 * schema's type, or `EventStream<String>` for untyped events, opened by the call through the exchange's `events`, so an
 * error status throws before any event. Its cursor field, `lastEventId`, is sent as Last-Event-ID only when set and
 * non-empty; a declared Last-Event-ID header param folds into it. A stream method is the same text in either mode: it
 * answers no Result. Its javadoc says how a stream lets its connection go (F1: a for-each `break` has no close hook).
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { type JavaTypeContext, javaTypeOf } from "./models.ts"
import { docOf, layout } from "./sdk-decl.ts"
import type { JavaHeaders } from "./sdk-headers.ts"

/** The header an SSE open resumes an event stream with. */
export const LAST_EVENT_ID = "Last-Event-ID"

/** The cursor's Params field. */
export const CURSOR = "lastEventId"

/** Whether a declared header param is Last-Event-ID (any casing), the resume channel the cursor field carries. */
export const isLastEventIdHeader = (name: string) => name.toLowerCase() === LAST_EVENT_ID.toLowerCase()

/** F1's doc obligation: how a stream lets its connection go. */
export const RELEASE = "Open it in try-with-resources: a for-each break without one keeps the connection."

/** The SSE runtime's files: the stream, its event, the parser and the body's pump; core, with every exchange. */
export const SSE_FILES = ["EventStream", "Pump", "Sse", "SseEvent"]

/** The type an SSE op's events decode to: the declared event schema's, else `String`. */
export const eventTypeOf = (op: SdkOp, ctx: JavaTypeContext) =>
	op.events === undefined ? "String" : javaTypeOf(op.events, { ...ctx, fieldName: "Event", parentName: op.id })

/** What an SSE method's lines need: its name and constant, its Params, its headers holder, and its Call's lines. */
export type SseSite = {
	readonly name: string
	readonly constant: string
	readonly params: string
	readonly headers: JavaHeaders | null
	readonly call: readonly string[]
}

/**
 * An SSE method's lines: `op(params)` and `op(params, options)`, and `op(params, headersInto, options)` for an operation
 * with response headers, filled at the open; the shorter overloads delegate to the longest.
 */
export function sseMethodLines(op: SdkOp, site: SseSite, ctx: JavaTypeContext): string[] {
	const { call, constant, headers, name, params } = site
	const type = eventTypeOf(op, ctx)
	const doc = docOf(
		`${op.id}: the open stream. An error status throws before any event, and no timeout bounds it after that. ${RELEASE}`,
	)
	const signature = (args: readonly string[]) => layout(`public EventStream<${type}> ${name}(`, args, ") {", "  ")
	const holder = headers === null ? "null" : "headersInto == null ? null : headersInto::read"
	const open = [
		...call,
		...layout(
			"return exchange.events(",
			[constant, "call", "options", holder, `new TypeReference<${type}>() {}`],
			");",
			"    ",
		),
	]
	const longest = headers === null ? open : [`    return ${name}(params, null, options);`]
	return [
		doc,
		...signature([`${params} params`]),
		`    return ${name}(params, null${headers === null ? "" : ", null"});`,
		"  }",
		"",
		doc,
		...signature([`${params} params`, "RequestOptions options"]),
		...longest,
		"  }",
		"",
		...(headers === null
			? []
			: [
					doc,
					...signature([`${params} params`, `${headers.type} headersInto`, "RequestOptions options"]),
					...open,
					"  }",
					"",
				]),
	]
}
