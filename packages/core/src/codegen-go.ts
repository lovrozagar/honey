/* Go SDK emitter — generates a complete Go module from an OpenAPI 3.1 spec.
 * Mirrors the TS emitter pattern (string-array + join, tab indent).
 * Static runtime files (sse.go, ws.go, etc.) are read from ./client-go/ at
 * module load time and copied verbatim into the output file map.
 */

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { collectSDKMethods, extractOpenApiPathParams, isSSEOperation, resolveRefs } from "./codegen.ts"
import { methodsOf, namespacesOf, toIR } from "./codegen-ir.ts"
import type { IRNamespace, IROperation } from "./codegen-ir.ts"
import { GO_KEYWORDS, goPascal, isStringEnum, renderTopLevel, renderUse } from "./go-type-emitter.ts"

/* ── types ── */

export type GoSDKOptions = {
	/* post-process every emitted .go file with `gofmt`. Off by default — gofmt
	 * spawns a subprocess per file and byte-equivalence snapshot tests want
	 * stable unformatted output. Consumers publishing to pkg.go.dev should
	 * enable it so the rendered docs are canonical Go (aligned struct fields,
	 * multi-line if blocks, etc.). */
	gofmt?: boolean
	modulePath?: string
	throwOnError?: boolean
}

export type GeneratedGoSDK = {
	files: Record<string, string>
	serviceMap: Record<string, Record<string, unknown>>
}

type OpenApiSpec = {
	components?: {
		schemas?: Record<string, Record<string, unknown>>
	}
	info: { description?: string; title: string; version: string }
	openapi: string
	paths: Record<string, Record<string, Record<string, unknown>>>
}

/* ── runtime template loader ── */

let runtimeCache: Map<string, string> | null = null

/** Reads static .go runtime files from ./client-go/ and caches them. */
export function loadGoRuntimeTemplates(): Map<string, string> {
	if (runtimeCache) return runtimeCache

	const names = ["result.go", "errors.go", "runtime.go", "invalidation.go", "sse.go", "ws.go", "transport.go", "realtime.go"]
	const cache = new Map<string, string>()
	for (const name of names) {
		const filePath = fileURLToPath(new URL(`./client-go/${name}`, import.meta.url))
		let content: string
		try {
			content = readFileSync(filePath, "utf8")
		} catch {
			throw new Error(`loadGoRuntimeTemplates: missing file ${filePath}`)
		}
		cache.set(name, content)
	}
	runtimeCache = cache
	return cache
}

/* ── helpers ── */

export function safeResourceName(name: string): string {
	const lower = name.toLowerCase()
	return GO_KEYWORDS.has(lower) ? `${name}_` : name
}

function nestedStructName(path: string[]): string {
	return `${path.map(goPascal).join("")}Resource`
}

/**
 * Derive auth header name + prefix from OpenAPI securitySchemes.
 * Defaults to Authorization + "Bearer " when no scheme is declared, preserving
 * legacy behavior. apiKey type sends the raw token unless the scheme description
 * embeds a "Format: <Prefix> {token}" hint (common pattern for APIs like Anyrow
 * that use `Authorization: ApiKey <token>`).
 */
export function detectAuthScheme(spec: Record<string, unknown>): { headerName: string; prefix: string } {
	const components = (spec.components ?? {}) as Record<string, unknown>
	const schemes = (components.securitySchemes ?? {}) as Record<string, Record<string, unknown>>
	const keys = Object.keys(schemes).sort()
	if (keys.length === 0) return { headerName: "Authorization", prefix: "Bearer " }
	const scheme = schemes[keys[0]]
	const type = String(scheme.type ?? "")
	if (type === "http") {
		const httpScheme = String(scheme.scheme ?? "").toLowerCase()
		if (httpScheme === "basic") return { headerName: "Authorization", prefix: "Basic " }
		return { headerName: "Authorization", prefix: "Bearer " }
	}
	if (type === "apiKey" && scheme.in === "header") {
		const headerName = String(scheme.name ?? "Authorization")
		const desc = String(scheme.description ?? "")
		const match = /Format:\s*(\S+)\s+\{/i.exec(desc)
		if (match) return { headerName, prefix: `${match[1]} ` }
		return { headerName, prefix: "" }
	}
	return { headerName: "Authorization", prefix: "Bearer " }
}

function goImportBlock(stdlib: string[], thirdParty: string[]): string {
	const l: string[] = []
	l.push(`import (`)
	for (const p of [...stdlib].sort()) l.push(`\t"${p}"`)
	if (thirdParty.length > 0) {
		l.push(``)
		for (const p of [...thirdParty].sort()) l.push(`\t"${p}"`)
	}
	l.push(`)`)
	return l.join("\n")
}

/** Converts /users/{id} → string expression pieces for URL construction. */
function pathToGoExpr(path: string): string {
	const params = extractOpenApiPathParams(path)
	if (params.length === 0) return JSON.stringify(path)
	let expr = JSON.stringify(path)
	for (const p of params) {
		expr = expr.replace(`{${p}}`, `" + url.PathEscape(${p}) + "`)
	}
	/* clean up empty string concatenation at edges */
	expr = expr.replace(/"" \+ /g, "").replace(/ \+ ""/g, "")
	return expr
}

/** Extracts the Go response type for an operation from its 2xx responses. */
function goResponseType(op: Record<string, unknown>): string {
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return "json.RawMessage"

	for (const [status, response] of Object.entries(responses)) {
		const code = Number.parseInt(status, 10)
		if (Number.isNaN(code) || code < 200 || code >= 300) continue
		if (code === 204) return ""
		const content = response.content as Record<string, Record<string, unknown>> | undefined
		if (!content) return ""
		const jsonSchema = content["application/json"]?.schema as Record<string, unknown> | undefined
		if (!jsonSchema) return "json.RawMessage"
		if (jsonSchema.$ref) {
			return goPascal((jsonSchema.$ref as string).split("/").pop() ?? "")
		}
		if (jsonSchema.type === "array" && jsonSchema.items) {
			const items = jsonSchema.items as Record<string, unknown>
			if (items.$ref) {
				return `[]${goPascal((items.$ref as string).split("/").pop() ?? "")}`
			}
			return `[]${renderUse(items, { decls: new Map(), fieldName: "item", parentName: "Body" })}`
		}
		if (jsonSchema.type === "string") return "string"
		if (jsonSchema.type === "integer") return "int64"
		if (jsonSchema.type === "number") return "float64"
		if (jsonSchema.type === "boolean") return "bool"
		return "json.RawMessage"
	}
	return "json.RawMessage"
}

/** Extracts the Go input type (request body schema name) for an operation. */
function goBodyType(op: Record<string, unknown>): string | null {
	const requestBody = op.requestBody as Record<string, unknown> | undefined
	if (!requestBody) return null
	const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
	if (!content) return null
	const jsonContent = content["application/json"]
	if (!jsonContent?.schema) return null
	const schema = jsonContent.schema as Record<string, unknown>
	if (schema.$ref) {
		return goPascal((schema.$ref as string).split("/").pop() ?? "")
	}
	return "json.RawMessage"
}

/** True iff operation declares `application/octet-stream` request body. */
function hasOctetStreamBody(op: Record<string, unknown>): boolean {
	const requestBody = op.requestBody as Record<string, unknown> | undefined
	const content = requestBody?.content as Record<string, unknown> | undefined
	return content !== undefined && "application/octet-stream" in content
}

type QueryParam = {
	name: string
	required: boolean
	schema: Record<string, unknown>
}

/**
 * Produces a Go expression that converts a query-param value to `string`,
 * suitable as the 2nd argument of `url.Values.Set`. Nullable fields should
 * already be dereferenced by the caller — `varExpr` is the concrete value.
 */
function qpStringExpr(varExpr: string, schema: Record<string, unknown>): string {
	if (isStringEnum(schema)) return `string(${varExpr})`
	const t = schema.type
	if (t === "integer") return `strconv.FormatInt(${varExpr}, 10)`
	if (t === "number") return `strconv.FormatFloat(${varExpr}, 'f', -1, 64)`
	if (t === "boolean") return `strconv.FormatBool(${varExpr})`
	return varExpr
}

function queryParamsNeedStrconv(methods: MethodInfo[]): boolean {
	for (const m of methods) {
		for (const qp of m.queryParams) {
			const t = qp.schema.type
			if (t === "integer" || t === "number" || t === "boolean") return true
		}
	}
	return false
}

function getQueryParams(op: Record<string, unknown>): QueryParam[] {
	const parameters = op.parameters as Array<Record<string, unknown>> | undefined
	if (!parameters) return []
	return parameters
		.filter((p) => p.in === "query")
		.map((p) => ({
			name: String(p.name),
			required: p.required === true,
			schema: (p.schema as Record<string, unknown>) ?? { type: "string" },
		}))
		.sort((a, b) => a.name.localeCompare(b.name))
}

/* ── buildGoTypes ── */

/* Schema names defined in the Go runtime files — skip them to avoid redeclaration. */
const GO_RUNTIME_TYPES = new Set([
	"APIError",
	"BadGatewayError",
	"BadRequestError",
	"Config",
	"ConflictError",
	"ConnectionState",
	"ForbiddenError",
	"GatewayTimeoutError",
	"InternalServerError",
	"InvalidationConfig",
	"LongpollTransport",
	"NotFoundError",
	"RateLimitError",
	"RequestMeta",
	"ResumableConnection",
	"SDKResult",
	"SSEEvent",
	"ServiceUnavailableError",
	"SseTransport",
	"StaleTracker",
	"StatusError",
	"StatusErrorMeta",
	"Transport",
	"TransportConn",
	"TransportKind",
	"TransportOpts",
	"TypedWebSocket",
	"UnauthorizedError",
	"UnprocessableEntityError",
	"WsTransport",
])

function buildGoTypes(spec: OpenApiSpec): string {
	const schemas = spec.components?.schemas ?? {}
	const l: string[] = []
	/* blank line after generator header detaches it from package-doc on pkg.go.dev */
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(``)
	l.push(`package sdk`)
	l.push(``)

	const sortedSchemas = Object.entries(schemas)
		.filter(([name]) => !GO_RUNTIME_TYPES.has(name))
		.sort(([a], [b]) => a.localeCompare(b))
	const body: string[] = []
	const decls = new Map<string, string>()
	for (const [name, schema] of sortedSchemas) {
		const goType = renderTopLevel(name, schema, decls)
		body.push(goType)
		body.push(``)
	}
	/* append hoisted enum decls (deduped by name) after top-level types */
	const hoistedNames = [...decls.keys()].sort((a, b) => a.localeCompare(b))
	for (const hname of hoistedNames) {
		body.push(decls.get(hname) as string)
		body.push(``)
	}

	/* emit encoding/json import only when generated type bodies actually use it
	 * (json.RawMessage, json.Unmarshal, etc). Keeps types.go compilable whether
	 * schemas produced additionalProperties helpers or not. */
	const bodyStr = body.join("\n")
	if (bodyStr.includes("json.RawMessage") || bodyStr.includes("json.Unmarshal") || bodyStr.includes("json.Marshal")) {
		l.push(`import "encoding/json"`)
		l.push(``)
	}
	l.push(bodyStr)

	return l.join("\n")
}

/* ── buildGoMod ── */

function buildGoMod(modulePath?: string): string {
	const mod = modulePath ?? "example.com/sdk"
	return [
		`module ${mod}`,
		``,
		`go 1.23`,
		``,
		`require nhooyr.io/websocket v1.8.17`,
		``,
	].join("\n")
}

/* ── buildGoDoc ── */

function buildGoDoc(spec: OpenApiSpec): string {
	const title = spec.info.title
	const desc = spec.info.description
	const descSuffix = desc ? ` ${desc}` : ""
	/* Generator directive on its own line, separated from package-doc by blank
	 * line so pkg.go.dev does not aggregate "Code generated..." into Overview.
	 * The `// Package sdk ...` line IS attached to `package sdk` (no blank line
	 * before it) and becomes the package-level doc shown in the Overview. */
	const l: string[] = []
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(``)
	l.push(`// Package sdk is an auto-generated client for ${title}.${descSuffix}`)
	l.push(`package sdk`)
	l.push(``)
	return l.join("\n")
}

/* ── buildGoClient ── */

type MethodInfo = {
	/* first segment of operationId — used as invalidationMap key */
	resource: string
	/* segments[1..] joined with "." — used as invalidationMap action key */
	action: string
	/* all segments except last — namespace path for struct name generation */
	namePath: string[]
	/* last segment of operationId — used for the Go method name */
	methodAction: string
	bodyIsStream: boolean
	bodyType: string | null
	description: string
	httpMethod: string
	isIdempotent: boolean
	isRealtime: boolean
	isSSE: boolean
	isWS: boolean
	op: Record<string, unknown>
	opId: string
	path: string
	pathParams: string[]
	queryParams: QueryParam[]
	responseType: string
	summary: string
	/* Override for the Pascal-cased method/opts name. Set when a top-level
	 * operation's resource name collides with an existing resource bucket,
	 * so the emitted `Client` doesn't have a same-named field + method. */
	methodNameOverride?: string
}

/** Build a MethodInfo from an IROperation + the raw spec op object. */
function methodInfoFromIROp(
	irOp: IROperation,
	rawOp: Record<string, unknown>,
): MethodInfo {
	const segments = irOp.id.split(".")
	const isTopLevel = segments.length === 1
	const resource = segments[0] ?? irOp.id
	const action = isTopLevel ? "_call" : segments.slice(1).join(".")
	const namePath = segments.slice(0, -1)
	const methodAction = segments[segments.length - 1] ?? irOp.id
	const isRealtime = rawOp["x-realtime"] === true
	return {
		action,
		bodyIsStream: hasOctetStreamBody(rawOp),
		bodyType: goBodyType(rawOp),
		description: String(rawOp.description ?? ""),
		httpMethod: irOp.method,
		isIdempotent: rawOp["x-idempotency-key"] === true,
		isRealtime,
		isSSE: !isRealtime && isSSEOperation(rawOp),
		isWS: !isRealtime && rawOp["x-websocket"] === true,
		methodAction,
		namePath,
		op: rawOp,
		opId: irOp.id,
		path: irOp.path,
		pathParams: irOp.params.path.map((p) => p.name),
		queryParams: getQueryParams(rawOp),
		resource,
		responseType: goResponseType(rawOp),
		summary: String(rawOp.summary ?? ""),
	}
}

/** Walk the IR tree and collect all MethodInfos, pairing with raw spec ops. */
function collectMethodsFromIR(
	ns: IRNamespace,
	spec: OpenApiSpec,
): MethodInfo[] {
	const rawOpById = new Map<string, Record<string, unknown>>()
	for (const [, pathMethods] of Object.entries(spec.paths ?? {})) {
		for (const [, operation] of Object.entries(pathMethods)) {
			const op = operation as Record<string, unknown>
			const id = op.operationId as string | undefined
			if (id) rawOpById.set(id, op)
		}
	}

	const results: MethodInfo[] = []

	function walk(cur: IRNamespace): void {
		for (const [, entry] of methodsOf(cur)) {
			const raw = rawOpById.get(entry.id) ?? {}
			results.push(methodInfoFromIROp(entry, raw))
		}
		for (const [, childNs] of namespacesOf(cur)) {
			walk(childNs)
		}
	}

	walk(ns)
	return results
}

function buildGoClient(spec: OpenApiSpec, options: GoSDKOptions): string {
	const throwOnError = options.throwOnError ?? true

	/* toIR validates operationId collisions — throws before any codegen runs */
	const ir = toIR(spec as Parameters<typeof toIR>[0])
	const methods = collectMethodsFromIR(ir.tree, spec)

	/* top-level single-segment ops (action === "_call") emit as methods on *Client */
	const topLevel: MethodInfo[] = methods.filter((m) => m.action === "_call")
	/* collect root namespace names to detect field/method name collision */
	const rootNsNames = new Set(namespacesOf(ir.tree).map(([seg]) => safeResourceName(seg)))

	/* top-level op whose resource name collides with a root namespace field needs a
	 * unique method name — Go forbids struct field + method sharing a name.
	 * Suffix with "Call": extract + extract.table → Extract field + ExtractCall method. */
	for (const m of topLevel) {
		if (rootNsNames.has(safeResourceName(m.resource))) {
			m.methodNameOverride = `${goPascal(m.resource)}Call`
		}
	}

	const hasWS = methods.some((m) => m.isWS)

	/* collect invalidation data for map */
	const serviceMap = collectSDKMethods(spec as Parameters<typeof collectSDKMethods>[0]).serviceMap

	const body: string[] = []

	/* serviceEntry struct */
	body.push(`type serviceEntry struct {`)
	body.push(`\tMethod     string`)
	body.push(`\tPath       string`)
	body.push(`\tParams     []string`)
	body.push(`\tSSE        bool`)
	body.push(`\tWS         bool`)
	body.push(`\tInvalidate []string`)
	body.push(`}`)
	body.push(``)

	/* invalidationMap */
	body.push(`var invalidationMap = map[string]map[string]serviceEntry{`)
	for (const [resource, actions] of Object.entries(serviceMap).sort(([a], [b]) => a.localeCompare(b))) {
		body.push(`\t"${resource}": {`)
		for (const [action, entry] of Object.entries(actions as Record<string, Record<string, unknown>>).sort(([a], [b]) => a.localeCompare(b))) {
			const inv = entry.invalidate as string[] | undefined
			const invStr = inv && inv.length > 0
				? `[]string{${inv.map((s) => JSON.stringify(s)).join(", ")}}`
				: `nil`
			const params = entry.params as string[] | undefined
			const paramsStr = params && params.length > 0
				? `[]string{${params.map((s) => JSON.stringify(s)).join(", ")}}`
				: `nil`
			body.push(`\t\t"${action}": {Method: ${JSON.stringify(String(entry.method))}, Path: ${JSON.stringify(String(entry.path))}, Params: ${paramsStr}, SSE: ${entry.sse === true}, WS: ${entry.ws === true}, Invalidate: ${invStr}},`)
		}
		body.push(`\t},`)
	}
	body.push(`}`)
	body.push(``)

	/* ---- Client struct: cfg + stale + one field per root namespace ---- */
	body.push(`// Client is the generated SDK client.`)
	body.push(`type Client struct {`)
	body.push(`\tcfg   Config`)
	body.push(`\tstale *StaleTracker`)
	for (const [seg] of namespacesOf(ir.tree)) {
		const safeName = safeResourceName(seg)
		body.push(`\t${goPascal(safeName)} *${nestedStructName([safeName])}`)
	}
	body.push(`}`)
	body.push(``)

	/* ---- NewClient: init + cascade nested struct init ---- */
	const auth = detectAuthScheme(spec)
	body.push(`// NewClient creates a new SDK client. BaseURL must be non-empty.`)
	body.push(`func NewClient(cfg Config) *Client {`)
	body.push(`\tif cfg.BaseURL == "" {`)
	body.push(`\t\tpanic("honey sdk: Config.BaseURL must not be empty")`)
	body.push(`\t}`)
	body.push(`\tif cfg.HTTPClient == nil {`)
	body.push(`\t\tcfg.HTTPClient = &http.Client{Timeout: 30 * time.Second}`)
	body.push(`\t}`)
	body.push(`\tif cfg.AuthHeaderName == "" {`)
	body.push(`\t\tcfg.AuthHeaderName = ${JSON.stringify(auth.headerName)}`)
	body.push(`\t}`)
	body.push(`\tif cfg.AuthHeaderPrefix == "" {`)
	body.push(`\t\tcfg.AuthHeaderPrefix = ${JSON.stringify(auth.prefix)}`)
	body.push(`\t}`)
	body.push(`\tc := &Client{cfg: cfg}`)
	body.push(`\tc.stale = NewStaleTracker(cfg.Invalidation)`)
	/* emit a helper fn per root namespace that inits itself + its children,
	 * then assign: c.Checkout = newCheckoutResource(c) */
	for (const [seg] of namespacesOf(ir.tree)) {
		const safeName = safeResourceName(seg)
		body.push(`\tc.${goPascal(safeName)} = new${nestedStructName([safeName])}(c)`)
	}
	body.push(`\treturn c`)
	body.push(`}`)
	body.push(``)

	/* IsStale predicate */
	body.push(`// IsStale reports whether (method, path) currently sits inside an active stale window.`)
	body.push(`func (c *Client) IsStale(method, path string) bool {`)
	body.push(`\tif c.stale == nil { return false }`)
	body.push(`\treturn c.stale.IsStale(method, path)`)
	body.push(`}`)
	body.push(``)

	/* top-level single-segment methods on *Client */
	for (const m of topLevel.sort((a, b) => a.resource.localeCompare(b.resource))) {
		body.push(...emitMethod(m, "c", "*Client", throwOnError))
	}

	/* ---- recursive resource struct + method emission ---- */
	function emitResourceStructs(ns: IRNamespace, path: string[]): void {
		const structName = nestedStructName(path)
		const recvName = path[path.length - 1]?.[0]?.toLowerCase() ?? "r"

		/* struct definition: client pointer + one field per child namespace */
		body.push(`type ${structName} struct {`)
		body.push(`\tclient *Client`)
		for (const [childSeg] of namespacesOf(ns)) {
			const safeSeg = safeResourceName(childSeg)
			body.push(`\t${goPascal(safeSeg)} *${nestedStructName([...path, safeSeg])}`)
		}
		body.push(`}`)
		body.push(``)

		/* constructor helper: newXResource(c) sets client + child fields */
		body.push(`func new${structName}(c *Client) *${structName} {`)
		body.push(`\tr := &${structName}{client: c}`)
		for (const [childSeg] of namespacesOf(ns)) {
			const safeSeg = safeResourceName(childSeg)
			body.push(`\tr.${goPascal(safeSeg)} = new${nestedStructName([...path, safeSeg])}(c)`)
		}
		body.push(`\treturn r`)
		body.push(`}`)
		body.push(``)

		/* direct methods on this struct */
		for (const [, op] of methodsOf(ns)) {
			const raw = (methods.find((m) => m.opId === op.id)) ?? (() => { throw new Error(`missing MethodInfo for ${op.id}`) })()
			body.push(...emitMethod(raw, recvName, `*${structName}`, throwOnError))
		}

		/* recurse into child namespaces */
		for (const [childSeg, childNs] of namespacesOf(ns)) {
			emitResourceStructs(childNs, [...path, safeResourceName(childSeg)])
		}
	}

	for (const [seg, ns] of namespacesOf(ir.tree)) {
		emitResourceStructs(ns, [safeResourceName(seg)])
	}

	/* opts structs — emit once per unique opts name, sorted by opId */
	const optsEmitted = new Set<string>()
	for (const m of methods.sort((a, b) => a.opId.localeCompare(b.opId))) {
		const optsName = optsStructName(m)
		if (optsEmitted.has(optsName)) continue
		optsEmitted.add(optsName)
		body.push(...emitOptsStruct(m))
	}

	const bodyStr = body.join("\n")

	const hasSSE = methods.some((m) => m.isSSE)
	const stdlib = ["context", "encoding/json", "fmt", "io", "net/http", "net/url", "strings", "sync", "time"]
	if (hasSSE) stdlib.push("iter")
	if (queryParamsNeedStrconv(methods)) stdlib.push("strconv")
	const thirdParty = hasWS ? ["nhooyr.io/websocket"] : []

	/* emit a `var _ = <symbol>` suppression only for stdlib imports the body
	 * does not already reference, so unused-import compile errors are avoided
	 * without polluting generated code with dead suppressions. */
	const suppressions: { line: string; symbol: string }[] = [
		{ line: `var _ json.RawMessage`, symbol: "json." },
		{ line: `var _ = fmt.Sprintf`, symbol: "fmt." },
		{ line: `var _ = io.Discard`, symbol: "io." },
		{ line: `var _ *url.URL`, symbol: "url." },
		{ line: `var _ = strings.NewReader`, symbol: "strings." },
		{ line: `var _ = sync.Mutex{}`, symbol: "sync." },
		{ line: `var _ = time.Second`, symbol: "time." },
	]
	const suppressionLines = suppressions
		.filter((s) => !bodyStr.includes(s.symbol))
		.map((s) => s.line)

	const out: string[] = []
	/* blank line after generator header detaches it from package-doc on pkg.go.dev */
	out.push(`// Code generated by honey. DO NOT EDIT.`)
	out.push(``)
	out.push(`package sdk`)
	out.push(``)
	out.push(goImportBlock([...new Set(stdlib)].sort(), thirdParty))
	out.push(``)
	if (suppressionLines.length > 0) {
		out.push(...suppressionLines)
		out.push(``)
	}
	out.push(bodyStr)
	return out.join("\n")
}

function optsStructName(m: MethodInfo): string {
	if (m.methodNameOverride) return `${m.methodNameOverride}Opts`
	/* For top-level single-segment ops: namePath=[], methodAction=opId → e.g. GetUserOpts
	 * For multi-segment: namePath=[checkout,sessions], methodAction=create → CheckoutSessionsCreateOpts */
	const prefix = m.namePath.map(goPascal).join("")
	const suffix = goPascal(m.methodAction)
	return `${prefix}${suffix}Opts`
}

function emitOptsStruct(m: MethodInfo): string[] {
	const l: string[] = []
	const optsName = optsStructName(m)
	if (m.isRealtime) {
		/* realtime ops get a fixed opts shape — no generated query fields;
		 * transports receive ReconnectToken / LastEventID via TransportOpts. */
		l.push(`type ${optsName} struct {`)
		l.push(`\tReconnectToken string`)
		l.push(`\tLastEventID string`)
		l.push(`\tProtocols []string`)
		l.push(`\tMaxReconnectAttempts int`)
		l.push(`\tReconnectDelayMs int`)
		l.push(`\tHeaders map[string]string`)
		l.push(`}`)
		l.push(``)
		return l
	}
	const decls = new Map<string, string>()
	const fields: string[] = []
	for (const qp of m.queryParams) {
		const fieldName = goPascal(qp.name)
		const goType = renderUse(qp.schema, {
			decls,
			fieldName: qp.name,
			parentName: optsName,
		})
		const ptr = qp.required ? goType : `*${goType}`
		fields.push(`\t${fieldName} ${ptr}`)
	}
	/* hoisted query-param enums emit before the opts struct so refs resolve */
	for (const decl of decls.values()) {
		l.push(decl)
		l.push(``)
	}
	l.push(`type ${optsName} struct {`)
	l.push(...fields)
	if (m.isSSE) {
		l.push(`\tLastEventID string`)
	}
	if (m.isWS) {
		l.push(`\tReconnectToken string`)
		l.push(`\tProtocols []string`)
	}
	if (m.isIdempotent && !m.isRealtime && !m.isSSE && !m.isWS) {
		l.push(`\tIdempotencyKey string`)
	}
	l.push(`\tHeaders map[string]string`)
	l.push(`}`)
	l.push(``)
	return l
}

function emitMethod(m: MethodInfo, recv: string, recvType: string, throwOnError: boolean): string[] {
	const l: string[] = []
	/* top-level single-segment ops (action === "_call") use resource as the method name */
	const actionPascal = m.methodNameOverride ?? goPascal(m.action === "_call" ? m.resource : m.methodAction)
	const optsName = optsStructName(m)
	const httpMethod = m.httpMethod
	const pathStr = m.path

	/* godoc */
	if (m.summary) {
		l.push(`// ${actionPascal} — ${m.summary}`)
		if (m.description) l.push(`// ${m.description}`)
	}

	/* signature */
	const params: string[] = [`ctx context.Context`]
	for (const pp of m.pathParams) params.push(`${pp} string`)
	if (m.bodyIsStream) params.push(`body io.Reader`)
	else if (m.bodyType) params.push(`body ${m.bodyType}`)

	let ret: string
	if (m.isRealtime) {
		params.push(`opts *${optsName}`)
		ret = `*ResumableConnection`
	} else if (m.isSSE) {
		params.push(`opts *${optsName}`)
		ret = `iter.Seq2[SSEEvent, error]`
	} else if (m.isWS) {
		params.push(`opts *${optsName}`)
		ret = `(*TypedWebSocket, error)`
	} else if (throwOnError) {
		params.push(`opts *${optsName}`)
		ret = m.responseType !== "" ? `(*${m.responseType}, error)` : `error`
	} else {
		params.push(`opts *${optsName}`)
		ret = m.responseType !== "" ? `(SDKResult[${m.responseType}], error)` : `error`
	}

	l.push(`func (${recv} ${recvType}) ${actionPascal}(${params.join(", ")}) ${ret} {`)

	const httpMethodStr = httpMethod.toUpperCase()

	/* client accessor */
	const cfgAccess = recvType === "*Client" ? `${recv}.cfg` : `${recv}.client.cfg`
	const staleAccess = recvType === "*Client" ? `${recv}.stale` : `${recv}.client.stale`

	if (m.isRealtime) {
		const urlExpr = pathToGoExpr(pathStr)
		/* ctx is accepted for API symmetry with sibling methods but not used
		 * here — consumer binds a ctx at ResumableConnection.Connect(ctx) time. */
		l.push(`\t_ = ctx`)
		l.push(`\ttransports := []Transport{&WsTransport{}, &SseTransport{}, &LongpollTransport{}}`)
		l.push(`\ttopts := &TransportOpts{}`)
		l.push(`\tif opts != nil {`)
		l.push(`\t\ttopts.ReconnectToken = opts.ReconnectToken`)
		l.push(`\t\ttopts.LastEventID = opts.LastEventID`)
		l.push(`\t\ttopts.Protocols = opts.Protocols`)
		l.push(`\t\ttopts.MaxReconnectAttempts = opts.MaxReconnectAttempts`)
		l.push(`\t\ttopts.ReconnectDelayMs = opts.ReconnectDelayMs`)
		l.push(`\t\tif len(opts.Headers) > 0 {`)
		l.push(`\t\t\ttopts.Headers = http.Header{}`)
		l.push(`\t\t\tfor k, v := range opts.Headers { topts.Headers.Set(k, v) }`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`\treturn NewResumableConnection(${cfgAccess}.BaseURL + ${urlExpr}, transports, topts)`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (m.isSSE) {
		const sseQueryParams = m.queryParams.filter((qp) => qp.name !== "last-event-id")
		l.push(`\treturn func(yield func(SSEEvent, error) bool) {`)
		if (sseQueryParams.length > 0) {
			l.push(`\t\tq := url.Values{}`)
			for (const qp of sseQueryParams) {
				const fieldName = goPascal(qp.name)
				if (qp.required) {
					l.push(`\t\tif opts != nil { q.Set(${JSON.stringify(qp.name)}, ${qpStringExpr(`opts.${fieldName}`, qp.schema)}) }`)
				} else {
					l.push(`\t\tif opts != nil && opts.${fieldName} != nil { q.Set(${JSON.stringify(qp.name)}, ${qpStringExpr(`*opts.${fieldName}`, qp.schema)}) }`)
				}
			}
		}
		const urlExpr = pathToGoExpr(pathStr)
		const sseURLExpr = sseQueryParams.length > 0
			? `${cfgAccess}.BaseURL+${urlExpr}+"?"+q.Encode()`
			: `${cfgAccess}.BaseURL+${urlExpr}`
		l.push(`\t\tcallHeaders := map[string]string{"Accept": "text/event-stream"}`)
		l.push(`\t\tif opts != nil && opts.LastEventID != "" {`)
		l.push(`\t\t\tcallHeaders["Last-Event-ID"] = opts.LastEventID`)
		l.push(`\t\t}`)
		l.push(`\t\tif opts != nil {`)
		l.push(`\t\t\tfor k, v := range opts.Headers { callHeaders[k] = v }`)
		l.push(`\t\t}`)
		l.push(`\t\treq, err := http.NewRequestWithContext(ctx, "GET", ${sseURLExpr}, nil)`)
		l.push(`\t\tif err != nil { yield(SSEEvent{}, err); return }`)
		l.push(`\t\tfor k, v := range ${cfgAccess}.Headers { req.Header.Set(k, v) }`)
		l.push(`\t\tfor k, v := range callHeaders { req.Header.Set(k, v) }`)
		l.push(`\t\tif ${cfgAccess}.BearerToken != "" { req.Header.Set(${cfgAccess}.AuthHeaderName, ${cfgAccess}.AuthHeaderPrefix+${cfgAccess}.BearerToken) }`)
		l.push(`\t\tresp, err := ${cfgAccess}.HTTPClient.Do(req)`)
		l.push(`\t\tif err != nil { yield(SSEEvent{}, err); return }`)
		l.push(`\t\tfor ev, err := range parseSSEStream(ctx, resp) {`)
		l.push(`\t\t\tif !yield(ev, err) { return }`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (m.isWS) {
		const urlExpr = pathToGoExpr(pathStr)
		l.push(`\tq := url.Values{}`)
		for (const qp of m.queryParams) {
			if (qp.name === "reconnect_token") continue
			const fieldName = goPascal(qp.name)
			if (qp.required) {
				l.push(`\tif opts != nil { q.Set(${JSON.stringify(qp.name)}, ${qpStringExpr(`opts.${fieldName}`, qp.schema)}) }`)
			} else {
				l.push(`\tif opts != nil && opts.${fieldName} != nil { q.Set(${JSON.stringify(qp.name)}, ${qpStringExpr(`*opts.${fieldName}`, qp.schema)}) }`)
			}
		}
		l.push(`\tif opts != nil && opts.ReconnectToken != "" { q.Set("reconnect_token", opts.ReconnectToken) }`)
		l.push(`\twsURL := ${cfgAccess}.BaseURL + ${urlExpr}`)
		l.push(`\tif len(q) > 0 { wsURL += "?" + q.Encode() }`)
		l.push(`\tdialOpts := &websocket.DialOptions{}`)
		l.push(`\tif opts != nil && len(opts.Protocols) > 0 { dialOpts.Subprotocols = opts.Protocols }`)
		l.push(`\tif opts != nil && len(opts.Headers) > 0 {`)
		l.push(`\t\tdialOpts.HTTPHeader = http.Header{}`)
		l.push(`\t\tfor k, v := range opts.Headers { dialOpts.HTTPHeader.Set(k, v) }`)
		l.push(`\t}`)
		l.push(`\tconn, _, err := websocket.Dial(ctx, wsURL, dialOpts)`)
		l.push(`\tif err != nil { return nil, err }`)
		l.push(`\treturn newTypedWebSocket(conn), nil`)
		l.push(`}`)
		l.push(``)
		return l
	}

	/* HTTP method */
	l.push(`\tq := url.Values{}`)
	for (const qp of m.queryParams) {
		const fieldName = goPascal(qp.name)
		if (qp.required) {
			l.push(`\tif opts != nil { q.Set(${JSON.stringify(qp.name)}, ${qpStringExpr(`opts.${fieldName}`, qp.schema)}) }`)
		} else {
			l.push(`\tif opts != nil && opts.${fieldName} != nil { q.Set(${JSON.stringify(qp.name)}, ${qpStringExpr(`*opts.${fieldName}`, qp.schema)}) }`)
		}
	}

	const urlExpr = pathToGoExpr(pathStr)
	const bodyArg = !m.bodyIsStream && m.bodyType ? "body" : "nil"
	const bodyReaderArg = m.bodyIsStream ? "body" : "nil"
	const contentTypeArg = m.bodyIsStream ? `"application/octet-stream"` : `""`

	l.push(`\tvar callHeaders map[string]string`)
	l.push(`\tif opts != nil { callHeaders = opts.Headers }`)

	/* idempotency-key auto-injection: case-insensitive existing-header check
	 * matches caller's intent if they supplied any casing. opts==nil branch
	 * still emits a key so the contract holds (every dispatch carries a key
	 * for ops marked x-idempotency-key). */
	if (m.isIdempotent && !m.isRealtime && !m.isSSE && !m.isWS) {
		l.push(`\tif opts != nil {`)
		l.push(`\t\t_idemExisting := ""`)
		l.push(`\t\tfor _k, _v := range callHeaders {`)
		l.push(`\t\t\tif strings.EqualFold(_k, "Idempotency-Key") { _idemExisting = _v; break }`)
		l.push(`\t\t}`)
		l.push(`\t\tif _idemExisting == "" {`)
		l.push(`\t\t\tif callHeaders == nil { callHeaders = map[string]string{} }`)
		l.push(`\t\t\tif opts.IdempotencyKey != "" {`)
		l.push(`\t\t\t\tcallHeaders["Idempotency-Key"] = opts.IdempotencyKey`)
		l.push(`\t\t\t} else {`)
		l.push(`\t\t\t\tcallHeaders["Idempotency-Key"] = newUUIDv4()`)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t} else {`)
		l.push(`\t\tcallHeaders = map[string]string{"Idempotency-Key": newUUIDv4()}`)
		l.push(`\t}`)
	}

	/* invalidation pre-flight — build path-params map, interpolate to concrete
	 * selector, snapshot RequestMeta from the tracker. Emitted unconditionally
	 * so consumer can flip cfg.Invalidation on/off without regen; tracker's
	 * BuildRequestMeta short-circuits to nil when disabled. */
	const hasInvalidate = Array.isArray(m.op["x-invalidate"]) && (m.op["x-invalidate"] as unknown[]).length > 0
	const pathParamsMapExpr = m.pathParams.length > 0
		? `map[string]string{${m.pathParams.map((p) => `${JSON.stringify(p)}: ${p}`).join(", ")}}`
		: `map[string]string(nil)`
	if (hasInvalidate) {
		l.push(`\t_pathParamsMap := ${pathParamsMapExpr}`)
		l.push(`\t_concretePath, _ := interpolatePath(${JSON.stringify(pathStr)}, _pathParamsMap)`)
		l.push(`\t_concreteSelector := ${JSON.stringify(`${httpMethodStr} `)} + _concretePath`)
		l.push(`\tvar _requestMeta *RequestMeta`)
		l.push(`\tif ${staleAccess} != nil { _requestMeta = ${staleAccess}.BuildRequestMeta(_concreteSelector, _concretePath, ${JSON.stringify(httpMethodStr)}) }`)
	}

	const resultBind = m.responseType === "" ? "_, err" : "result, err"
	const operationStr = JSON.stringify(`${httpMethodStr} ${pathStr}`)
	const requestMetaArg = hasInvalidate ? "_requestMeta" : "nil"
	l.push(`\t${resultBind} := doRequest(ctx, ${cfgAccess}, "${httpMethodStr}", ${urlExpr}, q, ${bodyArg}, ${bodyReaderArg}, ${contentTypeArg}, callHeaders, ${operationStr}, ${requestMetaArg})`)
	l.push(`\tif err != nil {`)

	if (throwOnError) {
		if (m.responseType !== "") {
			l.push(`\t\treturn nil, err`)
		} else {
			l.push(`\t\treturn err`)
		}
	} else {
		if (m.responseType !== "") {
			/* unwrap typed APIError if doRequest produced one, else synthesize
			 * a StatusError so callers always see a typed Err without panicking
			 * on ctx cancel / network errors. */
			l.push(`\t\tif apiErr, ok := err.(APIError); ok {`)
			l.push(`\t\t\treturn SDKResult[${m.responseType}]{Err: apiErr, Status: 0, Response: nil}, nil`)
			l.push(`\t\t}`)
			l.push(`\t\treturn SDKResult[${m.responseType}]{Err: &StatusError{StatusCode: 0, Message: err.Error()}, Status: 0, Response: nil}, nil`)
		} else {
			l.push(`\t\treturn err`)
		}
	}
	l.push(`\t}`)

	/* invalidation post-flight — expand templated x-invalidate targets with the
	 * call's concrete params (TS parity: GET /users/{id} → GET /users/abc),
	 * mark them stale, then clear keys that were already stale before this
	 * mutation completed (seq-bounded to avoid clobbering newer invalidations). */
	if (hasInvalidate) {
		l.push(`\tif ${staleAccess} != nil {`)
		l.push(`\t\t${staleAccess}.MarkStale(invalidationMap["${m.resource}"]["${m.action}"].Invalidate, _pathParamsMap, _concreteSelector)`)
		l.push(`\t\tif _requestMeta != nil && _requestMeta.IsStale {`)
		l.push(`\t\t\t${staleAccess}.ClearStale(_concreteSelector, _concretePath, ${JSON.stringify(httpMethodStr)}, _requestMeta.SeqSnapshot)`)
		l.push(`\t\t}`)
		l.push(`\t}`)
	}

	if (m.responseType === "") {
		l.push(`\treturn nil`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (throwOnError) {
		l.push(`\tvar out ${m.responseType}`)
		l.push(`\tif len(result.body) > 0 {`)
		l.push(`\t\tif err := json.Unmarshal(result.body, &out); err != nil { return nil, err }`)
		l.push(`\t}`)
		l.push(`\treturn &out, nil`)
	} else {
		l.push(`\tvar out ${m.responseType}`)
		l.push(`\tif len(result.body) > 0 {`)
		l.push(`\t\tif err := json.Unmarshal(result.body, &out); err != nil {`)
		l.push(`\t\t\treturn SDKResult[${m.responseType}]{Err: &StatusError{StatusCode: result.status, Body: result.body, Response: result.resp, Message: err.Error()}, Status: result.status, Response: result.resp}, nil`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`\treturn SDKResult[${m.responseType}]{Data: &out, Status: result.status, Response: result.resp}, nil`)
	}

	l.push(`}`)
	l.push(``)
	return l
}

/* ── public entrypoint ── */

/**
 * Generates a complete Go SDK module from an OpenAPI 3.1 spec.
 * Returns a file map (filename → content) ready to write to disk as a Go module.
 */
export function generateGoSDK(
	spec: Record<string, unknown>,
	options: GoSDKOptions = {},
): GeneratedGoSDK {
	const resolved = resolveRefs(spec as Parameters<typeof resolveRefs>[0]) as unknown as OpenApiSpec

	const { serviceMap } = collectSDKMethods(spec as Parameters<typeof resolveRefs>[0])

	const files: Record<string, string> = {}

	/* static runtime templates */
	for (const [name, content] of loadGoRuntimeTemplates()) {
		files[name] = content
	}

	/* types.go uses unresolved spec because resolveRefs strips components.schemas. */
	files["types.go"] = buildGoTypes(spec as unknown as OpenApiSpec)
	/* client uses unresolved spec so request/response $refs survive for type
	 * resolution into named Go types (resolveRefs inlines and drops names). */
	files["client.go"] = buildGoClient(spec as unknown as OpenApiSpec, options)
	files["go.mod"] = buildGoMod(options.modulePath)
	files["doc.go"] = buildGoDoc(resolved)

	/* Opt-in post-process. Consumers publishing to pkg.go.dev pass `gofmt: true`
	 * so struct fields align and single-line `if` blocks expand. No-op when
	 * gofmt is not on PATH (pure-JS environments), preserving generator
	 * portability. */
	if (options.gofmt) {
		for (const [name, content] of Object.entries(files)) {
			if (!name.endsWith(".go")) continue
			files[name] = tryGofmt(content)
		}
	}

	return { files, serviceMap }
}

function tryGofmt(src: string): string {
	const res = spawnSync("gofmt", [], { encoding: "utf8", input: src })
	if (res.error || res.status !== 0 || !res.stdout) return src
	return res.stdout
}
