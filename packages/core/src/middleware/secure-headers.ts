/**
 * `secureHeaders(options)`: the browser security headers every answer should carry. The defaults
 * (nosniff, SAMEORIGIN, a strict referrer policy, the legacy XSS auditor off) are on unless set to
 * `false`; CSP, HSTS, permissions and the cross-origin policies are set only when configured. A
 * header the handler set itself wins: an app-wide default never loosens a stricter route.
 */
import { withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type SecureHeadersOptions = {
	contentSecurityPolicy?: string
	crossOriginEmbedderPolicy?: string
	crossOriginOpenerPolicy?: string
	crossOriginResourcePolicy?: string
	permissionsPolicy?: string
	/** Default `strict-origin-when-cross-origin`; `false` leaves it out. */
	referrerPolicy?: false | string
	strictTransportSecurity?: string
	/** Default `nosniff`; `false` leaves it out. */
	xContentTypeOptions?: false | string
	/** Default `SAMEORIGIN`; `false` leaves it out. */
	xFrameOptions?: false | string
	/** Default `0` (the legacy auditor off); `false` leaves it out. */
	xXssProtection?: false | string
}

/** A default header's value: `false` leaves it out, unset takes the default. */
function withDefault(value: false | string | undefined, fallback: string): string | null {
	return value === false ? null : (value ?? fallback)
}

/** The headers `options` asks for, computed once. */
function headersFor(options: SecureHeadersOptions): [string, string][] {
	const entries: [string, string | null | undefined][] = [
		["x-content-type-options", withDefault(options.xContentTypeOptions, "nosniff")],
		["x-frame-options", withDefault(options.xFrameOptions, "SAMEORIGIN")],
		["referrer-policy", withDefault(options.referrerPolicy, "strict-origin-when-cross-origin")],
		["x-xss-protection", withDefault(options.xXssProtection, "0")],
		["content-security-policy", options.contentSecurityPolicy],
		["strict-transport-security", options.strictTransportSecurity],
		["permissions-policy", options.permissionsPolicy],
		["cross-origin-opener-policy", options.crossOriginOpenerPolicy],
		["cross-origin-resource-policy", options.crossOriginResourcePolicy],
		["cross-origin-embedder-policy", options.crossOriginEmbedderPolicy],
	]
	return entries.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
}

export function secureHeaders(options: SecureHeadersOptions = {}): MiddlewareFn<{}> {
	const headers = headersFor(options)
	return namedMiddleware("secureHeaders", async (_ctx, next) =>
		withHeaders(await next(), (out) => {
			for (const [name, value] of headers) if (!out.has(name)) out.set(name, value)
		}),
	)
}
