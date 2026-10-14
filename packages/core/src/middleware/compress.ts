/**
 * `compress()`: encode a buffered answer as br or gzip, by the client's `Accept-Encoding` (q-values
 * honored, br preferred on a tie, br only where the runtime's `CompressionStream` has it). The
 * edge may already compress (Cloudflare does); this is for the origin that answers directly.
 *
 * It encodes only the raw body the answer was built from, never reading or cloning its stream, so
 * a produced stream (sse, stream, generate) or a foreign response is passed through as it is. It
 * leaves alone: an empty, partial or 304 answer; one already encoded; `Cache-Control:
 * no-transform`; a type that does not compress; a body under `threshold`.
 *
 * BREACH: compressed length leaks a secret in a body that also reflects attacker input. By default
 * an answer to a credentialed request (a `Cookie` or `Authorization`) or one that sets a cookie is
 * not compressed; `credentialed: true` opts in.
 */
import { isHoneyResponse, rawBodyOf, replaceResponse, type RawBody, withRawBody } from "../response/builder.ts"
import { addVary, withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type CompressOptions = {
	/** Compress answers to credentialed requests and answers that set a cookie. Default `false` (BREACH). */
	credentialed?: boolean
	/** The smallest body compressed, in bytes (characters, for a text body). Default 1024. */
	threshold?: number
}

type Encoding = "br" | "gzip"

/* text, JSON, XML, JavaScript and SVG compress; images, archives and media are compressed already */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|[\w.-]+\+(?:json|xml))$|image\/svg\+xml$)/
const NO_TRANSFORM = /(?:^|,)\s*no-transform\s*(?:,|$)/i

function essenceOf(contentType: string | null): string {
	const text = contentType ?? ""
	const semi = text.indexOf(";")
	return (semi === -1 ? text : text.slice(0, semi)).trim().toLowerCase()
}

/** The q-value `accept` gives `coding`, by name or through `*`; 0 when neither is listed. */
function qualities(accept: string): Map<string, number> {
	const q = new Map<string, number>()
	for (const item of accept.split(",")) {
		const [name, ...params] = item.split(";") as [string, ...string[]]
		const weight = params.map((param) => param.trim()).find((param) => param.startsWith("q="))
		const value = weight === undefined ? 1 : Number(weight.slice(2))
		q.set(name.trim().toLowerCase(), Number.isFinite(value) ? value : 0)
	}
	return q
}

function negotiate(accept: string | null, brotli: boolean): Encoding | null {
	if (accept === null) return null
	const q = qualities(accept)
	const any = q.get("*") ?? 0
	const br = brotli ? (q.get("br") ?? any) : 0
	const gzip = q.get("gzip") ?? any
	if (br <= 0 && gzip <= 0) return null
	return br >= gzip ? "br" : "gzip"
}

/** Whether this runtime's CompressionStream encodes brotli (Node 22+, Bun; not every runtime). */
function hasBrotli(): boolean {
	try {
		return Boolean(new CompressionStream("brotli" as CompressionFormat))
	} catch {
		/* the answer, not a failure: this runtime has no brotli, so gzip it is */
		return false
	}
}

function compressible(response: Response, threshold: number, raw: RawBody): boolean {
	/* the size first: most answers are small JSON, and it costs no header lookup */
	if ((typeof raw === "string" ? raw.length : raw.byteLength) < threshold) return false
	const status = response.status
	if (status < 200 || status === 204 || status === 206 || status === 304) return false
	const headers = response.headers
	if (headers.has("content-encoding") || headers.has("content-range")) return false
	if (NO_TRANSFORM.test(headers.get("cache-control") ?? "")) return false
	return COMPRESSIBLE.test(essenceOf(headers.get("content-type")))
}

async function encode(raw: RawBody, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> {
	const format = (encoding === "br" ? "brotli" : "gzip") as CompressionFormat
	const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream(format))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

export function compress(options: CompressOptions = {}): MiddlewareFn<{ readonly req: Request }> {
	const { credentialed = false, threshold = 1024 } = options
	if (!(Number.isFinite(threshold) && threshold >= 0)) {
		throw new TypeError("compress: threshold must be a finite number of bytes, 0 or more")
	}
	const brotli = hasBrotli()
	return namedMiddleware("compress", async (ctx, next) => {
		const response = await next()
		const raw = rawBodyOf(response)
		/* no raw body: a produced stream or a foreign response, never buffered here */
		if (raw === null || !compressible(response, threshold, raw)) return response
		const req = ctx.req
		const secret =
			!credentialed &&
			(req.headers.has("cookie") || req.headers.has("authorization") || response.headers.has("set-cookie"))
		const encoding = secret ? null : negotiate(req.headers.get("accept-encoding"), brotli)
		if (encoding === null) return withHeaders(response, (headers) => addVary(headers, "accept-encoding"))
		const bytes = await encode(raw, encoding)
		const encoded = replaceResponse(response, { body: bytes })
		if (!isHoneyResponse(encoded)) withRawBody(encoded, bytes)
		return withHeaders(encoded, (headers) => {
			headers.set("content-encoding", encoding)
			headers.delete("content-length")
			addVary(headers, "accept-encoding")
		})
	})
}
