/**
 * The MCP target's runner (bit 18 phase f; its own module since bit 21 b, so each era's client runs it from the
 * project its toolchain belongs to): every `cellsFor("mcp")` cell through the MCP server `generateMcpServer` emits from
 * the spawned reference app's served document, driven by one official client session per cell, the session's first
 * step asserting the revision it runs under. A call is its tool (the operation's, by name), its parameters as the
 * tool's flat arguments, its body as `body` (bytes as base64), `take` and `lastEventId` as the collect's `max_events`
 * and `last_event_id`; the setup reaches it as the server's environment (the bearer as $CONFORMANCE_API_KEY). The observation is read from the result: the status from `_meta`
 * (honey/status), the data from structuredContent (a wrapped answer's `result` and `headers`) or the text, bytes from
 * a resource or image block, an error from an isError result's text, a stream from the collect's events. An MCP-only
 * row reads the server instead: its tool names, annotations, outputSchemas, tokens, or a result's content. Bit 21 d:
 * over HTTP, the same server serves `--http` on a port the OS picks, `MCP_TOKEN` its bearer, and every cell runs the
 * same; each LACKS reason holds there too, since the MCP request's own headers reach no API call (no passthrough).
 * Bit 21 e: `mcpMountedRunner` runs the grid against the handler the plugin writes, mounted in the reference app itself
 * at /v1/mcp; each call dispatches in-process, and the cell's credential is the MCP request's own header, which the
 * mount carries in, the headers its schemes name alone. MOUNTED_LACKS says per cell what that changes.
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { HttpTarget, Step, Stepped } from "../../../src/emit/mcp/__fixtures__/steps.ts"
import { written } from "../../../src/emit/mcp/__fixtures__/written.ts"
import { generateMcpHandler } from "../../../src/emit/mcp/mounted.ts"
import { generateMcpServer } from "../../../src/emit/mcp/server.ts"
import { isTool, toolsOf, type ToolSpec } from "../../../src/emit/mcp/tools.ts"
import { toIR, type OpenApiDocument } from "../../../src/ir/build.ts"
import { countTokens } from "../../../scripts/capture-token-budget.ts"
import { type ReferenceApp, startReferenceApp, type TargetRunner } from "./harness.ts"
import type { Call, Cell, Json, Observed } from "./matrix.ts"

/** The reference app's server: its variables' prefix. */
const PREFIX = "CONFORMANCE"

/** The bearer every HTTP session sends, $CONFORMANCE_MCP_TOKEN to the server. */
export const MCP_TOKEN = "conformance-mcp-token"

/**
 * The cells the MCP server has no way to express, by design, each with its reason: a tool takes its operation's
 * arguments alone, and the server's environment is every call's configuration.
 */
const LACKS: Readonly<Record<string, string>> = {
	"auth/cross-origin-redirect-drops":
		"its operation declares no success body, so the tool's result is null where the followed echo answers JSON; the redirect, followed with the credentials dropped, is config.test's (bit 19 g)",
	"json-status/realtime-send-non-ascii": "a realtime operation is no tool: the server has no realtime send (bit 18 e)",
	"json-status/realtime-send-raw-text": "a realtime operation is no tool: the server has no realtime send (bit 18 e)",
	"overrides/base-url": "a tool has no per-call base URL: the server's $<PREFIX>_BASE_URL is every call's",
	"overrides/headers":
		"a tool takes no per-call header beyond its operation's declared parameters, and over HTTP the MCP request's own headers reach no API call",
	"overrides/timeout": "a tool has no per-call timeout: the server's $<PREFIX>_TIMEOUT_MS is every call's",
	"raw-response/status-headers-body": "a tool returns its answer's data, never the raw response (Q11)",
	"reconnect/ws-reconnect-token": "a WebSocket is no tool (bit 18 e)",
	"reconnect/refusal-terminal": "a realtime operation is no tool: the server has no reconnect loop to end (bit 18 e)",
	"reconnect/refusal-mixed-retries":
		"a realtime operation is no tool: the server has no reconnect loop to retry (bit 18 e)",
	"request-id/explicit": "x-request-id is no declared parameter of the operation, so no tool argument (Q11)",
	"typed-errors/validation-400":
		"its name breaks the declared minLength 3, which the guard refuses on this target before anything is sent, naming it (bit 19 c, constraints.test)",
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
	/* a failed step is no empty list: read as one, the token ceilings would hold on nothing */
	if (stepped.failed !== undefined) throw new Error(`the client failed: ${stepped.failed}`)
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

/** The environment a cell's setup gives the server: the API, the bearer as its key, its headers and redirect policy. */
function setupEnv(cell: Cell, app: ReferenceApp): string[] {
	const setup = cell.setup
	const headers = {
		...setup?.headers,
		...(setup?.auth?.kind === "header" ? { [setup.auth.name]: setup.auth.value } : {}),
	}
	return [
		`${PREFIX}_BASE_URL=${app.url}`,
		...(setup?.auth?.kind === "bearer" ? [`${PREFIX}_API_KEY=${setup.auth.token}`] : []),
		...(Object.keys(headers).length === 0 ? [] : [`${PREFIX}_HEADERS=${JSON.stringify(headers)}`]),
		...(setup?.redirect === undefined ? [] : [`${PREFIX}_REDIRECT=${setup.redirect}`]),
		...(setup?.timeoutMs === undefined ? [] : [`${PREFIX}_TIMEOUT_MS=${setup.timeoutMs}`]),
	]
}

/** One client's session against a server command: each step's outcome, as clients.ts reports them. */
export type Session = (command: readonly string[], steps: readonly Step[]) => Promise<readonly Stepped[]>

/**
 * The MCP runner for a client's `session`: the reference app's server generated and written once from the served
 * document. A call it cannot express throws, and the cell is red, never skipped; only LACKS are left out, each with
 * its reason. Every session first reports its revision, and one under another revision than `era` fails the cell.
 * With `http`, the server serves `--http` on a port the OS picks, its token MCP_TOKEN, and the session connects to it.
 */
export function mcpRunner(session: Session, era: string, variant?: string, http = false): TargetRunner {
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
			const command = [
				"env",
				...setupEnv(cell, app),
				...(http ? [`${PREFIX}_MCP_TOKEN=${MCP_TOKEN}`] : []),
				process.execPath,
				join(dir, "dist", "server.js"),
				...(http ? ["--http", "--port", "0"] : []),
			]
			const [ran, ...stepped] = await session(command, [{ negotiated: true }, ...steps])
			if (ran?.negotiated !== era) throw new Error(`the session ran under ${JSON.stringify(ran)}, not ${era}`)
			return cell.calls.map((call, i) => {
				const one = stepped[i] ?? { failed: "no step" }
				if (call.mcp !== undefined) return readOf(call.mcp, one)
				return observedOf(one, specs.get(call.operation) as ToolSpec)
			})
		},
		target: "mcp",
		...(variant === undefined ? {} : { variant }),
	}
}

/**
 * The cells the mounted endpoint has no way to express, each with its reason. Every call carries the MCP request's
 * credential in process, so a header cell runs where its header is the scheme's; the rest is the app's to decide.
 */
const MOUNTED_LACKS: Readonly<Record<string, string>> = {
	...LACKS,
	"auth/api-key-on-origin":
		"a mount carries the SDK's own credential header and the headers its tools' security schemes name, no other; the reference document declares no security scheme, so Authorization is the one header carried and x-api-key never reaches the call. It runs once that document declares an apiKey scheme in the x-api-key header, which every target shares",
	"auth/cross-origin-redirect-drops":
		"its operation declares no success body, so the tool's result is null where the followed echo answers JSON; a mount follows no redirect off the app's origin (same-origin), and a call off it is refused before dispatch (emit-adversarial.mcp-mount)",
	"overrides/base-url": "a mount's calls go to its own app alone, in process: there is no other base URL",
	"overrides/headers":
		"a tool takes no per-call header beyond its operation's declared parameters, and a mount carries only the credential headers its schemes name",
	"overrides/timeout": "a tool has no per-call timeout: the handler's 30 s bound is every call's",
}

/** The MCP request's own headers for a cell: its credential, and its headers as a client would send them. */
function mountHeaders(cell: Cell): Record<string, string> {
	const setup = cell.setup
	return {
		...setup?.headers,
		...(setup?.auth?.kind === "header" ? { [setup.auth.name]: setup.auth.value } : {}),
		...(setup?.auth?.kind === "bearer" ? { authorization: `Bearer ${setup.auth.token}` } : {}),
	}
}

/** One client's session over Streamable HTTP against a URL, every request carrying the target's headers. */
export type HttpSession = (target: HttpTarget, steps: readonly Step[]) => Promise<readonly Stepped[]>

/**
 * The MCP runner against the reference app with the handler the plugin writes mounted in it (bit 21 e): the app is
 * started once for its document, the handler generated from it, then started again mounting it at /v1/mcp. `session`
 * runs each cell over Streamable HTTP, its first step reporting the revision (bit 21 h: any client's, Python's too).
 */
export function mcpMountedRunner(session: HttpSession, era: string, variant: string): TargetRunner {
	let specs = new Map<string, ToolSpec>()
	return {
		lacks: (cell) => Object.hasOwn(MOUNTED_LACKS, cell.key),
		async prepare(app) {
			specs = specsOf(app.document)
		},
		async run(cell, app) {
			const steps = cell.calls.map((call) => stepOf(call, specs))
			const target = { headers: mountHeaders(cell), url: `${app.url}/v1/mcp` }
			const [ran, ...stepped] = await session(target, [{ negotiated: true }, ...steps])
			if (ran?.negotiated !== era) throw new Error(`the session ran under ${JSON.stringify(ran)}, not ${era}`)
			return cell.calls.map((call, i) => {
				const one = stepped[i] ?? { failed: "no step" }
				if (call.mcp !== undefined) return readOf(call.mcp, one)
				return observedOf(one, specs.get(call.operation) as ToolSpec)
			})
		},
		async start() {
			const plain = await startReferenceApp()
			const { document } = plain
			await plain.stop()
			const { entry, files } = generateMcpHandler(document)
			const dir = written({
				"mcp.gen.ts": entry,
				...Object.fromEntries(Object.entries(files).map(([name, text]) => [`mcp/${name}`, text])),
			})
			return startReferenceApp({ HONEY_CONFORMANCE_MCP: join(dir, "mcp.gen.ts") })
		},
		target: "mcp",
		variant,
	}
}
