/**
 * The SDK-only rows of the conformance grid (bit 21 i0): the answers no shared row had, each through the NORMAL client
 * of the six SDKs, and a text answer no shared row had (F2). An undecodable 2xx is the target's decode error: Python's DecodeError, Rust's Error::Decode, C#'s
 * and Java's DecodeException. TS has no decode class yet (the ClientError parseBody throws, on the 2xx status; i1 adds
 * DecodeError) and Go no decode type (the wrapped decode error, no ClientError; i3 adds *DecodeError): each driver
 * reads its target's as it is today. Every expectation is what the reference app (core `conformance/app.ts`) answers.
 */
import { call, data, error, events, hop } from "./cells.ts"
import type { Feature, Scenario, Target } from "./matrix.ts"

/** The SDK targets: the six generated clients, each with its normal (throwing) and safe styles (bit 21 i). */
export const SDKS = ["ts", "go", "rust", "python", "csharp", "java"] as const satisfies readonly Target[]

const decode: Scenario[] = [
	{
		calls: [call("faults.undecodable", "GET", "/v1/faults/undecodable")],
		expect: [{ kind: "decode", status: 200 }],
		id: "undecodable-2xx",
		wire: [hop("GET", "/v1/faults/undecodable")],
	},
]

/* nothing listens on the refused origin: no answer, so no hop (f2) */
const transport: Scenario[] = [
	{
		calls: [call("echo.get", "GET", "/v1/echo", { origin: "refused" })],
		expect: [{ kind: "transport" }],
		id: "refused",
		wire: [],
	},
]

const stream: Scenario[] = [
	/* the opening answer is an error status: the typed error at open, never an event */
	{
		calls: [call("ticks.refused", "GET", "/v1/ticks/refused", { take: 1 })],
		expect: [error(403, "limit_reached")],
		id: "initial-error",
		wire: [hop("GET", "/v1/ticks/refused")],
	},
	/* the drop origin cuts the connection after the three ticks: each delivered, then the stream's own error (f2) */
	{
		calls: [call("ticks.stream", "GET", "/v1/ticks", { origin: "drop" })],
		expect: [{ events: events(1, 3, "tick"), failed: "transport", kind: "events" }],
		id: "mid-drop",
		wire: [hop("GET", "/v1/ticks", { origin: "drop" })],
	},
]

/*
 * a text/plain answer as the exact string (F2): `health`, the app's one text op, unmarked so no MCP tool, already in
 * the CLI's index; no shared row answered text before
 */
const text: Scenario[] = [
	{ calls: [call("health", "GET", "/v1/health")], expect: [data("ok")], id: "plain", wire: [hop("GET", "/v1/health")] },
]

/** Rows the six SDKs run. */
const sdks = (id: string, asserted: string, scenarios: Scenario[]): Feature => ({
	asserted,
	id,
	scenarios,
	targets: SDKS,
})

/** The SDK-only rows. */
export const SDK_ROWS: readonly Feature[] = [
	sdks("decode", "a 2xx whose body does not decode is the target's decode error, never data", decode),
	sdks("transport", "no answer (a refused connection) is the target's connection error, never an API error", transport),
	sdks(
		"stream",
		"an error opening a stream is the typed error at open; a drop after events is the stream's own error",
		stream,
	),
	sdks("text", "a text/plain answer is the exact string, never decoded as JSON", text),
]
