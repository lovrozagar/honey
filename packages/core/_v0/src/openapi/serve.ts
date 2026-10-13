/**
 * Serving side of `app.openapi()` and `app.manifest()`: serialize a document once, tag it, and
 * answer conditional requests. Part of the lazily loaded OpenAPI feature, so none of this sits
 * in the core bundle.
 */
import { ifNoneMatchHits } from "../etag.ts"
import type { ServedArtifact } from "./spec-factory.ts"

const encoder = new TextEncoder()

/** Base64url of the first 16 bytes of SHA-256, quoted: a strong validator for the exact bytes. */
async function entityTag(body: string): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))).subarray(0, 16)
	let binary = ""
	for (let i = 0; i < hash.length; i++) binary += String.fromCharCode(hash[i])
	return `"${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}"`
}

/** Serialize `value` once; the result is cached per route epoch by the caller. */
export async function toServedArtifact(body: string, contentType: string): Promise<ServedArtifact> {
	return { body, contentType, etag: await entityTag(body) }
}

/**
 * The response for a served artifact. Clients revalidate (`no-cache`) rather than reuse a stale
 * document after a deploy; an unchanged document costs a 304.
 */
export function artifactResponse(request: Request, artifact: ServedArtifact): Response {
	const headers = {
		"cache-control": "no-cache",
		"content-type": artifact.contentType,
		etag: artifact.etag,
		"x-content-type-options": "nosniff",
	}
	if (ifNoneMatchHits(request.headers.get("if-none-match"), artifact.etag)) {
		return new Response(null, { headers, status: 304 })
	}
	return new Response(artifact.body, { headers })
}
