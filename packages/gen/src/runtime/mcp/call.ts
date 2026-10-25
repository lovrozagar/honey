/**
 * A tool's call through the API's TS SDK (bit 18): each tool as tools.gen.ts describes it, bound to the SDK client in
 * safe mode. Its arguments pass guard.ts first, else nothing is sent. They go back into the SDK's input groups (each
 * parameter under its own name: path, query or header; the body as JSON, a form, base64-decoded bytes at most 1 MiB, or
 * text, a raw body under its content type), the SDK member the operation sits at is called with the session's abort,
 * and its answer becomes the tool's result as result.ts shapes it, scrubbed of the API key; an event stream's, the
 * collect stream.ts runs.
 */
import { redactor, refusal } from "./guard.ts"
import { type Answer, BYTES_MAX, failureOf, json, successOf, unanswered } from "./result.ts"
import type { Tool } from "./server.ts"
import { collected } from "./stream.ts"

/** The SDK input group a parameter goes in. */
export type Group = "params" | "search" | "headers"

/** One tool as tools.gen.ts holds it: what tools/list shows, and how each argument reaches the SDK's input. */
export type ToolSpec = {
	readonly name: string
	readonly description?: string
	readonly inputSchema: Record<string, unknown>
	/** the SDK member the operation sits at, key by key from the client */
	readonly member: readonly string[]
	/** each parameter argument: its property, its SDK input group, the parameter's own name */
	readonly args: readonly (readonly [property: string, group: Group, name: string])[]
	/** the body argument's property, how it is sent, and a raw body's content type, when the operation takes a body */
	readonly body?: readonly [property: string, field: "json" | "form" | "bytes" | "text", contentType?: string]
	readonly outputSchema?: Record<string, unknown>
	/** whether structuredContent wraps the answer as `{result, headers}` */
	readonly wrap?: true
	readonly annotations?: Record<string, boolean>
	/** an event stream's collect: its `max_events` and `last_event_id` properties */
	readonly collect?: readonly [max: string, lastEventId: string]
}

/** How tools call: the key to scrub, a call's bound in ms, and a collect's own client, whose answer runs `seen`. */
export type Binding = {
	readonly secret: string
	readonly timeout: number
	readonly opening: (seen: () => void) => SdkClient
}

/* canonical base64: whole quads, the last one padded */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** The SDK client a tool drives: its members walked key by key to the operation's method. */
export type SdkClient = object

/** The SDK input `args` make for `spec`: each parameter in its group, the body in its field; or why it cannot be sent. */
function inputOf(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> | string {
	const input: Record<string, Record<string, unknown>> = { headers: {}, params: {}, search: {} }
	for (const [property, group, name] of spec.args) {
		const value = args[property]
		if (value !== undefined)
			(input[group] as Record<string, unknown>)[name] = group === "headers" ? String(value) : value
	}
	if (spec.body === undefined || args[spec.body[0]] === undefined) return input
	const [property, field, contentType] = spec.body
	const value = args[property]
	if (field === "json" || field === "form") return { ...input, [field]: value }
	;(input.headers as Record<string, unknown>)["content-type"] = contentType
	if (field === "text") return { ...input, body: value }
	if (!BASE64.test(String(value))) return `Invalid arguments: ${property} is not base64`
	const bytes = Buffer.from(String(value), "base64")
	return bytes.byteLength > BYTES_MAX
		? `Invalid arguments: ${property} is past the ${BYTES_MAX}-byte cap`
		: { ...input, body: bytes }
}

/** The method at `member` on `client`, with the object it is called on. */
function methodAt(client: SdkClient, member: readonly string[]): [owner: unknown, method: unknown] {
	let owner: unknown = client
	let method: unknown = client
	for (const key of member) {
		owner = method
		method = (method as Record<string, unknown>)[key]
	}
	return [owner, method]
}

/** `specs` as tools calling `client` (in safe mode) as `binding` says, every result scrubbed of the API key. */
export function bindTools(specs: readonly ToolSpec[], client: SdkClient, binding: Binding): Tool[] {
	const scrub = redactor(binding.secret)
	return specs.map((spec) => ({
		call: async (args, signal, progress) => {
			const paths = spec.args.filter(([, group]) => group === "params").map(([property]) => property)
			const input = refusal(spec.inputSchema, paths, args) ?? inputOf(spec, args)
			if (typeof input === "string") return json(scrub({ message: input }), true)
			let opened = false
			const [owner, method] = methodAt(spec.collect ? binding.opening(() => (opened = true)) : client, spec.member)
			const send = (more: object) => (method as (input: unknown) => unknown).call(owner, { ...input, ...more })
			try {
				if (spec.collect)
					return await collected(spec.collect, args, send, {
						opened: () => opened,
						progress,
						scrub,
						signal,
						timeout: binding.timeout,
					})
				const answer = (await send({ signal })) as Answer
				return answer.status >= 200 && answer.status < 300 ? successOf(spec, answer, scrub) : failureOf(answer, scrub)
			} catch (error) {
				const status = (error as { status?: unknown } | null)?.status
				return typeof status === "number" ? failureOf({ data: null, error, status }, scrub) : unanswered(error, scrub)
			}
		},
		...(spec.description === undefined ? {} : { description: spec.description }),
		inputSchema: spec.inputSchema,
		...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
		...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
		name: spec.name,
	}))
}
