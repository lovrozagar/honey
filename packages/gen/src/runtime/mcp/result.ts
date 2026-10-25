/**
 * A tool's result (bit 18 phase d, D1), from the TS SDK's safe-mode answer: JSON as text, and as structuredContent
 * when the tool has an outputSchema; text as text; bytes as image, audio or an embedded resource, past 1 MiB a note.
 * A failure is `isError`: an answer outside 2xx its status and error, no answer `transport` or `timeout`. Text is cut
 * past 100,000 characters, a note saying so.
 */
import type { ToolResult } from "./server.ts"

/** The most characters a result's text holds. */
export const TEXT_MAX = 100_000

/** The most bytes a result or a body argument holds. */
export const BYTES_MAX = 1 << 20

/** The TS SDK's safe-mode answer to a call. */
export type Answer = {
	readonly data: unknown
	readonly error: unknown
	readonly status: number
	readonly response?: Response
	readonly headers?: Readonly<Record<string, string>>
}

/** A result of one text block, cut at TEXT_MAX. */
export const text = (value: string, isError?: true): ToolResult => ({
	content: [
		{
			text:
				value.length > TEXT_MAX
					? `${value.slice(0, TEXT_MAX)}\n[cut: ${TEXT_MAX} of ${value.length} characters]`
					: value,
			type: "text",
		},
	],
	...(isError ? { isError } : {}),
})

/** A result of `value` as JSON text. */
export const json = (value: unknown, isError?: true): ToolResult => text(JSON.stringify(value ?? null), isError)

/** `bytes` of the media type `type` as the tool's content: an image, audio, or an embedded resource. */
function bytesResult(bytes: Uint8Array, type: string, tool: string): ToolResult {
	const mimeType = type.split(";")[0]?.trim().toLowerCase() || "application/octet-stream"
	if (bytes.byteLength > BYTES_MAX)
		return text(`[${mimeType}, ${bytes.byteLength} bytes: past the ${BYTES_MAX}-byte cap]`)
	const data = Buffer.from(bytes).toString("base64")
	const kind = mimeType.split("/")[0]
	return {
		content: [
			kind === "image" || kind === "audio"
				? { data, mimeType, type: kind }
				: { resource: { blob: data, mimeType, uri: `honey://${tool}/result` }, type: "resource" },
		],
	}
}

/** A scrubber of the API key from a value's strings (guard.ts `redactor`). */
type Scrub = (value: unknown) => unknown

/** The result of a 2xx `answer` for `tool`, structured as its outputSchema says, scrubbed by `scrub`. */
export function successOf(
	tool: { name: string; outputSchema?: object; wrap?: true },
	answer: Answer,
	scrub: Scrub,
): ToolResult {
	const data = answer.data instanceof Uint8Array ? answer.data : scrub(answer.data)
	if (data instanceof Uint8Array)
		return bytesResult(data, answer.response?.headers.get("content-type") ?? "", tool.name)
	if (tool.outputSchema === undefined) return typeof data === "string" ? text(data) : json(data)
	const value = tool.wrap ? { result: data, ...(answer.headers ? { headers: scrub(answer.headers) } : {}) } : data
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return json({ message: "The API answered something other than the object its schema declares" }, true)
	return { ...json(value), structuredContent: value as Record<string, unknown> }
}

/** The result of an `answer` outside 2xx: its status, with honey's error envelope its key and message, else its body. */
export function failureOf({ error, status }: Answer, scrub: Scrub): ToolResult {
	if (error instanceof Error)
		return json(scrub({ status, message: error.message, body: (error as { body?: unknown }).body }), true)
	const { error_key, message } = (error ?? {}) as { error_key?: unknown; message?: unknown }
	const value =
		typeof error_key === "string"
			? { status, error_key, message }
			: { status, message: `The API answered ${status}`, body: error }
	return json(scrub(value), true)
}

/** The result of a call that got no answer, `error` what it threw: a timeout, else a transport failure. */
export function unanswered(error: unknown, scrub: Scrub): ToolResult {
	const message = error instanceof Error ? error.message : String(error)
	const kind = (error as { name?: unknown } | null)?.name === "TimeoutError" ? "timeout" : "transport"
	return json(scrub({ kind, message }), true)
}
