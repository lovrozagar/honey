/**
 * The Python SDK's call plan for one operation (contract 28 §4.7), in the emitter's own names: what the fixed
 * reflection driver (`__fixtures__/driver/invoke.py`) walks with `getattr`, so nothing is generated for it
 * (G17). A plan carries no Python type: the driver passes each value as the call gives it.
 */
import type { SdkBody, SdkResponseKind, SdkStream } from "../../ir/sdk-model.ts"

export type PythonCallPlan = {
	readonly operation: string
	/** the attribute names from the client to the method's resource, root first: `["orgs", "members", "notes"]` */
	readonly accessors: readonly string[]
	/** the method name as emitted (may be `from_`) */
	readonly method: string
	/** the path params by spec name, in signature order */
	readonly pathParams: readonly string[]
	readonly body: SdkBody["kind"] | null
	/** each query param's spec name to its keyword */
	readonly query: Readonly<Record<string, string>>
	/** each header param's spec name to its keyword (a folded stream header is absent) */
	readonly headers: Readonly<Record<string, string>>
	/** the keywords that have no default */
	readonly required: readonly string[]
	/** the keyword of the idempotency key */
	readonly idempotencyKey: string | null
	readonly response: SdkResponseKind
	/** the `<Op>Headers` TypedDict, and each declared header (as the spec spells it) to its key */
	readonly responseHeaders: { readonly type: string; readonly fields: Readonly<Record<string, string>> } | null
	readonly stream: SdkStream
	/** whether `SDK` (sync) has the method: every non-stream op */
	readonly sync: boolean
}
