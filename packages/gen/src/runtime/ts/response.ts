import { ClientError, clientErrorFor, DecodeError } from "./error.ts"
import { isJsonMediaType, isTextMediaType, parseMediaType } from "./media-type.ts"

/** A sent request: its answer, and how to release what it holds once the body is read. */
export type Sent = {
	done: () => void
	exemptFromTimeout: () => void
	/** a failed body read's error (noAnswer) */
	failed: (cause: unknown) => unknown
	response: Response
}

/** A REST call's answer: its value (the response itself when raw) and the response. */
export type Answer = { data: unknown; response: Response }

/** Object keys of `{ 400: ... }` are `400` or `"400"` depending on the TS version. */
export type StatusOf<K> = K extends number ? K : K extends `${infer N extends number}` ? N : never

/** 0 to N-1 as literals. */
type Upto<N extends number, A extends number[] = []> = A["length"] extends N ? A[number] : Upto<N, [...A, A["length"]]>

/** Each declared status's error, its body typed; the base ClientError at every other error status, 300 to 599. */
type StatusErrors<E> = [E] extends [never]
	? ClientError
	: [keyof E] extends [never]
		? ClientError
		:
				| { [K in keyof E]: ClientError<E[K]> & { readonly status: StatusOf<K> } }[keyof E]
				| (ClientError & { readonly status: Exclude<Exclude<Upto<600>, Upto<300>>, StatusOf<keyof E>> })

/** A safe call's outcome: its data (and declared headers), or the answer's error; the response on both. */
export type Result<T, TErrors = never, THeaders = never> =
	| ([THeaders] extends [never]
			? { ok: true; data: T; response: Response }
			: { ok: true; data: T; headers: THeaders; response: Response })
	| { ok: false; error: StatusErrors<TErrors> | DecodeError; response: Response }

export function isEventStream(response: Response): boolean {
	return parseMediaType(response.headers.get("content-type"))?.essence === "text/event-stream"
}

/** How a REST answer is read: parsed or raw, by its declared media type, within the client's limits. */
export type Reading = {
	/**
	 * the non-JSON media type the operation declares: its body is read as that type, empty or not.
	 * `null` when it declares no success body: whatever arrives is discarded and reads as null.
	 */
	declared?: string | null
	/** the client's limits: an error message's characters, and the bytes a body may hold decoded */
	limits?: Limits
	method: string
	raw?: boolean
}

/** A server's message as an Error may carry it: ASCII control characters stripped, `max` characters at most. */
function sanitizeMessage(message: string, max: number): string {
	let out = ""
	for (const ch of message) {
		const code = ch.charCodeAt(0)
		if (code > 31 && code !== 127) out += ch
	}
	return out.slice(0, max)
}

/** What a client bounds an answer to: its error message's characters, and its body's decoded bytes. */
export type Limits = { readonly maxErrorMessageChars?: number; readonly maxResponseBytes?: number }

/** The most bytes a body may hold, decoded, before its read is refused: 100 MiB, as every other SDK's. */
export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024

/** `response`'s body, read in the chunks it arrives in, refused past `max` decoded bytes with the body cancelled. */
async function bodyBytes(response: Response, max = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
	const reader = response.body?.getReader()
	if (reader === undefined) return new Uint8Array(0)
	const chunks: Uint8Array[] = []
	let size = 0
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		size += next.value.byteLength
		if (size > max) {
			/* not awaited: a cloned body's branch settles its cancel only once its twin cancels too */
			reader.cancel().catch(() => {
				/* the refusal stands whether or not the body cancels cleanly */
			})
			const sent = response.headers.get("content-length")
			const what = [response.headers.get("content-type") ?? "no content type", sent && `${sent} bytes`]
			const message = `Response body is over the ${max}-byte cap (${what.filter(Boolean).join(", ")})`
			throw new DecodeError({ body: null, message, response, status: response.status })
		}
		chunks.push(next.value)
	}
	const bytes = new Uint8Array(size)
	let at = 0
	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.byteLength
	}
	return bytes
}

/** `response`'s body as UTF-8 text, bounded as bodyBytes reads it. */
const bodyText = async (response: Response, max?: number) => new TextDecoder().decode(await bodyBytes(response, max))

/**
 * Read an error body: JSON when it parses, else the text, else null; one past `max` bytes reads as null, and its
 * `preserved` twin is cancelled with it, so the body's source stops.
 */
async function readErrorBody(response: Response, preserved: Response, max?: number): Promise<unknown> {
	let text: string
	try {
		text = await bodyText(response, max)
	} catch {
		/* an unreadable body still answers with its status */
		preserved.body?.cancel().catch(() => {
			/* the twin may already be gone */
		})
		return null
	}
	if (text.length === 0) return null
	try {
		return JSON.parse(text)
	} catch {
		/* not JSON: the text itself is the body */
		return text
	}
}

/** The typed error a non-2xx answer becomes, its response kept readable, its body and message bounded by `limits`. */
export async function errorFromResponse(response: Response, limits: Limits = {}): Promise<ClientError> {
	const preserved = response.clone()
	const body = await readErrorBody(response, preserved, limits.maxResponseBytes)
	const message =
		typeof body === "object" && body !== null && "message" in body
			? (body as Record<string, unknown>).message
			: undefined
	const text =
		typeof message === "string" && message.length > 0
			? `HTTP ${response.status}: ${sanitizeMessage(message, limits.maxErrorMessageChars ?? 512)}`
			: `HTTP ${response.status}`
	return clientErrorFor({ body, message: text, response: preserved, status: response.status })
}

/** A body with no content to read: 204/205/304 and every answer to HEAD. */
function hasNoBody(response: Response, method: string): boolean {
	return response.status === 204 || response.status === 205 || response.status === 304 || method === "HEAD"
}

/**
 * A 2xx body as a value. An operation declaring no body (`declared` null) reads as null, as a 204
 * does. A declared text or binary answer reads as that type, so an empty one is `""` or zero bytes;
 * otherwise by its content type: JSON parsed, text as text, anything else as bytes (A1), and null
 * when empty.
 */
export async function parseBody(
	response: Response,
	method: string,
	declared?: string | null,
	max?: number,
): Promise<unknown> {
	if (declared === null || hasNoBody(response, method.toUpperCase())) {
		await response.body?.cancel().catch(() => {
			/* nothing to read: a cancel that fails changes nothing */
		})
		return null
	}
	if (declared !== undefined) {
		if (isTextMediaType(parseMediaType(declared))) return bodyText(response, max)
		return bodyBytes(response, max)
	}
	const type = parseMediaType(response.headers.get("content-type"))
	if (isJsonMediaType(type)) {
		const text = await bodyText(response, max)
		if (text.length === 0) return null
		try {
			return JSON.parse(text)
		} catch (cause) {
			const message = "Response body is not valid JSON"
			throw new DecodeError({ body: text, cause, message, response, status: response.status })
		}
	}
	if (isTextMediaType(type)) return bodyText(response, max)
	const bytes = await bodyBytes(response, max)
	return bytes.byteLength === 0 ? null : bytes
}

/** The declared response headers (A2), by lower-case name, each one only when the answer carries it. */
function declaredHeaders(response: Response, names: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const name of names) {
		const value = response.headers.get(name)
		if (value !== null) out[name] = value
	}
	return out
}

/**
 * A REST answer read into its value, or the response itself when raw. A non-2xx throws its ClientError, an
 * undecodable 2xx DecodeError, and a body read that fails no answer (f2).
 */
export async function finishRequest(sent: Sent, reading: Reading): Promise<Answer> {
	const { response } = sent
	try {
		if (!response.ok) throw await errorFromResponse(response, reading.limits)
		if (reading.raw) return { data: response, response }
		const max = reading.limits?.maxResponseBytes
		return { data: await parseBody(response, reading.method, reading.declared, max), response }
	} catch (e) {
		throw e instanceof ClientError ? e : sent.failed(e)
	} finally {
		sent.done()
	}
}

/** `answer` as a safe call's Result (bit 21 i): an answer's error its Err; no answer, or none sent, thrown (f2). */
export async function resultOf(answer: Promise<Answer>, names?: readonly string[]): Promise<Result<unknown>> {
	try {
		const { data, response } = await answer
		const ok: Result<unknown> = { data, ok: true, response }
		return names ? Object.assign(ok, { headers: declaredHeaders(response, names) }) : ok
	} catch (e) {
		if (e instanceof ClientError && e.status !== 0) return { error: e, ok: false, response: e.response }
		throw e
	}
}
