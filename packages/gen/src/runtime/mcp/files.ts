/**
 * A file argument's value (bit 21 c): the io.modelcontextprotocol/files draft's FileInput (PR head 6101d34), its data
 * canonical base64 of its size and digest, a call's inline bytes capped; or a path a reading transport reads. The
 * extension is advertised from bit 21 g, with its uploads.
 */

/** Reads a file by its path, rejecting with the rule it breaks. */
export type Read = (path: string) => Promise<Uint8Array>

/* canonical base64: whole quads, the last padded, its unused bits zero */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/

/** `text`'s bytes when it is canonical base64. */
export const decoded = (text: string): Uint8Array<ArrayBuffer> | undefined =>
	BASE64.test(text) ? Uint8Array.from(atob(text), (char) => char.charCodeAt(0)) : undefined

/** An inline FileInput's bytes, `budget.left` the inline bytes still allowed; else the rule it breaks. */
async function inlined(file: Record<string, unknown>, budget: { left: number; cap: number }) {
	if (typeof file.data !== "string") return "has no data, and no upload is served here"
	const bytes = decoded(file.data)
	if (bytes === undefined) return "data is not base64"
	if ((budget.left -= bytes.length) < 0) return `is past the ${budget.cap} inline bytes a call may carry`
	if (bytes.length !== file.size) return "data does not decode to its size"
	const hash = String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
	/* the digest is base64url, unpadded */
	const digest = btoa(hash).replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_")
	if (digest !== (file.digest as { value: unknown }).value) return "data does not match its digest"
	return { bytes, type: String(file.mimeType), ...(typeof file.name === "string" && { name: file.name }) }
}

/** A file argument its inputSchema took: its bytes, name and type; else the rule it breaks. */
export async function fileOf(
	file: Record<string, unknown>,
	read: Read | undefined,
	budget: { left: number; cap: number },
) {
	if (Object.hasOwn(file, "id")) return inlined(file, budget)
	if (read === undefined) return "is a path, which only the stdio server reads"
	const path = String(file.path)
	try {
		return { bytes: await read(path), name: path.split(/[/\\]/).pop(), type: "application/octet-stream" }
		/* a reader's refusal is its rule */
	} catch (error) {
		return (error as Error).message
	}
}
