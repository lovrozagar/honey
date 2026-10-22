/**
 * A Java call's error as the Java driver traces it (bit 16 phase c1; the Java analog of `CsError`, protocol.ts):
 * `type` is the simple class name, `chain` runs from it up to and including the SDK's `HoneyException` (or `[type]`
 * outside the SDK), `display` is the first line of `toString()`, and an `ApiException` adds its status, key, the
 * `ErrorKey` constant's name, its detail and, with `envelope`, its envelope members.
 */
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export type JavaError = {
	/** `e.getClass().getSimpleName()` */
	readonly type: string
	/** the simple names from the class up to and including `HoneyException`; `[type]` outside the SDK */
	readonly chain: readonly string[]
	/** `e.getMessage()` */
	readonly text: string
	/** the first line of `e.toString()` */
	readonly display: string
	/** the method's throw, a safe-mode `Result.Err`, or one a stream delivered */
	readonly via: "result" | "return" | "stream"
	/** the cause's simple name; null without one */
	readonly inner: string | null
	/** whether the error is a `CancellationException` (the caller's cancel) */
	readonly canceled: boolean
	/** ApiException only: its status */
	readonly status?: number
	/** ApiException only: the envelope's error key; null without one */
	readonly key?: string | null
	/** ApiException only: the `ErrorKey` constant whose value is `key`; null when none is */
	readonly keyMember?: string | null
	/** ApiException only: its detail */
	readonly message?: string
	/** ApiException with `envelope`: its set members and `extraKeys`, sorted */
	readonly envelope?: Json
}
