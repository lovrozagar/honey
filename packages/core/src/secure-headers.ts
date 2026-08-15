import type { MiddlewareFn } from "./middleware.ts"

type SecureHeadersOptions = {
	contentSecurityPolicy?: string
	crossOriginEmbedderPolicy?: string
	crossOriginOpenerPolicy?: string
	crossOriginResourcePolicy?: string
	permissionsPolicy?: string
	referrerPolicy?: false | string
	strictTransportSecurity?: string
	xContentTypeOptions?: false | string
	xFrameOptions?: false | string
	xXssProtection?: false | string
}

export function secureHeaders(options?: SecureHeadersOptions): MiddlewareFn<{}, {}> {
	const opts = options ?? {}

	const headers: Array<[string, string]> = []

	const xContentType = opts.xContentTypeOptions
	if (xContentType !== false) {
		headers.push(["x-content-type-options", xContentType ?? "nosniff"])
	}

	const xFrame = opts.xFrameOptions
	if (xFrame !== false) {
		headers.push(["x-frame-options", xFrame ?? "SAMEORIGIN"])
	}

	const referrer = opts.referrerPolicy
	if (referrer !== false) {
		headers.push(["referrer-policy", referrer ?? "strict-origin-when-cross-origin"])
	}

	const xss = opts.xXssProtection
	if (xss !== false) {
		headers.push(["x-xss-protection", xss ?? "0"])
	}

	if (opts.contentSecurityPolicy) {
		headers.push(["content-security-policy", opts.contentSecurityPolicy])
	}
	if (opts.strictTransportSecurity) {
		headers.push(["strict-transport-security", opts.strictTransportSecurity])
	}
	if (opts.permissionsPolicy) {
		headers.push(["permissions-policy", opts.permissionsPolicy])
	}
	if (opts.crossOriginOpenerPolicy) {
		headers.push(["cross-origin-opener-policy", opts.crossOriginOpenerPolicy])
	}
	if (opts.crossOriginResourcePolicy) {
		headers.push(["cross-origin-resource-policy", opts.crossOriginResourcePolicy])
	}
	if (opts.crossOriginEmbedderPolicy) {
		headers.push(["cross-origin-embedder-policy", opts.crossOriginEmbedderPolicy])
	}

	const mw: MiddlewareFn<{}, {}> = async (_ctx, next) => {
		const response = await next()
		for (const [name, value] of headers) {
			response.headers.set(name, value)
		}
		return response
	}

	return mw
}
