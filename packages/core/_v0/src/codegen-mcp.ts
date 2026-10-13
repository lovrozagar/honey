/* MCP server code generator.
 *
 * Which operations become tools, their ids, their place in the TypeScript SDK and their parameter
 * set come from the IR the TypeScript SDK is built from, so a tool always calls a method that
 * exists. Only the JSON Schema of each parameter and JSON body is copied from the document,
 * verbatim and with refs inlined: a tool's input contract is JSON Schema, and the IR keeps less
 * than JSON Schema says (lengths, patterns, formats), which tool validation needs. */

import { readFileSync } from "node:fs"
import type { OpenApiSpecInput } from "./codegen.ts"
import { sdkMemberPaths } from "./codegen.ts"
import { bodiesOf, toIR } from "./codegen-ir.ts"
import { isJsonMedia } from "./codegen-sdk-model.ts"

type MCPOptions = {
	projectName: string
	sdkPackageName: string
	sdkClassName: string
	version?: string
}

type MCPResult = {
	files: Record<string, string>
}

type MCPOp = {
	operationId: string
	method: string
	path: string
	summary?: string
	description?: string
	parameters: Array<Record<string, unknown>>
	bodySchema: Record<string, unknown> | undefined
	bodyRequired: boolean
	toolName: string
	pathSegments: string[]
}

type SpecRecord = Record<string, unknown>

const TEMPLATE_FILE_NAMES = ["server.ts", "types.ts"] as const
const TEMPLATE_CACHE = new Map<string, string>()

function loadMCPRuntimeTemplates(): Map<string, string> {
	if (TEMPLATE_CACHE.size > 0) return TEMPLATE_CACHE
	for (const name of TEMPLATE_FILE_NAMES) {
		const url = new URL(`./client-mcp/${name}`, import.meta.url)
		TEMPLATE_CACHE.set(name, readFileSync(url, "utf8"))
	}
	return TEMPLATE_CACHE
}

function envVarNames(projectName: string): { apiKey: string; baseUrl: string } {
	const upper = projectName.toUpperCase()
	return { apiKey: `${upper}_API_KEY`, baseUrl: `${upper}_BASE_URL` }
}

function toSnakeCase(id: string): string {
	/* camelCase + dots -> snake_case. "createUser" -> "create_user",
	 * "docs.extract" -> "docs_extract", "docs.listAll" -> "docs_list_all". */
	return id
		.replace(/\./g, "_")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
		.toLowerCase()
}

/** Follow a `$ref` chain to a concrete schema. A chain that loops back on itself is an error. */
/** MCP tool names: `^[a-zA-Z0-9_-]{1,64}$`. */
const MAX_TOOL_NAME = 64

function sanitizeToolName(name: string): string {
	return (
		name
			.replace(/[^A-Za-z0-9_-]+/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "") || "tool"
	)
}

/** Deterministic, sanitized, unique tool names; a collision is an error naming both operations. */
function assignToolNames(ops: MCPOp[], projectName: string): void {
	const byName = new Map<string, string>()
	for (const op of ops) {
		let name = sanitizeToolName(`${projectName}_${toSnakeCase(op.operationId)}`)
		if (name.length > MAX_TOOL_NAME) {
			let hash = 0
			for (let i = 0; i < op.operationId.length; i++) hash = (Math.imul(hash, 31) + op.operationId.charCodeAt(i)) >>> 0
			const suffix = `_${hash.toString(36)}`
			name = `${name.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`
		}
		const other = byName.get(name)
		if (other !== undefined) {
			throw new Error(
				`MCP codegen: operations ${JSON.stringify(other)} and ${JSON.stringify(op.operationId)} both map to tool ${JSON.stringify(name)}`,
			)
		}
		byName.set(name, op.operationId)
		op.toolName = name
	}
}

function resolveSchema(spec: SpecRecord, schema: SpecRecord | undefined): SpecRecord | undefined {
	let cur: SpecRecord | undefined = schema
	const chain = new Set<string>()
	while (cur && typeof cur.$ref === "string") {
		const ref = cur.$ref
		if (chain.has(ref))
			throw new Error(`MCP codegen: $ref cycle with no schema in between: ${[...chain, ref].join(" -> ")}`)
		chain.add(ref)
		if (!ref.startsWith("#/")) return undefined
		let next: unknown = spec
		for (const raw of ref.slice(2).split("/")) {
			const part = raw.replace(/~1/g, "/").replace(/~0/g, "~")
			if (next === null || typeof next !== "object" || !Object.hasOwn(next, part)) return undefined
			next = (next as SpecRecord)[part]
		}
		cur = next as SpecRecord | undefined
	}
	return cur
}

/* Inlining expands each $ref; a schema graph with many shared refs can grow exponentially,
   so the output size is bounded and the generator fails loudly instead of hanging. */
const MAX_INLINED_NODES = 50_000

type InlineState = {
	/** Fully expanded refs whose expansion did not cut a cycle, with their size in nodes. */
	memo: Map<string, { nodes: number; schema: SpecRecord | undefined }>
	nodes: number
}

function charge(state: InlineState, nodes: number): void {
	state.nodes += nodes
	if (state.nodes > MAX_INLINED_NODES) {
		throw new Error(`MCP codegen: inlined tool schema exceeds ${MAX_INLINED_NODES} nodes (deeply shared $refs)`)
	}
}

function deepResolveSchema(
	spec: SpecRecord,
	schema: SpecRecord | undefined,
	seen: Set<string> = new Set(),
	state: InlineState = { memo: new Map(), nodes: 0 },
): { cut: boolean; schema: SpecRecord | undefined } {
	if (!schema) return { cut: false, schema: undefined }
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref
		/* a self-referential schema becomes an open object at the point it recurs */
		if (seen.has(ref)) {
			charge(state, 1)
			return { cut: true, schema: { type: "object" } }
		}
		/* a memoized expansion is emitted again in full, so it costs its full size again */
		const memo = state.memo.get(ref)
		if (memo) {
			charge(state, memo.nodes)
			return { cut: false, schema: memo.schema }
		}
		const next = new Set(seen)
		next.add(ref)
		const before = state.nodes
		const result = deepResolveSchema(spec, resolveSchema(spec, schema), next, state)
		if (!result.cut) state.memo.set(ref, { nodes: state.nodes - before, schema: result.schema })
		return result
	}
	charge(state, 1)
	let cut = false
	const out: SpecRecord = {}
	for (const [k, v] of Object.entries(schema)) {
		if (v === null || v === undefined) {
			out[k] = v
		} else if (Array.isArray(v)) {
			out[k] = v.map((item) => {
				if (item === null || typeof item !== "object") return item
				const r = deepResolveSchema(spec, item as SpecRecord, seen, state)
				cut ||= r.cut
				return r.schema
			})
		} else if (typeof v === "object") {
			const r = deepResolveSchema(spec, v as SpecRecord, seen, state)
			cut ||= r.cut
			out[k] = r.schema
		} else {
			out[k] = v
		}
	}
	return { cut, schema: out }
}

function inline(spec: SpecRecord, schema: SpecRecord | undefined): SpecRecord | undefined {
	return deepResolveSchema(spec, schema).schema
}

/** Declared parameters of an operation: its own, then the path item's it does not override. */
function declaredParameters(op: SpecRecord, pathItem: SpecRecord, spec: SpecRecord): SpecRecord[] {
	const own = ((op.parameters as unknown[] | undefined) ?? []).map((p) => resolveSchema(spec, p as SpecRecord) ?? {})
	const shared = ((pathItem.parameters as unknown[] | undefined) ?? []).map(
		(p) => resolveSchema(spec, p as SpecRecord) ?? {},
	)
	const out = [...own]
	for (const p of shared) if (!out.some((d) => d.name === p.name && d.in === p.in)) out.push(p)
	return out
}

function collectMCPOps(spec: OpenApiSpecInput): MCPOp[] {
	/* the ids, tree and member names the TypeScript SDK derives; its schemas are not needed here */
	const ir = toIR(spec, { deriveOperationIds: true, duplicateOperationIds: "throw" })
	const members = sdkMemberPaths(ir)
	const specRec = spec as unknown as SpecRecord
	const ops: MCPOp[] = []

	for (const irOp of ir.operations) {
		const ext = irOp.extensions
		if (ext.mcp !== true) continue
		/* skip websocket / realtime / SSE operations — MCP is request/response only */
		if (ext.websocket || ext.realtime || ext.sse) continue

		const pathItem = (spec.paths?.[irOp.path] ?? {}) as SpecRecord
		const op = (pathItem[irOp.method.toLowerCase()] ?? {}) as SpecRecord
		const requestBody = resolveSchema(specRec, op.requestBody as SpecRecord | undefined)
		const content = requestBody?.content as Record<string, SpecRecord> | undefined
		/* the JSON body the SDK's `json` input sends: the first JSON media type, as the SDK picks it */
		const jsonBody = bodiesOf(irOp).find((b) => b.kind === "raw" && isJsonMedia(b.contentType))

		ops.push({
			bodyRequired: jsonBody?.required === true,
			bodySchema: jsonBody ? (content?.[jsonBody.contentType]?.schema as SpecRecord | undefined) : undefined,
			description: irOp.description,
			method: irOp.method,
			operationId: irOp.id,
			parameters: declaredParameters(op, pathItem, specRec),
			path: irOp.path,
			pathSegments: members.get(irOp.id) ?? irOp.id.split("."),
			summary: irOp.summary,
			toolName: "",
		})
	}

	return ops
}

type ParamGroup = { props: SpecRecord; required: string[] }

const FORBIDDEN_HEADER_ARGS = new Set(["authorization", "cookie", "proxy-authorization"])

function emptyParamGroup(): ParamGroup {
	return { props: {}, required: [] }
}

function assignGroup(properties: SpecRecord, required: string[], key: string, group: ParamGroup): void {
	if (Object.keys(group.props).length === 0) return
	const out: SpecRecord = { properties: group.props, type: "object" }
	if (group.required.length > 0) {
		out.required = group.required
		required.push(key)
	}
	properties[key] = out
}

function buildToolInputSchema(op: MCPOp, spec: OpenApiSpecInput): SpecRecord {
	const properties: SpecRecord = {}
	const required: string[] = []
	const specRec = spec as unknown as SpecRecord

	const path = emptyParamGroup()
	const query = emptyParamGroup()
	const header = emptyParamGroup()
	const groupByLoc: Record<string, ParamGroup> = { header, path, query }

	for (const raw of op.parameters) {
		const p = resolveSchema(specRec, raw) ?? {}
		const name = p.name as string
		const inLoc = p.in as string
		const group = Object.hasOwn(groupByLoc, inLoc) ? groupByLoc[inLoc] : undefined
		if (!group || typeof name !== "string") continue
		/* credentials come from the server's config, never from tool arguments */
		if (inLoc === "header" && FORBIDDEN_HEADER_ARGS.has(name.toLowerCase())) continue
		group.props[name] = inline(specRec, (p.schema ?? {}) as SpecRecord) ?? {}
		if (p.required === true) group.required.push(name)
	}

	assignGroup(properties, required, "params", path)
	assignGroup(properties, required, "search", query)
	assignGroup(properties, required, "headers", header)

	if (op.bodySchema) {
		properties.json = inline(specRec, op.bodySchema) ?? { type: "object" }
		if (op.bodyRequired) required.push("json")
	}

	const schema: SpecRecord = { properties, type: "object" }
	if (required.length > 0) schema.required = required
	return schema
}

/** Keys a tool may forward to the SDK, per argument group; everything else is dropped. */
function allowedArgs(inputSchema: SpecRecord): Record<string, string[] | true> {
	const out: Record<string, string[] | true> = {}
	const props = inputSchema.properties as Record<string, SpecRecord>
	for (const group of ["params", "search", "headers"]) {
		const g = props[group]
		if (g) out[group] = Object.keys((g.properties as SpecRecord | undefined) ?? {}).sort()
	}
	if (props.json) out.json = true
	return out
}

/** Text safe inside a block comment. */
function commentText(text: string): string {
	return text.replace(/\*\//g, "*\\/").replace(/[\r\n]+/g, " ")
}

function buildToolsGen(ops: MCPOp[], spec: OpenApiSpecInput, projectName: string): string {
	const l: string[] = []
	l.push(`/* Generated by honey codegen-mcp.ts — do not edit by hand. */`)
	l.push(``)
	l.push(`import { callTool, type AllowedArgs } from "./_runtime"`)
	l.push(`import type { Tool } from "./types"`)
	l.push(``)
	l.push(`export function buildTools(sdk: Record<string, unknown>): Tool[] {`)
	/* callTool validates the arguments against inputSchema, forwards only declared keys, and
	   walks the SDK by operationId segments: ["checkout", "sessions", "create"]. */
	l.push(
		`\tconst tool = (name: string, description: string | undefined, inputSchema: Record<string, unknown>, segments: string[], allowed: AllowedArgs): Tool => ({`,
	)
	l.push(`\t\tdescription,`)
	l.push(`\t\thandler: (args) => callTool(sdk, segments, args, inputSchema, allowed),`)
	l.push(`\t\tinputSchema,`)
	l.push(`\t\tname,`)
	l.push(`\t})`)
	l.push(`\treturn [`)

	for (const op of ops) {
		const desc = op.description ?? op.summary ?? ""
		const inputSchema = buildToolInputSchema(op, spec)
		l.push(`\t\ttool(`)
		l.push(`\t\t\t${JSON.stringify(op.toolName)},`)
		l.push(`\t\t\t${desc.length > 0 ? JSON.stringify(desc) : "undefined"},`)
		l.push(`\t\t\t${JSON.stringify(inputSchema)},`)
		l.push(`\t\t\t${JSON.stringify(op.pathSegments)},`)
		l.push(`\t\t\t${JSON.stringify(allowedArgs(inputSchema))},`)
		l.push(`\t\t),`)
	}

	l.push(`\t]`)
	l.push(`}`)
	l.push(``)
	/* project name embedded for tool-naming contract visibility — consumed by tests */
	l.push(`/* project: ${commentText(projectName)} */`)
	l.push(``)
	return l.join("\n")
}

function buildServerEntry(
	projectName: string,
	sdkPackageName: string,
	sdkClassName: string,
	serverName: string,
	version: string,
): string {
	const { apiKey: envVar, baseUrl: baseUrlEnvVar } = envVarNames(projectName)
	const l: string[] = []
	l.push(`/* Generated by honey codegen-mcp.ts — do not edit by hand. */`)
	l.push(``)
	l.push(`import { ${sdkClassName} } from ${JSON.stringify(sdkPackageName)}`)
	l.push(`import { createMCPServer } from "./_runtime"`)
	l.push(`import { buildTools } from "./tools.gen"`)
	l.push(``)
	l.push(`const apiKey = process.env[${JSON.stringify(envVar)}] ?? ""`)
	/* No guessed default: the API key must never be sent to a host nobody configured. */
	l.push(`const baseURL = process.env[${JSON.stringify(baseUrlEnvVar)}] ?? ""`)
	l.push(`if (baseURL.length === 0) {`)
	l.push(
		`\tprocess.stderr.write(${JSON.stringify(`${baseUrlEnvVar} is required (the API base URL, e.g. https://api.example.com)\n`)})`,
	)
	l.push(`\tprocess.exit(1)`)
	l.push(`}`)
	l.push(``)
	l.push(`const sdk = new ${sdkClassName}({`)
	l.push(`\tbaseURL,`)
	l.push(`\theaders: apiKey.length > 0 ? { Authorization: \`Bearer \${apiKey}\` } : {},`)
	l.push(`\tthrowOnError: true,`)
	l.push(`})`)
	l.push(``)
	l.push(`const tools = buildTools(sdk as unknown as Record<string, unknown>)`)
	l.push(``)
	l.push(`await createMCPServer({`)
	l.push(`\tsdk,`)
	l.push(`\tserverInfo: { name: ${JSON.stringify(serverName)}, version: ${JSON.stringify(version)} },`)
	l.push(`\ttools,`)
	l.push(`})`)
	l.push(``)
	return l.join("\n")
}

function buildTsconfig(): string {
	return JSON.stringify(
		{
			compilerOptions: {
				allowImportingTsExtensions: false,
				declaration: true,
				esModuleInterop: true,
				module: "ESNext",
				moduleResolution: "bundler",
				noEmit: false,
				outDir: "./dist",
				rootDir: "./src",
				skipLibCheck: true,
				strict: true,
				target: "ES2022",
				types: ["node"],
			},
			include: ["src/**/*"],
		},
		null,
		2,
	)
}

export function generateMCPServer(spec: OpenApiSpecInput, options: MCPOptions): MCPResult {
	const { projectName, sdkClassName, sdkPackageName } = options
	const version = options.version ?? "0.1.0"

	const ops = collectMCPOps(spec)
	if (ops.length === 0) {
		throw new Error("No operations marked x-mcp: true; nothing to emit")
	}
	assignToolNames(ops, projectName)

	const info = (spec as { info?: { title?: string } }).info ?? {}
	const serverName = info.title ?? `@${projectName}/mcp-server`

	const templates = loadMCPRuntimeTemplates()

	return {
		files: {
			"src/_runtime.ts": templates.get("server.ts") ?? "",
			"src/server.ts": buildServerEntry(projectName, sdkPackageName, sdkClassName, serverName, version),
			"src/tools.gen.ts": buildToolsGen(ops, spec, projectName),
			"src/types.ts": templates.get("types.ts") ?? "",
			"tsconfig.json": buildTsconfig(),
		},
	}
}
