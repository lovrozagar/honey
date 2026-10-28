/**
 * A client session's steps and what each gave (bit 21 b): types alone, shared by the TS clients (clients.ts) and the
 * Python one (python-client.ts), so the Python client's fixture reaches neither the npm clients nor their install.
 */

/** One step of a client session: list the tools, call one, or report the revision negotiated. */
export type Step =
	| { readonly list: true }
	| { readonly call: { readonly name: string; readonly arguments: object } }
	| { readonly negotiated: true }

/** What one step gave: the tools listed, a call's result, the revision negotiated, or the client's error. */
export type Stepped = {
	readonly tools?: Record<string, unknown>[]
	readonly result?: Record<string, unknown>
	readonly negotiated?: string
	readonly failed?: string
}
