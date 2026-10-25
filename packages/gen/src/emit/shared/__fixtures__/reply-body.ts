/**
 * A recording server's reply bodies (bit 16 phase c2): a reply's payload, its encoding (gzip, deflate, and since bit 19
 * b1 brotli and zstd, whole or as it flows), its length or none when streamed, and the headers it goes out with. A `bytes` body is streamed in 64 KiB
 * chunks, so a 512 MiB answer never exists whole in any heap (recording-server.ts holds the replies).
 */
import { Readable } from "node:stream"
import {
	brotliCompressSync,
	constants,
	createBrotliCompress,
	createDeflate,
	createGzip,
	createZstdCompress,
	deflateSync,
	gzipSync,
	zstdCompressSync,
} from "node:zlib"
import type { Reply, RecordedHop } from "./recording-server.ts"

/** Both listeners' origins, by the name a hop and a redirect give them. */
export type Origins = Readonly<Record<RecordedHop["origin"], string>>

/** The bytes of a `bytes` body, `i & 0xff` in 64 KiB chunks: each chunk starts at a multiple of 256, so the offsets hold. */
function* patternChunks(size: number): Generator<Buffer> {
	const block = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i & 0xff))
	for (let sent = 0; sent < size; sent += block.length) yield block.subarray(0, Math.min(block.length, size - sent))
}

/** The reply's body and the headers it implies: JSON with its content-type, bytes streamed, text as it is. */
function payloadOf(reply: Reply): [Buffer | Readable | string, Record<string, string>] {
	if (reply.json !== undefined) return [JSON.stringify(reply.json), { "content-type": "application/json" }]
	if (reply.bytes !== undefined) return [Readable.from(patternChunks(reply.bytes)), {}]
	if (reply.gzipped !== undefined) return [reply.gzipped, { "content-encoding": "gzip" }]
	return [reply.text ?? "", {}]
}

const BROTLI = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }

/** A content coding a reply can carry: its streaming coder and its whole one. */
type Coding = "br" | "deflate" | "gzip" | "zstd"
const CODERS = {
	/* quality 4: the default 11 takes seconds a megabyte, and a bomb needs ratio, not density */
	br: [() => createBrotliCompress(BROTLI), (input: Buffer | string) => brotliCompressSync(input, BROTLI)],
	deflate: [createDeflate, deflateSync],
	gzip: [createGzip, gzipSync],
	zstd: [createZstdCompress, zstdCompressSync],
} as const

/** The payload under its encoding: a buffer or string coded whole, a stream coded as it flows. */
function encodedOf(payload: Buffer | Readable | string, encoding: Coding | undefined) {
	if (encoding === undefined) return payload
	const [streaming, whole] = CODERS[encoding]
	return payload instanceof Readable ? payload.pipe(streaming()) : whole(payload)
}

/** The reply's body and every header it goes out with: its length (none when streamed), the implied ones, its encoding, a redirect's. */
export function messageOf(reply: Reply, origins: Origins): [Buffer | Readable | string, Record<string, string>] {
	const [payload, implied] = payloadOf(reply)
	const encoding: Coding | undefined = reply.gzip
		? "gzip"
		: reply.deflate
			? "deflate"
			: reply.brotli
				? "br"
				: reply.zstd
					? "zstd"
					: undefined
	const body = encodedOf(payload, encoding)
	const length: Record<string, string> =
		body instanceof Readable ? {} : { "content-length": String(Buffer.byteLength(body)) }
	const coded: Record<string, string> = encoding === undefined ? {} : { "content-encoding": encoding }
	const location: Record<string, string> = reply.redirect
		? { location: `${origins[reply.redirect.origin]}${reply.redirect.path}` }
		: {}
	return [body, { ...length, ...implied, ...coded, ...location, ...reply.headers }]
}
