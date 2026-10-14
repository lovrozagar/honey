/**
 * Problem Details (RFC 9457, A7), the opt-in error format: `app.errorFormat("problem+json")`. A
 * standard error answers as `application/problem+json`: its key as the `type` URI, the status's
 * reason phrase as `title`, the message as `detail`, the request id as `instance` when
 * `requestId()` set one, and its fields under the extension member `errors`, where no field can
 * stand in for a member. Vars and the cause stay server-side, as in the native envelope. A schema
 * error keeps its declared body.
 */
import type { HoneyError } from "./error.ts"

/** How errors answer: honey's envelope (the default) or RFC 9457 Problem Details. */
export type ErrorFormat = "honey" | "problem+json"

export const PROBLEM_JSON = "application/problem+json"

/* RFC 9110 §15.5–15.6 reason phrases (418 from RFC 2324), for every error status honey names */
const REASON: Readonly<Record<number, string>> = /* @__PURE__ */ Object.freeze({
	400: "Bad Request",
	401: "Unauthorized",
	402: "Payment Required",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	406: "Not Acceptable",
	407: "Proxy Authentication Required",
	408: "Request Timeout",
	409: "Conflict",
	410: "Gone",
	411: "Length Required",
	412: "Precondition Failed",
	413: "Content Too Large",
	414: "URI Too Long",
	415: "Unsupported Media Type",
	416: "Range Not Satisfiable",
	417: "Expectation Failed",
	418: "I'm a teapot",
	421: "Misdirected Request",
	422: "Unprocessable Content",
	423: "Locked",
	424: "Failed Dependency",
	425: "Too Early",
	426: "Upgrade Required",
	428: "Precondition Required",
	429: "Too Many Requests",
	431: "Request Header Fields Too Large",
	451: "Unavailable For Legal Reasons",
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
	505: "HTTP Version Not Supported",
	506: "Variant Also Negotiates",
	507: "Insufficient Storage",
	508: "Loop Detected",
	510: "Not Extended",
	511: "Network Authentication Required",
})

/** The Problem Details document for a standard error; `instance` is the request id, or `null`. */
export function problemDetails(error: HoneyError, instance: string | null): Record<string, unknown> {
	const doc: Record<string, unknown> = {
		detail: error.message,
		status: error.status,
		title: REASON[error.status] ?? error.statusKey,
		type: `https://honey.dev/errors/${error.errorKey}`,
	}
	if (instance !== null) doc.instance = instance
	if (Object.keys(error.fields).length > 0) doc.errors = error.fields
	return doc
}
