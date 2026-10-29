/**
 * The Java SDK's call plan for one operation (bit 16 phase c1, C1): the names a fixed reflection driver walks, the
 * same shape as the C# plan (`csharp/sdk-plan.ts`), so the driver binds each argument through the operation's
 * `<Op>Params` builder by its field name and never re-derives a name. A plan carries no Java type.
 */
import type { SdkBody, SdkResponseKind, SdkStream } from "../../ir/sdk-model.ts"

export type JavaCallPlan = {
	readonly operation: string
	/** the accessor names from the client to the operation's resource, root first: `["users"]` */
	readonly accessors: readonly string[]
	/** the method as emitted: `"get"` */
	readonly method: string
	/** the `<Op>Params` class the method takes */
	readonly params: string
	/** each path param's spec name to its record field, in path order */
	readonly path: readonly { readonly name: string; readonly param: string }[]
	/** the body's kind and its record field; null without a body */
	readonly body: { readonly kind: SdkBody["kind"]; readonly param: string } | null
	/** each query param's spec name to its record field */
	readonly query: Readonly<Record<string, string>>
	/** each declared header param's spec name to its record field; the idempotency key is `idempotencyKey`'s (C#'s plan) */
	readonly headers: Readonly<Record<string, string>>
	/** the record fields a builder must set */
	readonly required: readonly string[]
	/** the idempotency key's record field; null when the operation is not keyed (a stream never is) */
	readonly idempotencyKey: string | null
	/** an SSE or realtime operation's cursor field, sent as Last-Event-ID (realtime: also last_event_id); null otherwise */
	readonly lastEventId: string | null
	/** a WebSocket or realtime operation's subprotocols field; null for any other operation */
	readonly protocols: string | null
	/** a WebSocket or realtime operation's resume token field, sent as reconnect_token; null for any other operation */
	readonly reconnectToken: string | null
	/** a realtime operation's reconnect budget field; null for any other operation */
	readonly maxReconnectAttempts: string | null
	/** a realtime operation's reconnect delay field (a Duration); null for any other operation */
	readonly reconnectDelay: string | null
	readonly response: SdkResponseKind
	/** the `<Op>Headers` holder the method takes as `headersInto`, each declared header to its accessor; null without one */
	readonly responseHeaders: { readonly type: string; readonly fields: Readonly<Record<string, string>> } | null
	/** the method has a `RequestOptions` overload; every method does */
	readonly options: true
	readonly stream: SdkStream
}
