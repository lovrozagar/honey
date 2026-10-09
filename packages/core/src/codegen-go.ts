/* Go SDK emitter — generates a complete Go module from an OpenAPI 3.1 spec.
 *
 * Input is the SDK request model (codegen-sdk-model.ts), never the raw spec. Every identifier
 * comes from a NameScope seeded with the runtime's own package-level names, and every spec string
 * lands in source through goString / goComment (codegen-lang.ts).
 *
 * Static runtime files (sse.go, ws.go, etc.) are read from ./client-go/ at module load time and
 * copied verbatim into the output file map.
 */

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { OpenApiSpecInput } from "./codegen.ts"
import { serviceMapOf } from "./codegen.ts"
import { methodsOf, namespacesOf, specAuth } from "./codegen-ir.ts"
import type { IRAuth, IRInfo, IRNamespace, IRSchema } from "./codegen-ir.ts"
import {
	GO_KEYWORDS,
	GO_PREDECLARED,
	NameScope,
	cmpCodeUnit,
	goComment,
	goExported,
	goLocal,
	goString,
} from "./codegen-lang.ts"
import { buildSdkModel, valueCycleSchemas } from "./codegen-sdk-model.ts"
import type { SdkModel, SdkOp } from "./codegen-sdk-model.ts"
import { irRenderTopLevel, irRenderUse } from "./go-type-emitter.ts"
import type { GoTypeNames, RenderUseCtx } from "./go-type-emitter.ts"

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

/* ── runtime template loader ── */

let runtimeCache: Map<string, string> | null = null

const RUNTIME_FILES = [
	"result.go",
	"errors.go",
	"runtime.go",
	"invalidation.go",
	"sse.go",
	"ws.go",
	"transport.go",
	"realtime.go",
	"export.go",
]

/** Reads static .go runtime files from ./client-go/ and caches them. */
export function loadGoRuntimeTemplates(): Map<string, string> {
	if (runtimeCache) return runtimeCache

	const cache = new Map<string, string>()
	for (const name of RUNTIME_FILES) {
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

let runtimeIdentCache: Set<string> | null = null

/** Every package-level identifier the runtime files declare; generated names must avoid them all. */
export function goRuntimeIdentifiers(): Set<string> {
	if (runtimeIdentCache) return runtimeIdentCache
	const out = new Set<string>()
	for (const src of loadGoRuntimeTemplates().values()) {
		let inBlock = false
		for (const line of src.split("\n")) {
			const top = /^(?:func|type|var|const)\s+([A-Za-z_]\w*)/.exec(line)
			if (top) out.add(top[1])
			if (/^(?:var|const|type)\s*\($/.test(line)) {
				inBlock = true
				continue
			}
			if (inBlock) {
				if (line.startsWith(")")) inBlock = false
				else {
					const m = /^\t([A-Za-z_]\w*)/.exec(line)
					if (m) out.add(m[1])
				}
			}
		}
	}
	runtimeIdentCache = out
	return out
}

/* ── helpers ── */

/** @deprecated kept for callers outside this file; use goLocal / goExported. */
export function safeResourceName(name: string): string {
	const lower = name.toLowerCase()
	return GO_KEYWORDS.has(lower) ? `${name}_` : name
}

/**
 * Derive auth header name + prefix from OpenAPI securitySchemes.
 * Defaults to Authorization + "Bearer " when no scheme is declared, preserving
 * legacy behavior. apiKey type sends the raw token unless the scheme description
 * embeds a "Format: <Prefix> {token}" hint (common pattern for APIs like Anyrow
 * that use `Authorization: ApiKey <token>`).
 */
/** The auth header and prefix the spec's first security scheme asks for (see `IR.auth`). */
export function detectAuthScheme(spec: Record<string, unknown>): IRAuth {
	return specAuth(spec as unknown as OpenApiSpecInput)
}

function goImportBlock(stdlib: string[], thirdParty: string[]): string {
	const l: string[] = []
	l.push(`import (`)
	for (const p of [...new Set(stdlib)].sort(cmpCodeUnit)) l.push(`\t"${p}"`)
	if (thirdParty.length > 0) {
		l.push(``)
		for (const p of [...thirdParty].sort(cmpCodeUnit)) l.push(`\t"${p}"`)
	}
	l.push(`)`)
	return l.join("\n")
}

/* ── naming ── */

/** Package-level names for one generated SDK. */
export type GoNames = {
	scope: NameScope
	types: GoTypeNames
	hoistedDecls: Map<string, string>
}

export function buildGoNames(model: SdkModel): GoNames {
	const scope = new NameScope([...goRuntimeIdentifiers(), ...GO_PREDECLARED, "Client", "NewClient", "serviceEntry"])
	const schemaNames = new Map<string, string>()
	/* schemas first: a schema keeps its own name unless the runtime owns it */
	for (const name of model.schemaNames) {
		const base = goExported(name)
		schemaNames.set(name, scope.has(base) ? scope.claim(`${base}Model`) : scope.claim(base))
	}
	const hoistKeys = new Map<string, string>()
	const types: GoTypeNames = {
		claimConst: (base) => scope.claim(base),
		cyclic: valueCycleSchemas(model.ir.schemas),
		hoist: (key, base) => {
			const hit = hoistKeys.get(key)
			if (hit) return hit
			const name = scope.claim(base)
			hoistKeys.set(key, name)
			return name
		},
		ref: (name) => schemaNames.get(name) ?? goExported(name),
		resolve: model.resolve,
	}
	return { hoistedDecls: new Map(), scope, types }
}

/* ── buildGoTypes ── */

function buildGoTypes(model: SdkModel, names: GoNames): string {
	const body: string[] = []
	const decls = names.hoistedDecls
	for (const name of model.schemaNames) {
		const ir = model.ir.schemas[name]
		const goName = names.types.ref(name)
		const description = Object.hasOwn(model.ir.schemaDescriptions, name) ? model.ir.schemaDescriptions[name] : ""
		if (description) body.push(...goComment(description))
		body.push(irRenderTopLevel(goName, ir, decls, undefined, names.types))
		body.push(``)
	}
	return body.join("\n")
}

function hoistedDeclsSource(decls: Map<string, string>): string {
	const out: string[] = []
	for (const name of [...decls.keys()].sort(cmpCodeUnit)) {
		const decl = decls.get(name)
		if (!decl) continue
		out.push(decl)
		out.push(``)
	}
	return out.join("\n")
}

/** types.go: component schemas, then every hoisted declaration (call after the client is planned). */
function typesFile(schemaTypes: string, names: GoNames): string {
	const body = `${schemaTypes}\n${hoistedDeclsSource(names.hoistedDecls)}`
	const l: string[] = []
	/* blank line after generator header detaches it from package-doc on pkg.go.dev */
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(``)
	l.push(`package sdk`)
	l.push(``)
	if (/\bjson\./.test(body)) {
		l.push(`import "encoding/json"`)
		l.push(``)
	}
	l.push(body)
	return l.join("\n")
}

/* ── buildGoMod ── */

function buildGoMod(modulePath?: string): string {
	const mod = modulePath ?? "example.com/sdk"
	return [`module ${mod}`, ``, `go 1.23`, ``, `require nhooyr.io/websocket v1.8.17`, ``].join("\n")
}

/* ── buildGoDoc ── */

function buildGoDoc(info: IRInfo): string {
	const title = info.title ?? "API"
	const desc = info.description ?? ""
	/* Generator directive on its own line, separated from package-doc by blank
	 * line so pkg.go.dev does not aggregate "Code generated..." into Overview.
	 * The `// Package sdk ...` line IS attached to `package sdk` (no blank line
	 * before it) and becomes the package-level doc shown in the Overview. */
	const l: string[] = []
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(``)
	l.push(...goComment(`Package sdk is an auto-generated client for ${title}.${desc ? ` ${desc}` : ""}`))
	l.push(`package sdk`)
	l.push(``)
	return l.join("\n")
}

/* ── buildGoClient ── */

type GoOpPlan = {
	op: SdkOp
	methodName: string
	optsName: string
	/** opts struct field per query/header param */
	optFields: Array<{ goName: string; type: string; param: { name: string }; where: "query" | "header" }>
	/** local identifier per path param */
	pathLocals: Array<{ local: string; name: string }>
	bodyParam?: { local: string; type: string }
	multipartName?: string
	multipartFields?: Array<{
		goName: string
		type: string
		key: string
		file: boolean
		list: boolean
		required: boolean
	}>
	/** Go type returned on success, "" for none */
	resultType: string
}

const OPTS_RESERVED = [
	"Headers",
	"IdempotencyKey",
	"LastEventID",
	"ReconnectToken",
	"Protocols",
	"MaxReconnectAttempts",
	"ReconnectDelayMs",
]

/** Locals every emitted method body uses. Path params must not shadow them. */
const METHOD_LOCALS = [
	"ctx",
	"opts",
	"q",
	"path",
	"err",
	"result",
	"out",
	"resp",
	"req",
	"reqBody",
	"callHeaders",
	"pathParams",
	"concretePath",
	"selector",
	"requestMeta",
	"stale",
	"cfg",
	"yield",
	"ev",
	"conn",
	"dialOpts",
	"wsURL",
	"transports",
	"topts",
	"parts",
	"c",
	"r",
]

function planOp(op: SdkOp, methodName: string, optsName: string, names: GoNames): GoOpPlan {
	const plan: GoOpPlan = { methodName, op, optFields: [], optsName, pathLocals: [], resultType: "" }

	const locals = new NameScope(METHOD_LOCALS)
	const bodyLocal =
		op.body && op.stream !== "ws" && op.stream !== "realtime"
			? locals.claim(op.body.kind === "form" ? "form" : "body")
			: ""
	for (const p of op.pathParams) plan.pathLocals.push({ local: locals.claim(goLocal(p.name)), name: p.name })

	if (op.stream !== "realtime") {
		const fieldScope = new NameScope(OPTS_RESERVED)
		const decls = names.hoistedDecls
		const params: Array<[{ name: string; schema: IRSchema; required?: boolean }, "query" | "header"]> = [
			...op.query.map((p): [typeof p, "query"] => [p, "query"]),
			...op.headers.map((p): [typeof p, "header"] => [p, "header"]),
		]
		for (const [p, where] of params) {
			if (op.stream === "sse" && where === "query" && /^last[-_]?event[-_]?id$/i.test(p.name)) continue
			const goName = fieldScope.claim(goExported(p.name))
			const ctx: RenderUseCtx = { decls, fieldName: goName, names: names.types, parentName: optsName }
			const t = irRenderUse(p.schema, ctx)
			const nilable = t.startsWith("*") || t.startsWith("[]") || t.startsWith("map[") || t === "json.RawMessage"
			plan.optFields.push({ goName, param: p, type: p.required || nilable ? t : `*${t}`, where })
		}
	}

	const body = op.body
	if (body && op.stream !== "ws" && op.stream !== "realtime") {
		const local = bodyLocal
		switch (body.kind) {
			case "json": {
				const resolved = body.schema
				let t: string
				if (resolved.kind === "ref") t = names.types.ref(resolved.name)
				else if (resolved.kind === "object" && resolved.fields.length > 0) {
					const name = names.types.hoist(`${op.id}.body`, `${optsName.replace(/Opts$/, "")}Body`)
					if (!names.hoistedDecls.has(name)) {
						names.hoistedDecls.set(name, "")
						names.hoistedDecls.set(name, irRenderTopLevel(name, resolved, names.hoistedDecls, undefined, names.types))
					}
					t = name
				} else {
					t = irRenderUse(resolved, {
						decls: names.hoistedDecls,
						fieldName: "Body",
						names: names.types,
						parentName: optsName.replace(/Opts$/, ""),
					})
				}
				plan.bodyParam = { local, type: t }
				break
			}
			case "form":
				plan.bodyParam = { local, type: "url.Values" }
				break
			case "binary":
				plan.bodyParam = { local, type: "io.Reader" }
				break
			case "text":
				plan.bodyParam = { local, type: "string" }
				break
			case "multipart": {
				const name = names.types.hoist(`${op.id}.multipart`, `${optsName.replace(/Opts$/, "")}Body`)
				const fieldScope = new NameScope()
				plan.multipartName = name
				plan.multipartFields = body.parts.map((part) => {
					const goName = fieldScope.claim(goExported(part.name))
					const schema = part.schema ? names.types.resolve(part.schema) : { kind: "unknown" as const }
					const list = schema.kind === "array"
					if (part.type === "file") {
						return { file: true, goName, key: part.name, list, required: true, type: list ? "[]FilePart" : "FilePart" }
					}
					const item = list && schema.kind === "array" ? schema.items : schema
					let t = "string"
					if (item.kind === "scalar") {
						t =
							item.type === "integer"
								? "int64"
								: item.type === "number"
									? "float64"
									: item.type === "boolean"
										? "bool"
										: "string"
					}
					return { file: false, goName, key: part.name, list, required: false, type: list ? `[]${t}` : `*${t}` }
				})
				plan.bodyParam = { local, type: name }
				break
			}
		}
	}

	if (op.stream === null) {
		const s = op.success
		if (s.kind === "json") {
			if (!s.schema) plan.resultType = "json.RawMessage"
			else if (s.schema.kind === "ref") plan.resultType = names.types.ref(s.schema.name)
			else if (s.schema.kind === "object" && s.schema.fields.length > 0) {
				const name = names.types.hoist(`${op.id}.response`, `${optsName.replace(/Opts$/, "")}Response`)
				if (!names.hoistedDecls.has(name)) {
					names.hoistedDecls.set(name, "")
					names.hoistedDecls.set(name, irRenderTopLevel(name, s.schema, names.hoistedDecls, undefined, names.types))
				}
				plan.resultType = name
			} else {
				const t = irRenderUse(s.schema, {
					decls: names.hoistedDecls,
					fieldName: "Response",
					names: names.types,
					parentName: optsName.replace(/Opts$/, ""),
				})
				plan.resultType = t.startsWith("*") ? t.slice(1) : t
			}
		} else if (s.kind === "text") plan.resultType = "string"
		else if (s.kind === "binary") plan.resultType = "[]byte"
	}
	return plan
}

function emitOptsStruct(plan: GoOpPlan): string[] {
	const l: string[] = []
	const { op, optsName } = plan
	l.push(`// ${optsName} holds the optional inputs of ${plan.methodName}.`)
	if (op.stream === "realtime") {
		/* realtime ops get a fixed opts shape — transports receive
		 * ReconnectToken / LastEventID via TransportOpts. */
		l.push(`type ${optsName} struct {`)
		l.push(`\tReconnectToken string`)
		l.push(`\tLastEventID string`)
		l.push(`\tProtocols []string`)
		l.push(`\t// MaxReconnectAttempts caps reconnects after a drop. Zero means 5; negative means unlimited.`)
		l.push(`\tMaxReconnectAttempts int`)
		l.push(`\t// ReconnectDelayMs is the first backoff delay. Zero means 1000.`)
		l.push(`\tReconnectDelayMs int`)
		l.push(`\tHeaders map[string]string`)
		l.push(`}`)
		l.push(``)
		return l
	}
	l.push(`type ${optsName} struct {`)
	for (const f of plan.optFields) l.push(`\t${f.goName} ${f.type}`)
	if (op.stream === "sse") l.push(`\tLastEventID string`)
	if (op.stream === "ws") {
		l.push(`\tReconnectToken string`)
		l.push(`\tProtocols []string`)
	}
	if (op.idempotent && op.stream === null) l.push(`\tIdempotencyKey string`)
	l.push(`\tHeaders map[string]string`)
	l.push(`}`)
	l.push(``)
	return l
}

function emitMultipartStruct(plan: GoOpPlan): string[] {
	if (!plan.multipartName || !plan.multipartFields) return []
	const l: string[] = []
	l.push(`// ${plan.multipartName} is the multipart/form-data body of ${plan.methodName}.`)
	l.push(`type ${plan.multipartName} struct {`)
	for (const f of plan.multipartFields) l.push(`\t${f.goName} ${f.type}`)
	l.push(`}`)
	l.push(``)
	return l
}

function pathExpr(plan: GoOpPlan): string {
	if (plan.pathLocals.length === 0) return ""
	return `map[string]string{${plan.pathLocals.map((p) => `${goString(p.name)}: ${p.local}`).join(", ")}}`
}

/** Lines that compute `path` (and return on error through `fail`). */
function emitPath(plan: GoOpPlan, fail: string, indent: string): string[] {
	const l: string[] = []
	if (plan.pathLocals.length === 0) {
		l.push(`${indent}path := ${goString(plan.op.path)}`)
		return l
	}
	l.push(`${indent}path, err := expandPath(${goString(plan.op.path)}, ${pathExpr(plan)})`)
	l.push(`${indent}if err != nil {`)
	l.push(`${indent}\t${fail}`)
	l.push(`${indent}}`)
	return l
}

/** Lines that build `q` and `callHeaders` from opts. */
function emitQueryAndHeaders(plan: GoOpPlan, indent: string, baseHeaders: string): string[] {
	const l: string[] = []
	l.push(`${indent}var q queryList`)
	l.push(`${indent}callHeaders := ${baseHeaders}`)
	l.push(`${indent}if opts != nil {`)
	for (const f of plan.optFields) {
		if (f.where === "query") l.push(`${indent}\tq.set(${goString(f.param.name)}, opts.${f.goName})`)
	}
	l.push(`${indent}\tfor k, v := range opts.Headers {`)
	l.push(`${indent}\t\tcallHeaders[k] = v`)
	l.push(`${indent}\t}`)
	for (const f of plan.optFields) {
		if (f.where === "header")
			l.push(`${indent}\tsetHeaderValue(callHeaders, ${goString(f.param.name)}, opts.${f.goName})`)
	}
	l.push(`${indent}}`)
	return l
}

/** Expression for the request body, plus setup lines. */
function emitBody(plan: GoOpPlan, fail: string, indent: string): { lines: string[]; expr: string } {
	const body = plan.op.body
	const local = plan.bodyParam?.local
	if (!body || !local) return { expr: "noBody()", lines: [] }
	switch (body.kind) {
		case "json":
			return { expr: `jsonBody(${local})`, lines: [] }
		case "form":
			return { expr: `formBody(${local})`, lines: [] }
		case "text":
			return { expr: `rawBody([]byte(${local}), ${goString(body.contentType)})`, lines: [] }
		case "binary":
			return { expr: `readerBody(${local}, ${goString(body.contentType)})`, lines: [] }
		case "multipart": {
			const l: string[] = []
			l.push(`${indent}var parts []multipartField`)
			for (const f of plan.multipartFields ?? []) {
				if (f.file) {
					if (f.list) {
						l.push(`${indent}for _, file := range ${local}.${f.goName} {`)
						l.push(`${indent}\tparts = append(parts, fileField(${goString(f.key)}, file))`)
						l.push(`${indent}}`)
					} else {
						l.push(`${indent}parts = append(parts, fileField(${goString(f.key)}, ${local}.${f.goName}))`)
					}
				} else if (f.list) {
					l.push(`${indent}for _, v := range ${local}.${f.goName} {`)
					l.push(`${indent}\tparts = append(parts, textField(${goString(f.key)}, v))`)
					l.push(`${indent}}`)
				} else {
					l.push(`${indent}if ${local}.${f.goName} != nil {`)
					l.push(`${indent}\tparts = append(parts, textField(${goString(f.key)}, *${local}.${f.goName}))`)
					l.push(`${indent}}`)
				}
			}
			l.push(`${indent}reqBody, err := multipartBody(parts)`)
			l.push(`${indent}if err != nil {`)
			l.push(`${indent}\t${fail}`)
			l.push(`${indent}}`)
			return { expr: "reqBody", lines: l }
		}
	}
}

function emitDoc(plan: GoOpPlan): string[] {
	const l: string[] = []
	const { op } = plan
	const text = [op.summary, op.description].filter((s) => s !== "").join("\n")
	if (text) l.push(...goComment(`${plan.methodName} — ${text}`))
	if (op.deprecated) {
		if (text) l.push(`//`)
		l.push(`// Deprecated: the API marks this operation deprecated.`)
	}
	return l
}

function emitMethod(plan: GoOpPlan, recv: string, recvType: string, throwOnError: boolean): string[] {
	const l: string[] = []
	const { op, optsName } = plan
	const cfg = recvType === "*Client" ? `${recv}.cfg` : `${recv}.client.cfg`
	const stale = recvType === "*Client" ? `${recv}.stale` : `${recv}.client.stale`

	l.push(...emitDoc(plan))

	const params: string[] = [`ctx context.Context`]
	for (const p of plan.pathLocals) params.push(`${p.local} string`)
	if (plan.bodyParam) params.push(`${plan.bodyParam.local} ${plan.bodyParam.type}`)
	params.push(`opts *${optsName}`)

	if (op.stream === "realtime") {
		l.push(`func (${recv} ${recvType}) ${plan.methodName}(${params.join(", ")}) (*ResumableConnection, error) {`)
		/* ctx bounds nothing here: ResumableConnection.Connect(ctx) takes its own */
		l.push(`\t_ = ctx`)
		l.push(...emitPath(plan, "return nil, err", "\t"))
		l.push(`\trtURL, err := buildURL(${cfg}.BaseURL, path, nil)`)
		l.push(`\tif err != nil {`)
		l.push(`\t\treturn nil, err`)
		l.push(`\t}`)
		l.push(`\tvar extra map[string]string`)
		l.push(`\ttopts := &TransportOpts{HTTPClient: streamClient(${cfg})}`)
		l.push(`\tif opts != nil {`)
		l.push(`\t\textra = opts.Headers`)
		l.push(`\t\ttopts.ReconnectToken = opts.ReconnectToken`)
		l.push(`\t\ttopts.LastEventID = opts.LastEventID`)
		l.push(`\t\ttopts.Protocols = opts.Protocols`)
		l.push(`\t\ttopts.MaxReconnectAttempts = opts.MaxReconnectAttempts`)
		l.push(`\t\ttopts.ReconnectDelayMs = opts.ReconnectDelayMs`)
		l.push(`\t}`)
		l.push(`\ttopts.Headers = authHeaders(${cfg}, extra)`)
		l.push(`\ttransports := []Transport{&WsTransport{}, &SseTransport{}, &LongpollTransport{}}`)
		l.push(`\treturn NewResumableConnection(rtURL, transports, topts), nil`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (op.stream === "sse") {
		l.push(`func (${recv} ${recvType}) ${plan.methodName}(${params.join(", ")}) iter.Seq2[SSEEvent, error] {`)
		l.push(`\treturn func(yield func(SSEEvent, error) bool) {`)
		l.push(...emitPath(plan, "yield(SSEEvent{}, err)\n\t\t\treturn", "\t\t"))
		l.push(...emitQueryAndHeaders(plan, "\t\t", `map[string]string{"Accept": "text/event-stream"}`))
		l.push(`\t\tif opts != nil && opts.LastEventID != "" {`)
		l.push(`\t\t\tcallHeaders["Last-Event-ID"] = opts.LastEventID`)
		l.push(`\t\t}`)
		const body = emitBody(plan, "yield(SSEEvent{}, err)\n\t\t\treturn", "\t\t")
		l.push(...body.lines)
		l.push(`\t\tresp, err := openStream(ctx, ${cfg}, ${goString(op.method)}, path, q, ${body.expr}, callHeaders)`)
		l.push(`\t\tif err != nil {`)
		l.push(`\t\t\tyield(SSEEvent{}, err)`)
		l.push(`\t\t\treturn`)
		l.push(`\t\t}`)
		l.push(`\t\tfor ev, err := range parseSSEStream(ctx, resp) {`)
		l.push(`\t\t\tif !yield(ev, err) {`)
		l.push(`\t\t\t\treturn`)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (op.stream === "ws") {
		l.push(`func (${recv} ${recvType}) ${plan.methodName}(${params.join(", ")}) (*TypedWebSocket, error) {`)
		l.push(...emitPath(plan, "return nil, err", "\t"))
		l.push(...emitQueryAndHeaders(plan, "\t", "map[string]string{}"))
		l.push(`\tif opts != nil && opts.ReconnectToken != "" {`)
		l.push(`\t\tq.set("reconnect_token", opts.ReconnectToken)`)
		l.push(`\t}`)
		l.push(`\twsURL, err := buildURL(${cfg}.BaseURL, path, q)`)
		l.push(`\tif err != nil {`)
		l.push(`\t\treturn nil, err`)
		l.push(`\t}`)
		l.push(
			`\tdialOpts := &websocket.DialOptions{HTTPClient: streamClient(${cfg}), HTTPHeader: authHeaders(${cfg}, callHeaders)}`,
		)
		l.push(`\tif opts != nil && len(opts.Protocols) > 0 {`)
		l.push(`\t\tdialOpts.Subprotocols = opts.Protocols`)
		l.push(`\t}`)
		l.push(`\tconn, _, err := websocket.Dial(ctx, toWsURL(wsURL), dialOpts)`)
		l.push(`\tif err != nil {`)
		l.push(`\t\treturn nil, err`)
		l.push(`\t}`)
		l.push(`\treturn newTypedWebSocket(conn), nil`)
		l.push(`}`)
		l.push(``)
		return l
	}

	const resultType = plan.resultType
	let ret: string
	let failRet: string
	if (resultType === "") {
		ret = "error"
		failRet = "return err"
	} else if (throwOnError) {
		ret = `(*${resultType}, error)`
		failRet = "return nil, err"
	} else {
		ret = `(SDKResult[${resultType}], error)`
		failRet = `return SDKResult[${resultType}]{}, err`
	}
	l.push(`func (${recv} ${recvType}) ${plan.methodName}(${params.join(", ")}) ${ret} {`)
	l.push(`\tvar err error`)
	l.push(...emitPath(plan, failRet, "\t"))
	l.push(...emitQueryAndHeaders(plan, "\t", "map[string]string{}"))

	/* idempotency-key auto-injection: an explicit header (any casing) wins, then
	 * opts.IdempotencyKey, then a fresh UUID — every dispatch carries a key. */
	if (op.idempotent) {
		l.push(`\tif !hasHeader(callHeaders, "Idempotency-Key") {`)
		l.push(`\t\tkey := newUUIDv4()`)
		l.push(`\t\tif opts != nil && opts.IdempotencyKey != "" {`)
		l.push(`\t\t\tkey = opts.IdempotencyKey`)
		l.push(`\t\t}`)
		l.push(`\t\tcallHeaders["Idempotency-Key"] = key`)
		l.push(`\t}`)
	}

	const body = emitBody(plan, failRet, "\t")
	l.push(...body.lines)

	/* invalidation pre-flight for every call: reads see and clear staleness too */
	const pathParamsExpr = plan.pathLocals.length > 0 ? pathExpr(plan) : "map[string]string(nil)"
	l.push(`\tpathParams := ${pathParamsExpr}`)
	l.push(`\tselector := ${goString(`${op.method} `)} + path`)
	l.push(`\tvar requestMeta *RequestMeta`)
	l.push(`\tif ${stale} != nil {`)
	l.push(`\t\trequestMeta = ${stale}.BuildRequestMeta(selector, path, ${goString(op.method)})`)
	l.push(`\t}`)

	const resultBind = resultType === "" ? "_, err =" : "result, err :="
	l.push(
		`\t${resultBind} doRequest(ctx, ${cfg}, ${goString(op.method)}, path, q, ${body.expr}, callHeaders, ${goString(`${op.method} ${op.path}`)}, requestMeta)`,
	)
	l.push(`\tif err != nil {`)
	if (resultType !== "" && !throwOnError) {
		l.push(`\t\tvar apiErr APIError`)
		l.push(`\t\tif errors.As(err, &apiErr) {`)
		l.push(`\t\t\treturn SDKResult[${resultType}]{Err: apiErr, Status: apiErr.Status()}, nil`)
		l.push(`\t\t}`)
		l.push(`\t\treturn SDKResult[${resultType}]{}, err`)
	} else {
		l.push(`\t\t${failRet}`)
	}
	l.push(`\t}`)

	/* invalidation post-flight: mark declared targets stale (templated ones expanded
	 * with this call's params), then clear this key if the call read through a stale window */
	l.push(`\tif ${stale} != nil {`)
	if (op.invalidates.length > 0) {
		l.push(`\t\t${stale}.MarkStale([]string{${op.invalidates.map(goString).join(", ")}}, pathParams, selector)`)
	} else {
		l.push(`\t\t_ = pathParams`)
	}
	l.push(`\t\tif requestMeta != nil && requestMeta.IsStale {`)
	l.push(`\t\t\t${stale}.ClearStale(selector, path, ${goString(op.method)}, requestMeta.SeqSnapshot)`)
	l.push(`\t\t}`)
	l.push(`\t}`)

	if (resultType === "") {
		l.push(`\treturn nil`)
		l.push(`}`)
		l.push(``)
		return l
	}

	l.push(`\tvar out ${resultType}`)
	if (op.success.kind === "text") {
		l.push(`\tout = string(result.body)`)
	} else if (op.success.kind === "binary") {
		l.push(`\tout = result.body`)
	} else {
		l.push(`\tif len(result.body) > 0 {`)
		l.push(`\t\tif err := json.Unmarshal(result.body, &out); err != nil {`)
		if (throwOnError) {
			l.push(`\t\t\treturn nil, fmt.Errorf("honey: decode response: %w", err)`)
		} else {
			l.push(
				`\t\t\treturn SDKResult[${resultType}]{Err: &StatusError{StatusCode: result.status, Body: result.body, Response: result.resp, Message: err.Error()}, Status: result.status, Response: result.resp}, nil`,
			)
		}
		l.push(`\t\t}`)
		l.push(`\t}`)
	}
	if (throwOnError) l.push(`\treturn &out, nil`)
	else l.push(`\treturn SDKResult[${resultType}]{Data: &out, Status: result.status, Response: result.resp}, nil`)
	l.push(`}`)
	l.push(``)
	return l
}

type ResourceNode = {
	structName: string
	ns: IRNamespace
	path: string[]
	children: Array<{ field: string; node: ResourceNode }>
	methods: GoOpPlan[]
}

function buildGoClient(
	model: SdkModel,
	names: GoNames,
	options: GoSDKOptions,
	auth: { headerName: string; prefix: string },
): string {
	const throwOnError = options.throwOnError ?? true

	/* plan resources top-down so names are claimed in a stable order */
	const allPlans: GoOpPlan[] = []
	function planNs(
		ns: IRNamespace,
		path: string[],
		reserved: string[],
	): { children: ResourceNode["children"]; methods: GoOpPlan[] } {
		const members = new NameScope(reserved)
		const children: ResourceNode["children"] = []
		for (const [seg, childNs] of namespacesOf(ns)) {
			const field = members.claim(goExported(seg))
			const childPath = [...path, seg]
			const structName = names.scope.claim(`${childPath.map(goExported).join("")}Resource`)
			children.push({ field, node: { children: [], methods: [], ns: childNs, path: childPath, structName } })
		}
		const methods: GoOpPlan[] = []
		for (const [seg, irOp] of methodsOf(ns)) {
			const op = model.opsById.get(irOp.id)
			if (!op) continue
			const base = goExported(seg)
			/* Go forbids a field and a method with one name: `extract` + `extract.table` → ExtractCall */
			const methodName = members.has(base) ? members.claim(`${base}Call`) : members.claim(base)
			const optsName = names.scope.claim(`${[...path, seg].map(goExported).join("")}Opts`)
			const plan = planOp(op, methodName, optsName, names)
			methods.push(plan)
			allPlans.push(plan)
		}
		for (const child of children) {
			const sub = planNs(child.node.ns, child.node.path, ["client"])
			child.node.children = sub.children
			child.node.methods = sub.methods
		}
		return { children, methods }
	}
	const root = planNs(model.ir.tree, [], ["cfg", "stale", "IsStale"])

	const body: string[] = []
	/* ---- Client struct: cfg + stale + one field per root namespace ---- */
	body.push(`// Client is the generated SDK client.`)
	body.push(`type Client struct {`)
	body.push(`\tcfg   Config`)
	body.push(`\tstale *StaleTracker`)
	for (const child of root.children) body.push(`\t${child.field} *${child.node.structName}`)
	body.push(`}`)
	body.push(``)
	body.push(emitClientBody(root, allPlans, throwOnError, auth))
	return body.join("\n")
}

function emitClientBody(
	root: { children: ResourceNode["children"]; methods: GoOpPlan[] },
	allPlans: GoOpPlan[],
	throwOnError: boolean,
	auth: { headerName: string; prefix: string },
): string {
	const body: string[] = []
	/* ---- NewClient: init + cascade nested struct init ---- */
	body.push(`// NewClient creates a new SDK client. BaseURL must be non-empty.`)
	body.push(`func NewClient(cfg Config) *Client {`)
	body.push(`\tif cfg.BaseURL == "" {`)
	body.push(`\t\tpanic("honey sdk: Config.BaseURL must not be empty")`)
	body.push(`\t}`)
	body.push(`\tif cfg.AuthHeaderName == "" {`)
	body.push(`\t\tcfg.AuthHeaderName = ${goString(auth.headerName)}`)
	body.push(`\t}`)
	body.push(`\tif cfg.AuthHeaderPrefix == "" {`)
	body.push(`\t\tcfg.AuthHeaderPrefix = ${goString(auth.prefix)}`)
	body.push(`\t}`)
	body.push(`\tcfg = prepareConfig(cfg)`)
	body.push(`\tc := &Client{cfg: cfg}`)
	body.push(`\tc.stale = NewStaleTracker(cfg.Invalidation)`)
	for (const child of root.children) body.push(`\tc.${child.field} = new${child.node.structName}(c)`)
	body.push(`\treturn c`)
	body.push(`}`)
	body.push(``)

	/* IsStale predicate */
	body.push(`// IsStale reports whether (method, path) currently sits inside an active stale window.`)
	body.push(`func (c *Client) IsStale(method, path string) bool {`)
	body.push(`\tif c.stale == nil {`)
	body.push(`\t\treturn false`)
	body.push(`\t}`)
	body.push(`\treturn c.stale.IsStale(method, path)`)
	body.push(`}`)
	body.push(``)

	for (const plan of root.methods) body.push(...emitMethod(plan, "c", "*Client", throwOnError))

	function emitResource(node: ResourceNode): void {
		body.push(`// ${node.structName} groups the ${goString(node.path.join("."))} operations.`)
		body.push(`type ${node.structName} struct {`)
		body.push(`\tclient *Client`)
		for (const child of node.children) body.push(`\t${child.field} *${child.node.structName}`)
		body.push(`}`)
		body.push(``)
		body.push(`func new${node.structName}(c *Client) *${node.structName} {`)
		body.push(`\tr := &${node.structName}{client: c}`)
		for (const child of node.children) body.push(`\tr.${child.field} = new${child.node.structName}(c)`)
		body.push(`\treturn r`)
		body.push(`}`)
		body.push(``)
		for (const plan of node.methods) body.push(...emitMethod(plan, "r", `*${node.structName}`, throwOnError))
		for (const child of node.children) emitResource(child.node)
	}
	for (const child of root.children) emitResource(child.node)

	for (const plan of [...allPlans].sort((a, b) => cmpCodeUnit(a.optsName, b.optsName))) {
		body.push(...emitMultipartStruct(plan))
		body.push(...emitOptsStruct(plan))
	}
	return body.join("\n")
}

function clientFile(model: SdkModel, names: GoNames, options: GoSDKOptions): string {
	const bodyStr = buildGoClient(model, names, options, model.ir.auth)

	const stdlib = ["context"]
	const uses = (re: RegExp) => re.test(bodyStr)
	if (uses(/\bjson\./)) stdlib.push("encoding/json")
	if (uses(/\berrors\./)) stdlib.push("errors")
	if (uses(/\bfmt\./)) stdlib.push("fmt")
	if (uses(/\bio\./)) stdlib.push("io")
	if (uses(/\biter\./)) stdlib.push("iter")
	if (uses(/\burl\./)) stdlib.push("net/url")
	const thirdParty = uses(/\bwebsocket\./) ? ["nhooyr.io/websocket"] : []

	const out: string[] = []
	/* blank line after generator header detaches it from package-doc on pkg.go.dev */
	out.push(`// Code generated by honey. DO NOT EDIT.`)
	out.push(``)
	out.push(`package sdk`)
	out.push(``)
	out.push(goImportBlock(stdlib, thirdParty))
	out.push(``)
	out.push(bodyStr)
	return out.join("\n")
}

/* ── public entrypoint ── */

/**
 * Generates a complete Go SDK module from an OpenAPI 3.1 spec.
 * Returns a file map (filename → content) ready to write to disk as a Go module.
 */
export function generateGoSDK(spec: Record<string, unknown>, options: GoSDKOptions = {}): GeneratedGoSDK {
	const input = spec as unknown as OpenApiSpecInput
	const model = buildSdkModel(input)
	const names = buildGoNames(model)
	const serviceMap = serviceMapOf(model.ir)

	const files: Record<string, string> = {}

	/* static runtime templates */
	for (const [name, content] of loadGoRuntimeTemplates()) {
		files[name] = content
	}

	/* schema types claim their names first; the client then hoists into the same table */
	const schemaTypes = buildGoTypes(model, names)
	files["client.go"] = clientFile(model, names, options)
	files["types.go"] = typesFile(schemaTypes, names)
	files["go.mod"] = buildGoMod(options.modulePath)
	files["doc.go"] = buildGoDoc(model.ir.info)

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
