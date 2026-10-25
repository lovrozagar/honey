/**
 * A tool's call through the API's TS SDK (bit 18): each tool as tools.gen.ts describes it, bound to the SDK client. Its
 * flat arguments go back into the SDK's input groups (each parameter under its own name: path, query or header; the
 * body as JSON or a form), the SDK member the operation sits at is called, and its answer comes back as JSON text. A
 * failed the SDK raises is the tool's own result, `isError`, its message and status.
 */
import type { Tool, ToolResult } from "./server.ts"

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
	/** the body argument's property and the SDK input field it fills, when the operation takes a body */
	readonly body?: readonly [property: string, field: "json" | "form"]
}

/** The SDK client a tool drives: its members walked key by key to the operation's method. */
export type SdkClient = object

/** A result of one text block. */
const text = (value: string, isError?: true): ToolResult => ({
	content: [{ text: value, type: "text" }],
	...(isError ? { isError } : {}),
})

/** The SDK input `args` make for `spec`: each parameter in its group, the body in its field. */
function inputOf(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
	const input: Record<string, Record<string, unknown>> = { headers: {}, params: {}, search: {} }
	for (const [property, group, name] of spec.args) {
		const value = args[property]
		if (value !== undefined)
			(input[group] as Record<string, unknown>)[name] = group === "headers" ? String(value) : value
	}
	if (spec.body === undefined) return input
	const [property, field] = spec.body
	return args[property] === undefined ? input : { ...input, [field]: args[property] }
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

/** A failed as the tool reports it: its message, and the status of an answer outside 2xx. */
function failed(error: unknown): ToolResult {
	const status = (error as { status?: unknown } | null)?.status
	const message = error instanceof Error ? error.message : String(error)
	return text(JSON.stringify(typeof status === "number" ? { message, status } : { message }), true)
}

/** `specs` as tools calling `client`. */
export function bindTools(specs: readonly ToolSpec[], client: SdkClient): Tool[] {
	return specs.map((spec) => ({
		call: async (args) => {
			const [owner, method] = methodAt(client, spec.member)
			try {
				const data: unknown = await (method as (input: unknown) => Promise<unknown>).call(owner, inputOf(spec, args))
				return text(JSON.stringify(data ?? null))
			} catch (error) {
				return failed(error)
			}
		},
		...(spec.description === undefined ? {} : { description: spec.description }),
		inputSchema: spec.inputSchema,
		name: spec.name,
	}))
}
