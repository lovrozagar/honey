/**
 * `secureHeaders(options)`: the browser security headers every answer should carry. The defaults
 * (nosniff, SAMEORIGIN, a strict referrer policy, the legacy XSS auditor off) are on unless set to
 * `false`; CSP, HSTS, permissions and the cross-origin policies are set only when configured. A
 * header the handler set itself wins: an app-wide default never loosens a stricter route.
 */
import { withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

/**
 * Which headers `secureHeaders` sends. A string sets that header's value. Options that accept `false`
 * have a default, which `false` turns off; the others are sent only when set. An empty string leaves
 * any header out.
 */
export type SecureHeadersOptions = {
	/** Value of `Content-Security-Policy`. Not sent unless set. */
	contentSecurityPolicy?: string
	/** Value of `Cross-Origin-Embedder-Policy`. Not sent unless set. */
	crossOriginEmbedderPolicy?: string
	/** Value of `Cross-Origin-Opener-Policy`. Not sent unless set. */
	crossOriginOpenerPolicy?: string
	/** Value of `Cross-Origin-Resource-Policy`. Not sent unless set. */
	crossOriginResourcePolicy?: string
	/** Value of `Permissions-Policy`. Not sent unless set. */
	permissionsPolicy?: string
	/** Default `strict-origin-when-cross-origin`; `false` leaves it out. */
	referrerPolicy?: false | string
	/** Value of `Strict-Transport-Security`. Not sent unless set. */
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

/**
 * Middleware that adds security headers to every answer passing through it, except a 101 upgrade.
 * `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and `X-XSS-Protection` are on by
 * default; the others are sent only when configured. A header the handler already set is kept.
 */
export function secureHeaders(options: SecureHeadersOptions = {}): MiddlewareFn<{}> {
	const headers = headersFor(options)
	return namedMiddleware("secureHeaders", async (_ctx, next) =>
		withHeaders(await next(), (out) => {
			for (const [name, value] of headers) if (!out.has(name)) out.set(name, value)
		}),
	)
}
