/**
 * W3C trace context, level 1 (G1). `traceparent` parses strictly: lowercase hex, version `00` is
 * exactly 55 chars, a later version is read by its first 55 chars when a dash or nothing follows,
 * `ff` and all-zero ids are invalid. `tracestate` is kept only whole: every member valid, no key
 * twice, at most 32 members and 512 chars. Whether an inbound trace is continued is the hop's trust
 * (`InboundTrust`, b1): a trusted hop's valid trace is continued, an untrusted one's only linked, a
 * malformed one ignored.
 */
import type { InboundTrust } from "../middleware/request-id.ts"

/** A trace's ids as `traceparent` carries them. */
export type TraceIds = { readonly flags: number; readonly spanId: string; readonly traceId: string }

/** A span in another process: its ids and, on a continued trace, its `tracestate`. */
export type RemoteContext = TraceIds & { readonly state: string | undefined }

/** The inbound trace: continued (the remote is the root's parent) or linked; `null` when there is none. */
export type Inbound = { readonly continued: boolean; readonly remote: RemoteContext } | null

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ZERO_TRACE = "00000000000000000000000000000000"
const ZERO_SPAN = "0000000000000000"

export function parseTraceparent(header: string | null): TraceIds | null {
	if (header === null || header.length < 55) return null
	const version = header.slice(0, 2)
	/* a later version may append fields after a dash; version 00 may not */
	if (header.length > 55 && (version === "00" || header.charCodeAt(55) !== 45)) return null
	const match = TRACEPARENT.exec(header.slice(0, 55))
	if (match === null || version === "ff") return null
	const [, , traceId, spanId, flags] = match as unknown as [string, string, string, string, string]
	if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null
	return { flags: Number.parseInt(flags, 16), spanId, traceId }
}

export function formatTraceparent(ids: TraceIds): string {
	return `00-${ids.traceId}-${ids.spanId}-${(ids.flags & 0xff).toString(16).padStart(2, "0")}`
}

/* a simple key, or a multi-tenant `tenant@system` key */
const MEMBER_KEY = /^(?:[a-z][_0-9a-z*/-]{0,255}|[a-z0-9][_0-9a-z*/-]{0,240}@[a-z][_0-9a-z*/-]{0,13})$/
/* printable ASCII but `,` and `=`, not ending in a space */
const MEMBER_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/

/** The `tracestate` to carry on, normalized, or `undefined` when any of it is invalid. */
export function parseTracestate(header: string | null): string | undefined {
	if (header === null || header.length > 512) return undefined
	const kept: string[] = []
	const keys = new Set<string>()
	for (const raw of header.split(",")) {
		const member = raw.trim()
		if (member === "") continue
		const eq = member.indexOf("=")
		const key = member.slice(0, eq)
		if (eq === -1 || !MEMBER_KEY.test(key) || !MEMBER_VALUE.test(member.slice(eq + 1)) || keys.has(key)) {
			return undefined
		}
		keys.add(key)
		kept.push(member)
	}
	return kept.length === 0 || kept.length > 32 ? undefined : kept.join(",")
}

/** Does `trust` let this hop decide the trace? A predicate that throws does not: it is reported. */
function trusted(
	trust: InboundTrust,
	source: { readonly ip: string | null; readonly req: Request },
	report: (error: unknown) => void,
): boolean {
	if (typeof trust !== "function") return trust
	try {
		return trust(source)
	} catch (error) {
		report(error)
		return false
	}
}

/**
 * The trace `source`'s request arrived in, as `trust` lets it count. The predicate runs only for a
 * valid `traceparent`, and an untrusted hop's `tracestate` stays behind.
 */
export function inboundTrace(
	source: { readonly ip: string | null; readonly req: Request },
	trust: InboundTrust,
	report: (error: unknown) => void,
): Inbound {
	const ids = parseTraceparent(source.req.headers.get("traceparent"))
	if (ids === null) return null
	if (!trusted(trust, source, report)) return { continued: false, remote: { ...ids, state: undefined } }
	return { continued: true, remote: { ...ids, state: parseTracestate(source.req.headers.get("tracestate")) } }
}
