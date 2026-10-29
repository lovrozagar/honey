/**
 * A tool's call through the API's TS SDK (bit 18): each tool as tools.gen.ts describes it, bound to the SDK client's
 * safe twin (bit 21 i1), a collect to the client's own stream. Its arguments pass guard.ts first, else nothing is
 * sent. They go back into the SDK's input groups (each parameter under its own name: path, query or header; the body
 * as JSON, a form, base64-decoded bytes at most 1 MiB, or text, a raw body under its content type), the SDK member the
 * operation sits at is called with the session's abort, and its Result becomes the tool's result as result.ts shapes
 * it, scrubbed of the API key; an event stream's, the collect stream.ts runs. Bit 21 c: a multipart form's parts are arguments, sent as multipart whether or not a file is.
 * Bit 21 g: data-less FileInputs are staged first (files.ts), an input request or a refusal the answer.
 */
import { decoded, type Files, fileOf, staged } from "./files.ts"
import { redactor, refusal } from "./guard.ts"
import { type Answer, BYTES_MAX, failureOf, json, successOf, unanswered } from "./result.ts"
import type { Outcome, Tool } from "./protocol.ts"
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
	/** a multipart form's parts: property, name in the form, kind */
	readonly parts?: readonly (readonly [property: string, name: string, kind: "text" | "file" | "files"])[]
}

/**
 * How tools call: the secrets to scrub, a call's bound in ms, a collect's own client, whose answer runs `seen`, and the
 * inline file bytes a call may carry.
 */
export type Binding = {
	readonly secrets: readonly string[]
	readonly timeout: number
	readonly opening: (seen: () => void) => SdkClient
	readonly inline?: number
}

/** The SDK client a tool drives: its members walked key by key to the operation's method. */
export type SdkClient = { readonly safe: object }

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
	const bytes = decoded(String(value))
	if (bytes === undefined) return `Invalid arguments: ${property} is not base64`
	return bytes.byteLength > BYTES_MAX
		? `Invalid arguments: ${property} is past the ${BYTES_MAX}-byte cap`
		: { ...input, body: bytes }
}

/**
 * `input` with `args`' form as its multipart body, each file uploaded, read, fetched or decoded; else the answer. An
 * input with no parts, or a refusal, is as it came.
 */
async function formed(
	input: Record<string, unknown> | string,
	spec: ToolSpec,
	args: Record<string, unknown>,
	files: Files & { readonly signal: AbortSignal; readonly cap: number; left: number },
) {
	if (typeof input === "string" || spec.parts === undefined) return input
	const items = spec.parts.flatMap(([property, name, kind]) =>
		[args[property] ?? []].flat().map((item, at) => {
			const label = `${property}${kind === "files" ? `[${at}]` : ""}`
			return [label, name, kind === "text" ? undefined : (item as Record<string, unknown>), item] as const
		}),
	)
	const values = items.flatMap(([label, , file]) => (file ? [[label, file] as const] : []))
	const taken = await staged(spec.name, args, values, files)
	if (!(taken instanceof Map)) return taken
	const form = new FormData()
	for (const [label, name, value, item] of items) {
		const file = value && (await fileOf(value, { ...files, taken }, files))
		if (typeof file === "string") return `Invalid arguments: ${label} ${file}`
		if (file)
			form.append(name, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name ?? name)
		else form.append(name, typeof item === "string" ? item : JSON.stringify(item))
	}
	/* fetch's own multipart encoding, its boundary in the content type */
	const encoded = new Response(form)
	const headers = { ...(input.headers as object), "content-type": encoded.headers.get("content-type") }
	return { ...input, body: new Uint8Array(await encoded.arrayBuffer()), headers }
}

/** The method at `member` on `client`, with the object it is called on. */
function methodAt(client: object, member: readonly string[]): [owner: unknown, method: unknown] {
	let owner: unknown = client
	let method: unknown = client
	for (const key of member) {
		owner = method
		method = (method as Record<string, unknown>)[key]
	}
	return [owner, method]
}

/** `specs` as tools calling `client.safe` as `binding` says, every result scrubbed of the secrets. */
export function bindTools(specs: readonly ToolSpec[], client: SdkClient, binding: Binding): Tool[] {
	const scrub = redactor(binding.secrets)
	return specs.map((spec) => ({
		call: async (args, signal, progress, files) => {
			const paths = spec.args.filter(([, group]) => group === "params").map(([property]) => property)
			const cap = binding.inline ?? BYTES_MAX
			const input = await formed(refusal(spec.inputSchema, paths, args) ?? inputOf(spec, args), spec, args, {
				...files,
				cap,
				left: cap,
				signal,
			})
			if (typeof input === "string") return json(scrub({ message: input }), true)
			if ("inputRequired" in input || "invalid" in input) return input as Outcome
			let opened = false
			const [owner, method] = methodAt(spec.collect ? binding.opening(() => (opened = true)) : client.safe, spec.member)
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
				const { status } = answer.response
				if (answer.ok) return { ...successOf(spec, answer, scrub), _meta: { "honey/status": status } }
				/* an error status's JSON object body speaks for it, any other answer its error */
				const { body } = answer.error as { body?: unknown }
				const error = body && typeof body === "object" && !Array.isArray(body) ? body : answer.error
				return { ...failureOf({ error, status }, scrub), _meta: { "honey/status": status } }
			} catch (error) {
				const status = (error as { status?: unknown } | null)?.status
				return typeof status === "number"
					? { ...failureOf({ error, status }, scrub), _meta: { "honey/status": status } }
					: unanswered(error, scrub)
			}
		},
		...(spec.description === undefined ? {} : { description: spec.description }),
		inputSchema: spec.inputSchema,
		...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
		...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
		name: spec.name,
	}))
}
