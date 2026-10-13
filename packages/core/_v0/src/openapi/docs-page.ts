import type { TypedResponse } from "../response.ts"

/**
 * Pinned docs UI assets with Subresource Integrity. The page runs on the API's own origin, so
 * an unpinned CDN script could read anything the origin can; a pinned version with an
 * integrity hash can only ever be these bytes.
 */
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

/* built from char codes: a formatter may turn an escape in a literal into the raw separator */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

/**
 * JSON for an inline `<script>`: `<` cannot end the element, and U+2028/U+2029 cannot end a
 * string literal in older engines.
 */
export function inlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replaceAll(LINE_SEPARATOR, "\\u2028")
		.replaceAll(PARAGRAPH_SEPARATOR, "\\u2029")
}

export function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function nonce(): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	let s = ""
	for (const b of bytes) s += String.fromCharCode(b)
	return btoa(s)
}

type DocsCtx = { res: { html(sk: "ok", body: string, opts?: { headers?: Record<string, string> }): TypedResponse } }

/**
 * A docs page handler: a fresh script nonce per response, a CSP that allows only that inline
 * script and the pinned CDN, and `nosniff`.
 */
export function docsPage(render: (nonce: string) => string): (ctx: DocsCtx) => TypedResponse {
	const handler = (ctx: DocsCtx) => {
		const n = nonce()
		const csp = [
			"default-src 'none'",
			`script-src 'nonce-${n}' ${CDN_ORIGIN}`,
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
		return ctx.res.html("ok", render(n), {
			headers: {
				"content-security-policy": csp,
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
			},
		})
	}
	Object.defineProperty(handler, Symbol.for("honey.internal"), { value: true })
	return handler
}
