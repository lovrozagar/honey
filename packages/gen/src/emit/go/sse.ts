/**
 * A server-sent-events operation as a Go method (G12): it returns `iter.Seq2[SSEEvent[T], error]`,
 * `T` the type of the declared event schema (`string` when the events are untyped), and opens the
 * stream when ranged. `<Op>Opts.LastEventID` resumes it as the Last-Event-ID header, which also
 * carries a declared Last-Event-ID header param (Fd3). An error status at the opening is the
 * stream's error value; its `Client.Safe()` twin opens the stream on the call and answers that
 * status as its Result's Err (bit 21 i3).
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { type GoStream, sendArgs } from "./sdk-answer.ts"
import type { OptsField, StreamOpts } from "./sdk-opts.ts"
import { type GoTypeContext, goTypeOf } from "./types.ts"

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (param: string, where: OptsField["in"]) =>
	where === "header" && param.toLowerCase() === "last-event-id"

/* LastEventID, sent only when set: an empty header would still name a position */
const SSE_OPTS: StreamOpts = {
	before: [],
	carries: isLastEventIdHeader,
	fields: [{ name: "LastEventID", type: "string" }],
	sets: ['if opts.LastEventID != "" {', '\tc.headers["Last-Event-ID"] = opts.LastEventID', "}"],
}

/** The method of the SSE operation `op`, its event type hoisted into `at` as `<Op>Event` when inline. */
export function sseStream(op: SdkOp, at: GoTypeContext): GoStream {
	const typed = op.events && goTypeOf(op.events, { ...at, fieldName: "Event", parentName: op.id }).replace(/^\*/, "")
	const event = typed ?? "string"
	const open = typed === undefined ? "streamText" : `streamJSON[${typed}]`
	return {
		doc: "Breaking out of the loop closes the stream; ctx ends it quietly.",
		opts: SSE_OPTS,
		shape: {
			fail: `sseFail[${event}](err)`,
			returns: `iter.Seq2[SSEEvent[${event}], error]`,
			tail: (client) => [`\treturn ${open}(${sendArgs(client)})`],
		},
	}
}
