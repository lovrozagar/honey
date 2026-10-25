/**
 * The MCP target of the conformance grid (bit 18 phase f): every `cellsFor("mcp")` cell through the MCP server
 * `generateMcpServer` emits from the spawned reference app's served document, driven by the official
 * @modelcontextprotocol/sdk 1.32.2 client (the pinned fixture), one client session per cell. A call is its tool (the
 * operation's, by name), its parameters as the tool's flat arguments, its body as `body` (bytes as base64), `take` and
 * `lastEventId` as the collect's `max_events` and `last_event_id`; the setup reaches it as the server's environment
 * (the bearer as $CONFORMANCE_API_KEY). The observation is read from the result: the status from `_meta`
 * (honey/status), the data from structuredContent (a wrapped answer's `result` and `headers`) or the text, bytes from
 * a resource or image block, an error from an isError result's text, a stream from the collect's events. An MCP-only
 * row reads the server instead: its tool names, annotations, outputSchemas, tokens, or a result's content.
 * Opt-in: `vitest run --mode harness`.
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import { describe } from "vitest"
import { clientSession, type Step, type Stepped, withClients } from "../../../src/emit/mcp/__fixtures__/clients.ts"
import { written } from "../../../src/emit/mcp/__fixtures__/written.ts"
import { generateMcpServer } from "../../../src/emit/mcp/server.ts"
import { isTool, toolsOf, type ToolSpec } from "../../../src/emit/mcp/tools.ts"
import { toIR, type OpenApiDocument } from "../../../src/ir/build.ts"
import { countTokens } from "../../../scripts/capture-token-budget.ts"
import { type ReferenceApp, type TargetRunner, targetSuite } from "./harness.ts"
import type { Call, Cell, Json, Observed } from "./matrix.ts"

/** The reference app's server: its variables' prefix. */
const PREFIX = "CONFORMANCE"

/**
 * The cells the MCP server has no way to express, by design, each with its reason: a tool takes its operation's
 * arguments alone, and the server's environment is every call's configuration.
 */
const LACKS: Readonly<Record<string, string>> = {
	"auth/api-key-on-origin":
		"the server's one credential is $<PREFIX>_API_KEY under the spec's scheme; it takes no other header (bits/19)",
	"auth/cross-origin-redirect-drops":
		"the server has no header or redirect configuration; it follows no cross-origin redirect (result.test pins it)",
	"overrides/base-url": "a tool has no per-call base URL: the server's $<PREFIX>_BASE_URL is every call's",
	"overrides/headers": "a tool takes no per-call header beyond its operation's declared parameters",
	"overrides/timeout": "a tool has no per-call timeout: the server's $<PREFIX>_TIMEOUT_MS is every call's",
	"raw-response/status-headers-body": "a tool returns its answer's data, never the raw response (Q11)",
	"reconnect/ws-reconnect-token": "a WebSocket is no tool (bit 18 e)",
	"request-id/explicit": "x-request-id is no declared parameter of the operation, so no tool argument (Q11)",
	"verbs/reference-request":
		"its path value holds a `/`, which H18.11 refuses on this target before anything is sent (emit-adversarial.mcp)",
}

/** Every tool spec by its operation id. */
function specsOf(document: Record<string, unknown>): Map<string, ToolSpec> {
	const ir = toIR(document as OpenApiDocument, { deriveOperationIds: true })
	const ops = ir.operations.filter(isTool)
	return new Map(toolsOf(ir).map((spec, i) => [ops[i]?.id ?? "", spec]))
}

/** The property of `spec` that parameter `name` of `group` fills (a header case-insensitively), or a throw. */
function propertyOf(spec: ToolSpec, group: string, name: string): string {
	const found = spec.args.find(([, g, param]) => g === group && param.toLowerCase() === name.toLowerCase())
	if (found === undefined) throw new Error(`${spec.name}: no argument for the ${group} parameter ${name}`)
	return found[0]
}

/** A call's parameters as tool arguments, each under the property its parameter fills. */
function paramsOf(call: Call, spec: ToolSpec): Record<string, unknown> {
	if (call.origin !== undefined || call.raw !== undefined || call.timeoutMs !== undefined)
		throw new Error(`${call.operation}: a per-call override is no tool argument`)
	if (call.reconnectToken !== undefined || call.send !== undefined) throw new Error(`${call.operation}: no ws tools`)
	const args: Record<string, unknown> = {}
	for (const [name, value] of Object.entries(call.params ?? {})) args[propertyOf(spec, "params", name)] = value
	for (const [name, value] of Object.entries(call.search ?? {})) args[propertyOf(spec, "search", name)] = value
	for (const [name, value] of Object.entries(call.headers ?? {})) args[propertyOf(spec, "headers", name)] = value
	return args
}

/** A call's tool arguments; a part of the call no tool argument can carry throws, and the cell is red. */
function argumentsOf(call: Call, spec: ToolSpec): Record<string, unknown> {
	const args = paramsOf(call, spec)
	if (call.body !== undefined) {
		if (spec.body === undefined) throw new Error(`${spec.name}: no body argument`)
		args[spec.body[0]] =
			call.body.kind === "json"
				? call.body.value
				: Buffer.from(Array.from({ length: call.body.size }, (_, i) => i & 0xff)).toString("base64")
	}
	if (call.take !== undefined || call.lastEventId !== undefined) {
		if (spec.collect === undefined) throw new Error(`${spec.name}: no collect`)
		if (call.take !== undefined) args[spec.collect[0]] = call.take
		if (call.lastEventId !== undefined) args[spec.collect[1]] = call.lastEventId
	}
	return args
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** A result's content, each block's bytes as their digest and size. */
const contentOf = (result: Record<string, unknown>): Json =>
	(result.content as Record<string, unknown>[]).map((block) => {
		const resource = block.resource as { blob?: string; mimeType: string; uri: string } | undefined
		const base64 = resource?.blob ?? (block.data as string | undefined)
		if (base64 === undefined) return block as Json
		const bytes = Buffer.from(base64, "base64")
		const { blob: _, ...rest } = resource ?? { mimeType: block.mimeType as string }
		return { ...rest, sha256: sha256(bytes), size: bytes.length, type: block.type as string } as Json
	})

/** An isError result as the grid observes it: the API's error by status and key, or a timeout. */
function failureOf(result: Record<string, unknown>): Observed {
	const text = (result.content as [{ text: string }])[0].text
	const error = JSON.parse(text) as { body?: Json; error_key?: string; kind?: string; status?: number }
	if (error.kind === "timeout") return { kind: "timeout" }
	/* the grid has no kind for a call that got no answer: a status of 0, keyed by its kind, fails any cell that has one */
	if (error.status === undefined) return { errorKey: error.kind ?? null, kind: "error", status: 0 }
	return {
		errorKey: error.error_key ?? null,
		kind: "error",
		status: error.status,
		...(error.body === undefined ? {} : { body: error.body }),
	}
}

/** One shared call's result as the grid observes it. */
function observedOf(stepped: Stepped, spec: ToolSpec): Observed {
	if (stepped.failed !== undefined) throw new Error(`${spec.name}: the client failed: ${stepped.failed}`)
	const result = stepped.result as Record<string, unknown>
	if (result.isError === true) return failureOf(result)
	if (spec.collect !== undefined) {
		const structured = result.structuredContent as { events?: never } | undefined
		return { events: structured?.events ?? [], kind: "events" }
	}
	return successOf(result, spec)
}

/** A 2xx result as the grid observes it: its status from `_meta`, bytes, or data with a wrapped answer's headers. */
function successOf(result: Record<string, unknown>, spec: ToolSpec): Observed {
	const structured = result.structuredContent as Record<string, Json> | undefined
	const status = (result._meta as { "honey/status": number })["honey/status"]
	const [block] = result.content as Record<string, unknown>[]
	if (block?.type === "resource" || block?.type === "image" || block?.type === "audio") {
		const [bytes] = contentOf(result) as { sha256: string; size: number }[]
		return { kind: "bytes", sha256: bytes?.sha256 ?? "", size: bytes?.size ?? 0, status }
	}
	if (structured === undefined)
		return { data: JSON.parse((block as { text: string }).text) as Json, kind: "data", status }
	return dataOf(structured, spec, status)
}

/** A structured answer as the grid's data: a wrapped answer's `result`, and its `headers` when it has them. */
function dataOf(structured: Record<string, Json>, spec: ToolSpec, status: number): Observed {
	if (!spec.wrap) return { data: structured, kind: "data", status }
	const headers = structured.headers as Record<string, string> | undefined
	return { data: structured.result ?? null, kind: "data", status, ...(headers === undefined ? {} : { headers }) }
}

/** What an MCP-only read observes of the tools listed or of a call's result. */
function readOf(read: NonNullable<Call["mcp"]>, stepped: Stepped): Observed {
	const tools = stepped.tools ?? []
	const byName = new Map(tools.map((tool) => [tool.name as string, tool]))
	switch (read.read) {
		case "names":
			return { kind: "mcp", value: tools.map((tool) => tool.name as string).sort() }
		case "tokens":
			return {
				kind: "mcp",
				value: {
					largest: Math.max(...tools.map((tool) => countTokens(JSON.stringify(tool)))),
					total: countTokens(JSON.stringify({ tools })),
				},
			}
		case "annotations":
		case "outputSchema":
			return {
				kind: "mcp",
				value: Object.fromEntries(read.tools.map((name) => [name, (byName.get(name)?.[read.read] ?? null) as Json])),
			}
		case "content":
			return { kind: "mcp", value: contentOf(stepped.result as Record<string, unknown>) }
	}
}

/** The step a call takes: a listing for an MCP-only read of the tools, else a call of its tool. */
function stepOf(call: Call, specs: Map<string, ToolSpec>): Step {
	if (call.mcp !== undefined && call.mcp.read !== "content") return { list: true }
	const spec = specs.get(call.operation)
	if (spec === undefined) throw new Error(`no tool for the operation ${call.operation}`)
	return { call: { arguments: argumentsOf(call, spec), name: spec.name } }
}

/** The environment a cell's setup gives the server: the API, and the bearer as its key. */
function setupEnv(cell: Cell, app: ReferenceApp): string[] {
	const setup = cell.setup
	if (setup?.headers !== undefined || setup?.redirect !== undefined || setup?.auth?.kind === "header")
		throw new Error(`${cell.key}: the server has no header or redirect configuration`)
	return [
		`${PREFIX}_BASE_URL=${app.url}`,
		...(setup?.auth?.kind === "bearer" ? [`${PREFIX}_API_KEY=${setup.auth.token}`] : []),
		...(setup?.timeoutMs === undefined ? [] : [`${PREFIX}_TIMEOUT_MS=${setup.timeoutMs}`]),
	]
}

/**
 * The MCP runner: the reference app's server generated and written once from the served document. A call it cannot
 * express throws, and the cell is red, never skipped; only LACKS are left out, each with its reason.
 */
function mcpRunner(): TargetRunner {
	let dir = ""
	let specs = new Map<string, ToolSpec>()
	return {
		lacks: (cell) => Object.hasOwn(LACKS, cell.key),
		async prepare(app) {
			dir = written(generateMcpServer(app.document, { envPrefix: PREFIX, name: "conformance" }).files)
			specs = specsOf(app.document)
		},
		async run(cell, app) {
			const steps = cell.calls.map((call) => stepOf(call, specs))
			const command = ["env", ...setupEnv(cell, app), process.execPath, join(dir, "dist", "server.js")]
			const stepped = await clientSession("sdk", command, steps)
			return cell.calls.map((call, i) => {
				const one = stepped[i] ?? { failed: "no step" }
				if (call.mcp !== undefined) return readOf(call.mcp, one)
				return observedOf(one, specs.get(call.operation) as ToolSpec)
			})
		},
		target: "mcp",
	}
}

describe.skipIf(!withClients())("mcp clients", () => {
	targetSuite(mcpRunner())
})
