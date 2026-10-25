/**
 * A tool's annotations (bit 18 phase d), by its operation's method, each hint written only where it differs from the
 * spec's default (readOnly false, destructive true, idempotent false, openWorld true), so no token is spent saying the
 * default: GET and HEAD read only; a POST not destructive, and idempotent when it takes an idempotency key; PUT and
 * DELETE idempotent, destructive as the default says; PATCH and any other method none at all.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"

/** The hints a tool's annotations hold. */
export type Annotations = {
	readonly readOnlyHint?: true
	readonly destructiveHint?: false
	readonly idempotentHint?: true
}

/** `op`'s annotations, or none when every hint is the default. */
export function annotationsOf(op: SdkOp): Annotations | undefined {
	switch (op.method.toUpperCase()) {
		case "GET":
		case "HEAD":
			return { readOnlyHint: true }
		case "POST":
			return op.idempotent ? { destructiveHint: false, idempotentHint: true } : { destructiveHint: false }
		case "PUT":
		case "DELETE":
			return { idempotentHint: true }
		default:
			return undefined
	}
}
