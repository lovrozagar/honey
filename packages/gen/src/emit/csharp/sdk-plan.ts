/**
 * The C# SDK's call plan for one operation (contract 45 §4.8), in the emitter's own names: what the fixed
 * reflection driver (`__fixtures__/driver/Invoke.cs`) walks with `GetProperty` and `GetMethod`, binding each
 * argument to its parameter by name through the SDK's own `JsonSerializerContext` (Fb10), so nothing is generated
 * for it (G17). A plan carries no C# type: the driver reads each parameter's type from the method itself.
 */
import type { SdkBody, SdkResponseKind, SdkStream } from "../../ir/sdk-model.ts"

export type CSharpCallPlan = {
	readonly operation: string
	/** the property names from the client to the method's resource, root first: `["Orgs", "Members", "Notes"]` */
	readonly accessors: readonly string[]
	/** the method as emitted: `"CreateAsync"` */
	readonly method: string
	/** each path param's spec name to its parameter name, in path order */
	readonly path: readonly { readonly name: string; readonly param: string }[]
	readonly body: { readonly kind: SdkBody["kind"]; readonly param: string } | null
	/** each query param's spec name to its parameter name */
	readonly query: Readonly<Record<string, string>>
	/** each header param's spec name to its parameter name */
	readonly headers: Readonly<Record<string, string>>
	/** the parameters without a default */
	readonly required: readonly string[]
	/** the idempotency key's parameter name */
	readonly idempotencyKey: string | null
	readonly response: SdkResponseKind
	/** false: the method answers `SdkResult` (`throwOnError: false`) */
	readonly throws: boolean
	readonly stream: SdkStream
}
