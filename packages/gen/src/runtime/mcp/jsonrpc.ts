/**
 * JSON-RPC 2.0 as MCP frames it (bit 18): a message, the error codes a server answers with, and the two reply shapes.
 * A request carries an id; a notification does not and is never answered.
 */

/** One message as it arrives: anything may be missing or of the wrong type until checked. */
export type Message = {
	readonly jsonrpc?: unknown
	readonly id?: unknown
	readonly method?: unknown
	readonly params?: unknown
}

/** A request's id: a string or a number (JSON-RPC 2.0; MCP forbids null). */
export type Id = string | number

/** The error codes this server answers with. */
export const ErrorCode = {
	InternalError: -32603,
	InvalidParams: -32602,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	ParseError: -32700,
} as const

/** A reply: a request's result, or its error. */
export type Reply =
	| { readonly jsonrpc: "2.0"; readonly id: Id; readonly result: unknown }
	| {
			readonly jsonrpc: "2.0"
			readonly id: Id | null
			readonly error: { readonly code: number; readonly message: string }
	  }

/** The result reply to the request `id`. */
export const result = (id: Id, value: unknown): Reply => ({ id, jsonrpc: "2.0", result: value })

/** The error reply to the request `id` (null when it could not be read). */
export const failure = (id: Id | null, code: number, message: string): Reply => ({
	error: { code, message },
	id,
	jsonrpc: "2.0",
})

/** Whether `value` is an id a request may carry. */
export const isId = (value: unknown): value is Id =>
	typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
