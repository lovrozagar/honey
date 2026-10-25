/**
 * The conformance grid's building blocks, shared by its rows (features.ts) and the MCP-only rows (features-mcp.ts):
 * the matchers a cell spells most, the reference app's media types and byte digests, and a call, a hop, a data answer,
 * an error and an event run.
 */
import type { Call, Expected, Hop } from "./matrix.ts"

export const ANY = { $any: true } as const
export const ABSENT = { $absent: true } as const
export const JSON_TYPE = "application/json"
export const OCTET = "application/octet-stream"
/** sha256 of the bytes `i & 0xff` for i < 256 and for i < 65 536 */
export const SHA_256B = "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880"
export const SHA_64K = "7daca2095d0438260fa849183dfc67faa459fdf4936e1bc91eec6b281b27e4c2"

/** A call to `operation` at `method path`, with the rest of `more`. */
export const call = (operation: string, method: string, path: string, more: Partial<Call> = {}): Call => ({
	operation,
	route: { method, path },
	...more,
})

/** An expected hop on the primary origin, with the rest of `more`. */
export const hop = (method: string, url: string, more: Partial<Hop> = {}): Hop => ({
	method,
	origin: "primary",
	url,
	...more,
})

/** A data answer. */
export const data = (value: Expected, status = 200) => ({ data: value, kind: "data", status })

/** An error answer by status and key. */
export const error = (status: number, errorKey: string): Expected => ({ errorKey, kind: "error", status })

/** Events `from`..`to` named `event`, data `{ n }` and id `n`: the reference log's (`message`) or the ticks. */
export const events = (from: number, to: number, event = "message"): Expected[] =>
	Array.from({ length: to - from + 1 }, (_, i) => ({ data: { n: from + i }, event, id: String(from + i) }))
