/* MCP server code generator. Spec-driven (not IR-driven) — OpenAPI parameters[]
 * + requestBody.content['application/json'].schema are already JSON Schema,
 * no translation layer needed. Mirrors codegen-python.ts structure. */

import { readFileSync } from "node:fs"
import type { OpenApiSpecInput } from "./codegen.ts"
import { toIR } from "./codegen-ir.ts"

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

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const

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

function hasSSEResponse(op: SpecRecord): boolean {
	const responses = op.responses as Record<string, SpecRecord> | undefined
	if (!responses) return false
	for (const resp of Object.values(responses)) {
		const content = resp.content as SpecRecord | undefined
		if (content && "text/event-stream" in content) return true
	}
	return false
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

function resolveSchema(
	spec: SpecRecord,
	schema: SpecRecord | undefined,
): SpecRecord | undefined {
	if (!schema) return undefined
	if (!schema.$ref) return schema
	const ref = schema.$ref as string
	const parts = ref.replace(/^#\//, "").split("/")
	let cur: unknown = spec
	for (const part of parts) {
		if (cur === null || typeof cur !== "object") return undefined
		cur = (cur as SpecRecord)[part]
	}
	if (cur === undefined) return undefined
	/* recurse — resolved schema may itself be a ref */
	return resolveSchema(spec, cur as SpecRecord)
}

function deepResolveSchema(
	spec: SpecRecord,
	schema: SpecRecord | undefined,
	seen: Set<string> = new Set(),
): SpecRecord | undefined {
	if (!schema) return undefined
	if (schema.$ref) {
		const ref = schema.$ref as string
		if (seen.has(ref)) return { type: "object" }
		const next = new Set(seen)
		next.add(ref)
		return deepResolveSchema(spec, resolveSchema(spec, schema), next)
	}
	const out: SpecRecord = {}
	for (const [k, v] of Object.entries(schema)) {
		if (v === null || v === undefined) {
			out[k] = v
		} else if (Array.isArray(v)) {
			out[k] = v.map((item) =>
				item !== null && typeof item === "object"
					? deepResolveSchema(spec, item as SpecRecord, seen)
					: item,
			)
		} else if (typeof v === "object") {
			out[k] = deepResolveSchema(spec, v as SpecRecord, seen)
		} else {
			out[k] = v
		}
	}
	return out
}

function extractJsonBodySchema(op: SpecRecord): SpecRecord | undefined {
	const requestBody = op.requestBody as SpecRecord | undefined
	const content = requestBody?.content as Record<string, SpecRecord> | undefined
	return content?.["application/json"]?.schema as SpecRecord | undefined
}

function collectMCPOps(spec: OpenApiSpecInput): MCPOp[] {
	const paths = spec.paths as Record<string, SpecRecord> | undefined
	if (!paths) return []
	const ops: MCPOp[] = []

	for (const [path, pathItem] of Object.entries(paths)) {
		for (const method of HTTP_METHODS) {
			const op = pathItem[method] as SpecRecord | undefined
			if (!op) continue
			if (op["x-mcp"] !== true) continue
			/* skip websocket / realtime / SSE operations — MCP is request/response only */
			if (op["x-websocket"] === true) continue
			if (op["x-realtime"] === true) continue
			if (hasSSEResponse(op)) continue

			const operationId = op.operationId as string | undefined
			if (!operationId) continue

			ops.push({
				bodyRequired: (op.requestBody as SpecRecord | undefined)?.required === true,
				bodySchema: extractJsonBodySchema(op),
				description: op.description as string | undefined,
				method: method.toUpperCase(),
				operationId,
				parameters: (op.parameters as Array<SpecRecord> | undefined) ?? [],
				path,
				pathSegments: operationId.split("."),
				summary: op.summary as string | undefined,
				toolName: "",
			})
		}
	}

	return ops
}

type ParamGroup = { props: SpecRecord; required: string[] }

function emptyParamGroup(): ParamGroup {
	return { props: {}, required: [] }
}

function assignGroup(
	properties: SpecRecord,
	required: string[],
	key: string,
	group: ParamGroup,
): void {
	if (Object.keys(group.props).length === 0) return
	const out: SpecRecord = { properties: group.props, type: "object" }
	if (group.required.length > 0) {
		out.required = group.required
		required.push(key)
	}
	properties[key] = out
}

function buildToolInputSchema(
	op: MCPOp,
	spec: OpenApiSpecInput,
): SpecRecord {
	const properties: SpecRecord = {}
	const required: string[] = []
	const specRec = spec as unknown as SpecRecord

	const path = emptyParamGroup()
	const query = emptyParamGroup()
	const header = emptyParamGroup()
	const groupByLoc: Record<string, ParamGroup> = { header, path, query }

	for (const p of op.parameters) {
		const name = p.name as string
		const inLoc = p.in as string
		const group = groupByLoc[inLoc]
		if (!group) continue
		group.props[name] = deepResolveSchema(specRec, (p.schema ?? {}) as SpecRecord) ?? {}
		if (p.required === true) group.required.push(name)
	}

	assignGroup(properties, required, "params", path)
	assignGroup(properties, required, "search", query)
	assignGroup(properties, required, "headers", header)

	if (op.bodySchema) {
		properties.json = deepResolveSchema(specRec, op.bodySchema) ?? { type: "object" }
		if (op.bodyRequired) required.push("json")
	}

	const schema: SpecRecord = { properties, type: "object" }
	if (required.length > 0) schema.required = required
	return schema
}

function buildToolsGen(
	ops: MCPOp[],
	spec: OpenApiSpecInput,
	projectName: string,
): string {
	const l: string[] = []
	l.push(`/* Generated by honey codegen-mcp.ts — do not edit by hand. */`)
	l.push(``)
	l.push(`import type { Tool } from "./types"`)
	l.push(``)
	l.push(`export function buildTools(sdk: Record<string, unknown>): Tool[] {`)
	l.push(`\treturn [`)

	for (const op of ops) {
		const desc = op.description ?? op.summary ?? ""
		const inputSchema = buildToolInputSchema(op, spec)
		l.push(`\t\t{`)
		l.push(`\t\t\tname: ${JSON.stringify(op.toolName)},`)
		if (desc.length > 0) {
			l.push(`\t\t\tdescription: ${JSON.stringify(desc)},`)
		}
		l.push(`\t\t\tinputSchema: ${JSON.stringify(inputSchema)},`)
		/* handler dispatches by walking all path segments; pass args verbatim.
		 * arguments shape already matches TS SDK method signature: { params?, search?, headers?, json? }. */
		const callExpr = op.pathSegments.reduce(
			(acc, seg, i) =>
				i === 0
					? `(sdk as Record<string, unknown>)[${JSON.stringify(seg)}]`
					: `(${acc} as Record<string, unknown>)[${JSON.stringify(seg)}]`,
			"",
		)
		l.push(`\t\t\thandler: async (args) => {`)
		l.push(`\t\t\t\tconst method = ${callExpr}`)
		l.push(`\t\t\t\tif (typeof method !== "function") {`)
		l.push(`\t\t\t\t\treturn { content: [{ type: "text", text: JSON.stringify({ message: "SDK missing method ${op.operationId}" }) }], isError: true }`)
		l.push(`\t\t\t\t}`)
		l.push(`\t\t\t\tconst result = await method.call(sdk, args)`)
		l.push(`\t\t\t\treturn { content: [{ type: "text", text: JSON.stringify(result) }] }`)
		l.push(`\t\t\t},`)
		l.push(`\t\t},`)
	}

	l.push(`\t]`)
	l.push(`}`)
	l.push(``)
	/* project name embedded for tool-naming contract visibility — consumed by tests */
	l.push(`/* project: ${projectName} */`)
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
	const defaultBaseUrl = `https://api.${projectName}.com`
	const l: string[] = []
	l.push(`/* Generated by honey codegen-mcp.ts — do not edit by hand. */`)
	l.push(``)
	l.push(`import { ${sdkClassName} } from ${JSON.stringify(sdkPackageName)}`)
	l.push(`import { createMCPServer } from "./_runtime"`)
	l.push(`import { buildTools } from "./tools.gen"`)
	l.push(``)
	l.push(`const apiKey = process.env[${JSON.stringify(envVar)}] ?? ""`)
	l.push(`const baseURL = process.env[${JSON.stringify(baseUrlEnvVar)}] ?? ${JSON.stringify(defaultBaseUrl)}`)
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

export function generateMCPServer(
	spec: OpenApiSpecInput,
	options: MCPOptions,
): MCPResult {
	toIR(spec)
	const { projectName, sdkClassName, sdkPackageName } = options
	const version = options.version ?? "0.1.0"

	const ops = collectMCPOps(spec)
	if (ops.length === 0) {
		throw new Error("No operations marked x-mcp: true; nothing to emit")
	}
	for (const op of ops) {
		op.toolName = `${projectName}_${toSnakeCase(op.operationId)}`
	}

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
