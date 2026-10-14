/**
 * A raw body as `.input({ binary })` declares it (A1): bytes of a declared media type, an upload
 * of an image or a file. The declared types are exact essences or `type/*` ranges; a request
 * whose media type matches none answers 415 before its body is read, and the one that matched is
 * handed on beside the bytes. Size is bodyLimit's or the server's cap, not a knob of its own.
 */
import { EK, HoneyError } from "../errors/error.ts"
import { parseMediaType } from "../response/media-type.ts"

/** The media types a route takes as a binary body: one, or a list; each `type/subtype` or `type/*`. */
export type BinaryTypes = `${string}/${string}` | readonly `${string}/${string}`[]

/** The body as ctx.input.binary carries it. */
export type BinaryBody<T extends string = string> = { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: T }

/** One declared type: an exact essence, or a `type/*` range. */
type Range = { readonly essence: string } | { readonly type: string }

/** A declared type as a range, or `null` when it is neither `type/subtype` nor `type/*` (no parameters). */
function rangeOf(declared: string): Range | null {
	const text = declared.trim().toLowerCase()
	if (text.includes(";")) return null
	if (text.endsWith("/*")) {
		const mt = parseMediaType(`${text.slice(0, -2)}/x`)
		return mt === null || mt.type === "*" ? null : { type: mt.type }
	}
	const mt = parseMediaType(text)
	return mt === null || mt.type === "*" ? null : { essence: mt.essence }
}

/** The declared types as ranges; one that is no media type or range throws, naming the route. */
export function binaryRanges(declared: BinaryTypes, method: string, path: string): readonly Range[] {
	return (typeof declared === "string" ? [declared] : declared).map((type) => {
		const range = rangeOf(type)
		if (range !== null) return range
		throw new Error(
			`${method} ${path} declares binary type ${JSON.stringify(type)}: a binary type is type/subtype or type/*.`,
		)
	})
}

/** The request's essence when a declared range takes it; anything else, none included, is a 415. */
export function binaryType(ranges: readonly Range[], contentType: string | null): string {
	const mt = parseMediaType(contentType)
	if (mt !== null && ranges.some((r) => ("essence" in r ? r.essence === mt.essence : r.type === mt.type)))
		return mt.essence
	throw new HoneyError({ errorKey: EK.unsupported_media_type, status: "unsupported_media_type" })
}

/** The body read once as bytes, with the media type it was sent as. */
export async function binaryInput(req: Request, type: string): Promise<BinaryBody> {
	return { bytes: new Uint8Array(await req.arrayBuffer()), type }
}
