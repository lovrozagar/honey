import { type ClientError, clientErrorFor } from "./error.ts"
import { isJsonMediaType, isTextMediaType, parseMediaType } from "./media-type.ts"

/** A sent request: its answer, and how to release what it holds once the body is read. */
export type Sent = {
	done: () => void
	exemptFromTimeout: () => void
	response: Response
}

/** A safe-mode result: `error` is truthy for every non-2xx and always carries `status`. */
export type SafeResult = { data: unknown; error: unknown; response: Response; status: number }

export function isEventStream(response: Response): boolean {
	return parseMediaType(response.headers.get("content-type"))?.essence === "text/event-stream"
}

/** How a REST answer is read: thrown or as a result, parsed or raw, and which response headers to keep (A2). */
export type Reading = {
	/** the non-JSON media type the operation declares: its body is read as that type, empty or not */
	declared?: string
	headers?: readonly string[]
	maxMessage?: number
	method: string
	raw?: boolean
	shouldThrow: boolean
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

/** Read an error body: JSON when it parses, else the text, else null. Never throws on the body. */
async function readErrorBody(response: Response): Promise<unknown> {
	let text: string
	try {
		text = await response.text()
	} catch {
		/* an unreadable body still answers with its status */
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

/** The typed error a non-2xx answer becomes, its response kept readable. */
export async function errorFromResponse(response: Response, maxMessage = 512): Promise<ClientError> {
	const preserved = response.clone()
	const body = await readErrorBody(response)
	const message =
		typeof body === "object" && body !== null && "message" in body
			? (body as Record<string, unknown>).message
			: undefined
	const text =
		typeof message === "string" && message.length > 0 ? sanitizeMessage(message, maxMessage) : `HTTP ${response.status}`
	return clientErrorFor({ body, message: text, response: preserved, status: response.status })
}

/** The safe-mode error: the server's error object when the body is a JSON object, else the ClientError. */
function safeErrorValue(error: ClientError): unknown {
	const body = error.body
	return typeof body === "object" && body !== null && !Array.isArray(body) ? body : error
}

/** A body with no content to read: 204/205/304 and every answer to HEAD. */
function hasNoBody(response: Response, method: string): boolean {
	return response.status === 204 || response.status === 205 || response.status === 304 || method === "HEAD"
}

/**
 * A 2xx body as a value. A declared text or binary answer reads as that type, so an empty one is
 * `""` or zero bytes; otherwise by its content type: JSON parsed, text as text, anything else as
 * bytes (A1), and null when empty.
 */
export async function parseBody(response: Response, method: string, declared?: string): Promise<unknown> {
	if (hasNoBody(response, method.toUpperCase())) {
		await response.body?.cancel().catch(() => {
			/* nothing to read: a cancel that fails changes nothing */
		})
		return null
	}
	if (declared !== undefined) {
		if (isTextMediaType(parseMediaType(declared))) return response.text()
		return new Uint8Array(await response.arrayBuffer())
	}
	const type = parseMediaType(response.headers.get("content-type"))
	if (isJsonMediaType(type)) {
		const text = await response.text()
		if (text.length === 0) return null
		try {
			return JSON.parse(text)
		} catch {
			throw clientErrorFor({
				body: text,
				message: "Response body is not valid JSON",
				response,
				status: response.status,
			})
		}
	}
	if (isTextMediaType(type)) return response.text()
	const bytes = new Uint8Array(await response.arrayBuffer())
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

/** A safe-mode success, with the declared headers when the operation declares any. */
function success(data: unknown, response: Response, names: readonly string[] | undefined): SafeResult {
	const result: SafeResult = { data, error: null, response, status: response.status }
	if (names) Object.assign(result, { headers: declaredHeaders(response, names) })
	return result
}

/** Read the answer of a REST call into its value (throw mode), a result (safe mode), or the raw response. */
export async function finishRequest(sent: Sent, reading: Reading): Promise<unknown> {
	const { response } = sent
	const { method, shouldThrow } = reading
	try {
		if (!response.ok) {
			if (reading.raw && !shouldThrow) return response
			const error = await errorFromResponse(response, reading.maxMessage)
			if (shouldThrow) throw error
			return { data: null, error: safeErrorValue(error), response: error.response, status: response.status }
		}
		if (reading.raw) return response
		if (shouldThrow) return await parseBody(response, method, reading.declared)
		try {
			return success(await parseBody(response, method, reading.declared), response, reading.headers)
		} catch (e) {
			return { data: null, error: e, response, status: response.status }
		}
	} finally {
		sent.done()
	}
}
