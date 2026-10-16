/**
 * The Rust SDK's call plan for one operation (contract 18 §7.4), in the emitter's own names: what the test
 * driver's `dispatch.rs` is written from, since Rust has no reflection to find a method or a field by name.
 * A plan carries no Rust type: each type is inferred from the method's parameters and the Opts fields.
 */
import type { SdkBody, SdkResponseKind, SdkStream } from "../../ir/sdk-model.ts"

export type RustCallPlan = {
	readonly operation: string
	/** the accessor idents from the client to the method's resource, root first: `["orgs", "members", "notes"]` */
	readonly accessors: readonly string[]
	/** the method ident as emitted (may be `r#use`) */
	readonly method: string
	/** the path params by spec name, in signature order */
	readonly pathParams: readonly string[]
	readonly body: SdkBody["kind"] | null
	/** the `<Op>Opts` type name */
	readonly opts: string
	/** each query param's spec name to its Opts field ident */
	readonly query: Readonly<Record<string, string>>
	/** each header param's spec name to its Opts field ident */
	readonly headers: Readonly<Record<string, string>>
	/** the Opts field idents that are a bare `T`, set without `Some` */
	readonly required: readonly string[]
	/** the Opts field ident of the idempotency key */
	readonly idempotencyKey: string | null
	readonly response: SdkResponseKind
	/** the `<Op>Headers` type name, and each declared header (as the spec spells it) to its field ident */
	readonly responseHeaders: { readonly type: string; readonly fields: Readonly<Record<string, string>> } | null
	readonly stream: SdkStream
}
