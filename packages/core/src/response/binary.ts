/**
 * The bytes `ctx.res.binary()` answers: what it takes, the media type it answers them as, and the
 * header map it starts from. Bytes are a type contract (F8): never parsed, never validated.
 */
import type { ResponseOptions } from "./response.ts"

/** The bytes a binary answer carries. */
export type BinaryBody = ArrayBuffer | Uint8Array<ArrayBuffer>

/** `ctx.res.binary()`'s options: the media type (`application/octet-stream` by default) beside the usual ones. */
export type BinaryOptions<CT extends string = string> = ResponseOptions & { contentType?: CT }

/* frozen: the Node path hands the map to the bag as its header map */
export const BINARY_HEADERS = /* @__PURE__ */ Object.freeze({ "content-type": "application/octet-stream" })

/** `body` as a Uint8Array: the same one, or a view over an ArrayBuffer, never a copy. */
export function binaryBytes(body: BinaryBody): Uint8Array<ArrayBuffer> {
	return body instanceof Uint8Array ? body : new Uint8Array(body)
}

/** The header map an answer of `contentType` starts from. */
export function binaryHeaders(contentType: string | undefined): Readonly<Record<string, string>> {
	return contentType === undefined ? BINARY_HEADERS : { "content-type": contentType }
}
