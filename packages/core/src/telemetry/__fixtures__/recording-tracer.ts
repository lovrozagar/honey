/**
 * A structural Tracer that records every span it starts: its name, kind, explicit parent, links,
 * attributes, events, status and how many times it ended. `recording: false` samples every root out.
 */
import type { Span, SpanOptions, Telemetry } from "../request-trace.ts"
import type { RemoteContext } from "../traceparent.ts"

export type Recorded = Span & {
	attributes: Record<string, unknown>
	ended: number
	events: [string, Record<string, unknown> | undefined][]
	kind: SpanOptions["kind"]
	links: readonly RemoteContext[]
	name: string
	parent: Recorded | RemoteContext | null
	status: number | undefined
}

/** A tracer that records every span it starts; `recording: false` samples every root out. */
export function recorder(options: { recording?: boolean } = {}) {
	const spans: Recorded[] = []
	let next = 0
	const startSpan = (name: string, { attributes, kind, links, parent }: SpanOptions): Span => {
		const id = (++next).toString(16).padStart(16, "0")
		const span: Recorded = {
			addEvent(event, attrs) {
				span.events.push([event, attrs])
			},
			attributes: { ...attributes },
			end() {
				span.ended++
			},
			ended: 0,
			events: [],
			isRecording: () => options.recording ?? true,
			kind,
			links,
			name,
			parent: parent as Recorded | RemoteContext | null,
			setAttribute(key, value) {
				span.attributes[key] = value
			},
			setStatus(status) {
				span.status = status.code
			},
			spanContext: () => ({ spanId: id, traceFlags: 1, traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }),
			status: undefined,
			updateName(renamed) {
				span.name = renamed
			},
		}
		spans.push(span)
		return span
	}
	const telemetry: Telemetry = { onError: null, tracer: { startSpan }, trustInbound: false }
	return { spans, telemetry }
}

/** Each span as `parent > name`, in start order: the tree, flat. */
export function tree(spans: readonly Recorded[]): string[] {
	return spans.map((s) => `${s.parent !== null && "name" in s.parent ? s.parent.name : "-"} > ${s.name}`)
}

/** The root a span hangs from. */
export function rootOf(span: Recorded): Recorded | undefined {
	let at: Recorded = span
	while (at.parent !== null && "name" in at.parent) at = at.parent
	return at
}
