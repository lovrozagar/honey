/**
 * The docs page shell: pinned UI assets with Subresource Integrity, JSON safe to inline in a
 * script, and a handler that answers each request with a fresh script nonce under a CSP that
 * runs only that inline script and the pinned CDN. The page runs on the API's own origin, so an
 * unpinned script could read anything the origin can; a pinned one with an integrity hash can only
 * ever be these bytes.
 */
import type { TypedResponse } from "../response/response.ts"

export const SWAGGER_UI = {
	css: {
		integrity: "sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW",
		url: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1/swagger-ui.css",
	},
	js: {
		integrity: "sha384-ZPehFMQommnnuaZ4rpxgkgTT2DKFVp4hZC/7pLit+9Lek9T1YGSo23eHFbvNkXkw",
		url: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1/swagger-ui-bundle.js",
	},
} as const

export const SCALAR = {
	js: {
		integrity: "sha384-kYDGzV91Jnn3TbHINV3nt54riK2uMJDfN5Al8dAkz4FssELTBWbD8rgw32sTKfOi",
		url: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.73.1/dist/browser/standalone.js",
	},
} as const

const CDN_ORIGIN = "https://cdn.jsdelivr.net"

/** The page's policy: nothing by default, its own nonce'd inline script and the pinned CDN. */
const csp = (scriptNonce: string) =>
	[
		"default-src 'none'",
		`script-src 'nonce-${scriptNonce}' ${CDN_ORIGIN}`,
		`style-src 'self' 'unsafe-inline' ${CDN_ORIGIN}`,
		"img-src 'self' data: https:",
		"font-src 'self' data: https:",
		"connect-src 'self' https:",
		"worker-src blob:",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'self'",
		"object-src 'none'",
	].join("; ")

/** What a docs page reads of its context: the HTML answer. */
export type DocsContext = {
	readonly res: {
		html(statusKey: "ok", body: string, options?: { headers?: Record<string, string> }): TypedResponse
	}
}

/** A docs page config: the document URL, and the rest of the UI's own options. */
export type DocsConfig = { readonly url: string; readonly [key: string]: unknown }

/**
 * JSON for an inline `<script>`: `<`, `>` and `&` cannot end the element or start an entity, and
 * U+2028/U+2029 cannot end a string literal in older engines.
 */
export function inlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replace(/[\u2028\u2029]/g, (separator) => `\\u${separator.charCodeAt(0).toString(16)}`)
}

/** A fresh 128-bit script nonce, base64. */
function nonce(): string {
	let binary = ""
	for (const byte of crypto.getRandomValues(new Uint8Array(16))) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/** A docs page handler: `render` writes the page around a nonce minted for each answer. */
export function docsPage(render: (nonce: string) => string): (ctx: DocsContext) => TypedResponse {
	return (ctx) => {
		const n = nonce()
		return ctx.res.html("ok", render(n), {
			headers: {
				"content-security-policy": csp(n),
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
			},
		})
	}
}
