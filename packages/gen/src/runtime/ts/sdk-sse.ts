import type { RequestMeta } from "./config.ts"
import { ClientError } from "./error.ts"
import { interpolatePath } from "./path.ts"
import type { RequestOptions } from "./request.ts"
import { type Answer, resultOf } from "./response.ts"
import { type OperationCall, optionsFor, type SdkCore, type ServiceEntry, templateOf } from "./sdk.ts"
import type { SSEEvent } from "./sse.ts"
import { later, openStream } from "./stream.ts"

/** Each event with its `data` parsed as JSON; an event that does not parse fails the stream, naming it. */
function jsonEvents(events: AsyncIterable<SSEEvent>): AsyncIterable<SSEEvent<unknown>> {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const event of events) {
				let data: unknown
				try {
					data = JSON.parse(event.data)
				} catch (e) {
					const name = event.id === undefined ? "an event" : `event ${JSON.stringify(event.id)}`
					const message = `SSE ${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
					throw new ClientError({ body: event.data, message, response: Response.error(), status: 0 })
				}
				yield { ...event, data }
			}
		},
	}
}

/** An SSE op opened: its stale view for the hooks, and its `x-invalidate` targets marked once the answer is ok. */
async function open(core: SdkCore, entry: ServiceEntry, input: RequestOptions): Promise<Answer> {
	const opts = optionsFor(entry, input)
	const template = templateOf(entry)
	let selector: string | undefined
	let meta: RequestMeta | undefined
	try {
		const path = interpolatePath(template, input.params)
		selector = `${entry.method} ${path}`
		meta = core.meta(selector, path, entry.method)
	} catch {
		/* a bad param fails the stream when it is sent, as for any call */
	}
	const onOpen = () => {
		if (selector !== undefined) core.mark(entry, input.params, selector)
	}
	const { data, response } = await openStream(core.http, { meta, method: entry.method, onOpen, opts, path: template })
	return { data: entry.sse === "json" ? jsonEvents(data) : data, response }
}

/** An event stream: sent when iterated, or opened into a Result by the safe twin. */
export const sseOp: OperationCall = (core, entry, safe) => {
	const opened = (input?: RequestOptions) => open(core, entry, input ?? {})
	return safe
		? (input?: RequestOptions) => resultOf(opened(input))
		: (input?: RequestOptions) => later(() => opened(input))
}
