/* Rust SDK emitter — generates a complete Rust crate from an OpenAPI 3.1 spec. */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { collectSDKMethods, isSSEOperation, isStandardErrEnvelope } from "./codegen.ts"
import { detectAuthScheme } from "./codegen-go.ts"
import { methodsOf, namespacesOf, toIR } from "./codegen-ir.ts"
import type { IRNamespace, IROperation } from "./codegen-ir.ts"
import {
	RUST_KEYWORDS,
	renderTopLevelRust,
	renderUseRust,
	rustIdent,
	rustMethodIdent,
	rustPascal,
	rustSnake,
} from "./rust-type-emitter.ts"

export type RustSDKOptions = {
	crateName?: string
	throwOnError?: boolean
	version?: string
	description?: string
	homepage?: string
	repository?: string
	license?: string
}

export type GeneratedRustSDK = {
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

let runtimeCache: Map<string, string> | null = null

export function loadRustRuntimeTemplates(): Map<string, string> {
	if (runtimeCache) return runtimeCache

	const names = [
		"errors.rs",
		"result.rs",
		"runtime.rs",
		"invalidation.rs",
		"invalidation_sync.rs",
		"sse.rs",
		"ws.rs",
		"realtime.rs",
		"runtime_sync.rs",
	]
	const cache = new Map<string, string>()
	for (const name of names) {
		const filePath = fileURLToPath(new URL(`./client-rust/${name}`, import.meta.url))
		let content: string
		try {
			content = readFileSync(filePath, "utf8")
		} catch {
			throw new Error(`loadRustRuntimeTemplates: missing file ${filePath}`)
		}
		cache.set(name, content)
	}
	runtimeCache = cache
	return cache
}

/** Validates and normalises a crate name. Throws if invalid per cargo rules. */
export function validateCrateName(name: string): string {
	if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
		throw new Error(`Invalid crate name: ${JSON.stringify(name)}. Must match ^[a-z][a-z0-9_-]*$`)
	}
	return name
}

function safeResourceName(name: string): string {
	const snake = rustSnake(name)
	return RUST_KEYWORDS.has(snake) ? `${snake}_` : snake
}

function rustResponseType(op: Record<string, unknown>): string {
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return "serde_json::Value"

	for (const [status, response] of Object.entries(responses)) {
		const code = Number.parseInt(status, 10)
		if (Number.isNaN(code) || code < 200 || code >= 300) continue
		if (code === 204) return ""
		const content = response.content as Record<string, Record<string, unknown>> | undefined
		if (!content) return ""
		const jsonSchema = content["application/json"]?.schema as Record<string, unknown> | undefined
		if (!jsonSchema) return "serde_json::Value"
		if (jsonSchema.$ref) {
			return rustPascal((jsonSchema.$ref as string).split("/").pop() ?? "")
		}
		if (jsonSchema.type === "array" && jsonSchema.items) {
			const items = jsonSchema.items as Record<string, unknown>
			if (items.$ref) {
				return `Vec<${rustPascal((items.$ref as string).split("/").pop() ?? "")}>`
			}
			return `Vec<${renderUseRust(items, { decls: new Map(), fieldName: "item", parentName: "Body" })}>`
		}
		if (jsonSchema.type === "string") return "String"
		if (jsonSchema.type === "integer") return "i64"
		if (jsonSchema.type === "number") return "f64"
		if (jsonSchema.type === "boolean") return "bool"
		return "serde_json::Value"
	}
	return "serde_json::Value"
}

type BodyInfo = {
	kind: "json" | "form-url" | "multipart" | "stream" | "none"
	type: string
}

function rustBodyInfo(op: Record<string, unknown>): BodyInfo {
	const requestBody = op.requestBody as Record<string, unknown> | undefined
	if (!requestBody) return { kind: "none", type: "" }
	const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
	if (!content) return { kind: "none", type: "" }

	/* octet-stream takes precedence: a single binary body has no sibling JSON/multipart
	 * entry in practice; detect early so the emitted method accepts a stream/reader. */
	if (content["application/octet-stream"]) {
		return { kind: "stream", type: "" }
	}
	if (content["multipart/form-data"]) {
		return { kind: "multipart", type: "reqwest::multipart::Form" }
	}
	if (content["application/x-www-form-urlencoded"]) {
		return { kind: "form-url", type: "std::collections::HashMap<String, String>" }
	}
	const jsonContent = content["application/json"]
	if (!jsonContent?.schema) return { kind: "none", type: "" }
	const schema = jsonContent.schema as Record<string, unknown>
	if (schema.$ref) {
		return { kind: "json", type: rustPascal((schema.$ref as string).split("/").pop() ?? "") }
	}
	return { kind: "json", type: "serde_json::Value" }
}

type QueryParam = {
	name: string
	required: boolean
	schema: Record<string, unknown>
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

type ErrEnvelopeInfo = {
	keyEnumName: string
	keys: string[]
	status: number
	variantName: string
}

/** Returns per-status error envelope infos for an operation (only standard envelope shapes). */
function getOperationErrorEnvelopes(opId: string, op: Record<string, unknown>): ErrEnvelopeInfo[] {
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return []
	const envelopes: ErrEnvelopeInfo[] = []
	for (const [status, response] of Object.entries(responses)) {
		const code = Number.parseInt(status, 10)
		if (code < 400) continue
		const content = response.content as Record<string, Record<string, unknown>> | undefined
		const schema = content?.["application/json"]?.schema as Record<string, unknown> | undefined
		if (!schema) continue
		const envelope = isStandardErrEnvelope(schema)
		if (!envelope) continue
		const opPascal = pascalizeOpId(opId)
		envelopes.push({
			keyEnumName: `${opPascal}Err${code}Key`,
			keys: envelope.keys,
			status: code,
			variantName: `Status${code}`,
		})
	}
	return envelopes
}

/** Emits per-op typed error enum + key enums + per-status structs. Returns lines for the resource file. */
function emitOperationErrorTypes(opId: string, op: Record<string, unknown>): string[] {
	const envelopes = getOperationErrorEnvelopes(opId, op)
	if (envelopes.length === 0) return []
	const opPascal = pascalizeOpId(opId)
	const errorEnumName = `${opPascal}Error`
	const l: string[] = []

	for (const env of envelopes) {
		/* key enum */
		const variants = env.keys.map((k) => rustPascal(k))
		l.push(`#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]`)
		l.push(`#[serde(rename_all = "snake_case")]`)
		l.push(`pub enum ${env.keyEnumName} {`)
		for (const v of variants) {
			l.push(`\t${v},`)
		}
		l.push(`}`)
		l.push(``)

		/* per-status struct with error_key typed field */
		const structName = `${opPascal}Err${env.status}`
		l.push(`#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]`)
		l.push(`pub struct ${structName} {`)
		l.push(`\tpub error_key: ${env.keyEnumName},`)
		l.push(`\tpub message: String,`)
		l.push(`\tpub fields: std::collections::HashMap<String, Vec<crate::types::ErrField>>,`)
		l.push(`}`)
		l.push(``)
	}

	l.push(`#[derive(Debug)]`)
	l.push(`pub enum ${errorEnumName} {`)
	for (const env of envelopes) {
		const structName = `${opPascal}Err${env.status}`
		l.push(`\t${env.variantName}(${structName}),`)
	}
	l.push(`\tOther(Error),`)
	l.push(`}`)
	l.push(``)
	return l
}

/** Returns the per-op typed error enum name if operation has typed error envelopes, else null. */
function getOpErrorEnumName(opId: string, op: Record<string, unknown>): string | null {
	const envelopes = getOperationErrorEnvelopes(opId, op)
	if (envelopes.length === 0) return null
	return `${pascalizeOpId(opId)}Error`
}

type MethodInfo = {
	/* first segment of operationId — invalidationMap key */
	resource: string
	/* segments[1..] joined with "." — invalidationMap action key */
	action: string
	/* all segments except last — namespace path for struct name generation */
	namePath: string[]
	/* last segment of operationId — used for the Rust fn name */
	methodAction: string
	bodyInfo: BodyInfo
	description: string
	httpMethod: string
	isIdempotent: boolean
	isSSE: boolean
	isWS: boolean
	isRealtime: boolean
	op: Record<string, unknown>
	opId: string
	path: string
	pathParams: string[]
	queryParams: QueryParam[]
	responseType: string
	summary: string
	/** x-invalidate targets from the raw OpenAPI op, falling back to IR extensions. */
	invalidates: string[]
}

function pascalizeOpId(opId: string): string {
	return opId.split(".").map(rustPascal).join("")
}

function invalidatesOf(irOp: IROperation, rawOp: Record<string, unknown>): string[] {
	const fromRaw = rawOp["x-invalidate"]
	if (Array.isArray(fromRaw) && fromRaw.length > 0 && fromRaw.every((x) => typeof x === "string")) {
		return fromRaw as string[]
	}
	const fromIr = irOp.extensions.invalidates
	if (Array.isArray(fromIr) && fromIr.length > 0) return fromIr
	return []
}

function methodInfoFromIROp(irOp: IROperation, rawOp: Record<string, unknown>): MethodInfo {
	const segments = irOp.id.split(".")
	const isTopLevel = segments.length === 1
	const resource = segments[0] ?? irOp.id
	const action = isTopLevel ? "_call" : segments.slice(1).join(".")
	const namePath = segments.slice(0, -1)
	const methodAction = segments[segments.length - 1] ?? irOp.id
	return {
		action,
		bodyInfo: rustBodyInfo(rawOp),
		description: String(rawOp.description ?? ""),
		httpMethod: irOp.method,
		invalidates: invalidatesOf(irOp, rawOp),
		isIdempotent: rawOp["x-idempotency-key"] === true,
		isRealtime: rawOp["x-realtime"] === true,
		isSSE: isSSEOperation(rawOp),
		isWS: rawOp["x-websocket"] === true,
		methodAction,
		namePath,
		op: rawOp,
		opId: irOp.id,
		path: irOp.path,
		pathParams: irOp.params.path.map((p) => p.name),
		queryParams: getQueryParams(rawOp),
		resource,
		responseType: rustResponseType(rawOp),
		summary: String(rawOp.summary ?? ""),
	}
}

function collectMethodsFromIR(ns: IRNamespace, spec: OpenApiSpec): MethodInfo[] {
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
		for (const [, childNs] of namespacesOf(cur)) walk(childNs)
	}
	walk(ns)
	return results
}

function optsStructName(m: MethodInfo): string {
	/* namePath=[checkout,sessions], methodAction=create → CheckoutSessionsCreateOpts
	 * namePath=[], methodAction=getUser → GetUserOpts (top-level single-segment) */
	const prefix = m.namePath.map(rustPascal).join("")
	const suffix = rustPascal(m.methodAction)
	return `${prefix}${suffix}Opts`
}

function emitOptsStruct(m: MethodInfo): string[] {
	const l: string[] = []
	const optsName = optsStructName(m)
	const decls = new Map<string, string>()
	const fields: string[] = []

	const emitted = new Set<string>()
	for (const qp of m.queryParams) {
		const fieldIdent = rustIdent(qp.name)
		emitted.add(fieldIdent)
		const rustType = renderUseRust(qp.schema, {
			decls,
			fieldName: qp.name,
			parentName: optsName,
		})
		const finalType = qp.required ? rustType : `Option<${rustType}>`
		const needsRename = fieldIdent !== qp.name
		const needsSkip = !qp.required
		if (needsRename && needsSkip) {
			fields.push(`\t#[serde(rename = ${JSON.stringify(qp.name)}, skip_serializing_if = "Option::is_none")]`)
		} else if (needsRename) {
			fields.push(`\t#[serde(rename = ${JSON.stringify(qp.name)})]`)
		} else if (needsSkip) {
			fields.push(`\t#[serde(skip_serializing_if = "Option::is_none")]`)
		}
		fields.push(`\tpub ${fieldIdent}: ${finalType},`)
	}

	if (m.isSSE && !emitted.has("last_event_id")) {
		fields.push(`\tpub last_event_id: Option<String>,`)
	}
	if (m.isWS && !emitted.has("reconnect_token")) {
		fields.push(`\tpub reconnect_token: Option<String>,`)
	}
	if (m.isWS && !emitted.has("protocols")) {
		fields.push(`\tpub protocols: Option<Vec<String>>,`)
	}

	/* idempotency-key auto-injection opt-in field (9.a.5). Shared between async + sync
	 * method bodies; emitted once per opts struct. Not meaningful for SSE/WS/realtime. */
	if (m.isIdempotent && !m.isSSE && !m.isWS && !m.isRealtime && !emitted.has("idempotency_key")) {
		fields.push(`\t#[serde(skip_serializing_if = "Option::is_none")]`)
		fields.push(`\tpub idempotency_key: Option<String>,`)
	}

	/* per-call headers for all non-WS methods (SSE included) */
	if (!m.isWS && !emitted.has("headers")) {
		fields.push(`\t#[serde(skip)]`)
		fields.push(`\tpub headers: Option<std::collections::HashMap<String, String>>,`)
	}

	/* per-call timeout for non-SSE non-WS methods */
	if (!m.isSSE && !m.isWS && !emitted.has("timeout")) {
		fields.push(`\t#[serde(skip)]`)
		fields.push(`\tpub timeout: Option<std::time::Duration>,`)
	}

	/* per-call cancellation tokens for non-SSE non-WS methods. Two separate fields:
	   async path consumes `cancel_token` (tokio_util::sync::CancellationToken);
	   sync path consumes `sync_cancel_token` (Arc<AtomicBool>). The opts struct is
	   shared between async + sync emitted methods, so both fields coexist; each
	   path ignores the other. Both #[serde(skip)] — runtime-only state. */
	if (!m.isSSE && !m.isWS) {
		if (!emitted.has("cancel_token")) {
			fields.push(`\t#[serde(skip)]`)
			fields.push(`\tpub cancel_token: Option<tokio_util::sync::CancellationToken>,`)
		}
		if (!emitted.has("sync_cancel_token")) {
			fields.push(`\t#[serde(skip)]`)
			fields.push(`\tpub sync_cancel_token: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,`)
		}
	}

	for (const decl of decls.values()) {
		l.push(decl)
		l.push(``)
	}

	l.push(`#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]`)
	l.push(`pub struct ${optsName} {`)
	l.push(...fields)
	l.push(`}`)
	l.push(``)
	return l
}

function emitSSEMethod(
	m: MethodInfo,
	params: string[],
	cfgAccess: string,
	httpClientAccess: string,
	actionFn: string,
	optsName: string,
	l: string[],
): string[] {
	params.push(`opts: &${optsName}`)
	l.push(`pub fn ${actionFn}(${params.join(", ")}) -> impl Stream<Item = Result<SseEvent, Error>> {`)
	/* clone all opts fields into owned locals before the stream block to avoid capturing &opts lifetime */
	l.push(`\tlet last_event_id_owned = opts.last_event_id.clone();`)
	l.push(`\tlet opts_headers_owned = opts.headers.clone();`)
	for (const qp of m.queryParams) {
		if (qp.name === "last-event-id") continue
		const fieldIdent = rustIdent(qp.name)
		l.push(`\tlet ${fieldIdent}_owned = opts.${fieldIdent}.clone();`)
	}
	const urlExpr = buildUrlExpr(m.path, m.pathParams)
	l.push(`\tlet url_path = ${urlExpr};`)
	const sseQueryMut = m.queryParams.filter((q) => q.name !== "last-event-id").length > 0 ? "mut " : ""
	l.push(`\tlet ${sseQueryMut}query: Vec<(String, String)> = Vec::new();`)
	for (const qp of m.queryParams) {
		if (qp.name === "last-event-id") continue
		const fieldIdent = rustIdent(qp.name)
		if (qp.required) {
			l.push(`\tquery.push((${JSON.stringify(qp.name)}.to_string(), ${fieldIdent}_owned.clone()));`)
		} else {
			l.push(
				`\tif let Some(ref v) = ${fieldIdent}_owned { query.push((${JSON.stringify(qp.name)}.to_string(), v.clone())); }`,
			)
		}
	}
	l.push(`\tlet cfg_clone = ${cfgAccess}.clone();`)
	l.push(`\tlet client_clone = ${httpClientAccess}.clone();`)
	l.push(`\tasync_stream::stream! {`)
	l.push(`\t\tuse crate::sse::parse_sse_stream;`)
	l.push(`\t\tlet mut req_headers = std::collections::HashMap::new();`)
	l.push(`\t\treq_headers.insert("Accept".to_string(), "text/event-stream".to_string());`)
	l.push(`\t\tif let Some(ref lei) = last_event_id_owned {`)
	l.push(`\t\t\treq_headers.insert("Last-Event-ID".to_string(), lei.clone());`)
	l.push(`\t\t}`)
	l.push(`\t\tfor (k, v) in &cfg_clone.headers {`)
	l.push(`\t\t\treq_headers.insert(k.clone(), v.clone());`)
	l.push(`\t\t}`)
	l.push(`\t\tif let Some(ref oh) = opts_headers_owned {`)
	l.push(`\t\t\tfor (k, v) in oh { req_headers.insert(k.clone(), v.clone()); }`)
	l.push(`\t\t}`)
	l.push(`\t\tlet mut req = client_clone`)
	l.push(`\t\t\t.get(format!("{}{}", cfg_clone.base_url, url_path))`)
	l.push(`\t\t\t.header("Accept", "text/event-stream");`)
	l.push(`\t\tif let Some(ref lei) = last_event_id_owned {`)
	l.push(`\t\t\treq = req.header("Last-Event-ID", lei.clone());`)
	l.push(`\t\t}`)
	l.push(`\t\tmatch req.send().await {`)
	l.push(`\t\t\tErr(e) => { yield Err(Error::Transport(e)); return; }`)
	l.push(`\t\t\tOk(r) => {`)
	l.push(`\t\t\t\tuse futures_util::StreamExt;`)
	l.push(`\t\t\t\tlet mut s = std::pin::pin!(parse_sse_stream(r));`)
	l.push(`\t\t\t\twhile let Some(item) = s.next().await { yield item; }`)
	l.push(`\t\t\t}`)
	l.push(`\t\t}`)
	l.push(`\t}`)
	l.push(`}`)
	l.push(``)
	return l
}

function emitWSMethod(
	m: MethodInfo,
	params: string[],
	cfgAccess: string,
	actionFn: string,
	optsName: string,
	l: string[],
): string[] {
	params.push(`opts: &${optsName}`)
	l.push(`pub async fn ${actionFn}(${params.join(", ")}) -> Result<TypedWebSocket, Error> {`)
	const urlExpr = buildUrlExpr(m.path, m.pathParams)
	l.push(`\tlet url_path = ${urlExpr};`)
	l.push(`\tlet mut query_str = String::new();`)
	for (const qp of m.queryParams) {
		if (qp.name === "reconnect_token") continue
		const fieldIdent = rustIdent(qp.name)
		if (qp.required) {
			l.push(`\tif !query_str.is_empty() { query_str.push('&'); }`)
			l.push(
				`\tquery_str.push_str(&format!("{}={}", ${JSON.stringify(qp.name)}, urlencoding::encode(&opts.${fieldIdent})));`,
			)
		} else {
			l.push(`\tif let Some(ref v) = opts.${fieldIdent} {`)
			l.push(`\t\tif !query_str.is_empty() { query_str.push('&'); }`)
			l.push(`\t\tquery_str.push_str(&format!("{}={}", ${JSON.stringify(qp.name)}, urlencoding::encode(v)));`)
			l.push(`\t}`)
		}
	}
	l.push(`\tif let Some(ref rt) = opts.reconnect_token {`)
	l.push(`\t\tif !query_str.is_empty() { query_str.push('&'); }`)
	l.push(`\t\tquery_str.push_str(&format!("reconnect_token={}", urlencoding::encode(rt)));`)
	l.push(`\t}`)
	l.push(`\tlet full_url = if query_str.is_empty() {`)
	l.push(`\t\tformat!("{}{}", ${cfgAccess}.base_url, url_path)`)
	l.push(`\t} else {`)
	l.push(`\t\tformat!("{}{}?{}", ${cfgAccess}.base_url, url_path, query_str)`)
	l.push(`\t};`)
	l.push(`\t/* convert http(s) → ws(s) */`)
	l.push(`\tlet ws_url = full_url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);`)
	l.push(`\tuse tokio_tungstenite::tungstenite::client::IntoClientRequest;`)
	l.push(`\tlet mut req = ws_url.as_str().into_client_request()`)
	l.push(`\t\t.map_err(|e| Error::Other(e.to_string()))?;`)
	l.push(`\tif let Some(ref protos) = opts.protocols {`)
	l.push(`\t\tif !protos.is_empty() {`)
	l.push(`\t\t\treq.headers_mut().insert(`)
	l.push(`\t\t\t\t"Sec-WebSocket-Protocol",`)
	l.push(
		`\t\t\t\tprotos.join(", ").parse().map_err(|e: tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue| Error::Other(e.to_string()))?,`,
	)
	l.push(`\t\t\t);`)
	l.push(`\t\t}`)
	l.push(`\t}`)
	l.push(`\tlet (stream, _) = tokio_tungstenite::connect_async(req).await`)
	l.push(`\t\t.map_err(|e| Error::Other(e.to_string()))?;`)
	l.push(`\tOk(TypedWebSocket::new(stream))`)
	l.push(`}`)
	l.push(``)
	return l
}

function buildAccessors(selfAccess: "self" | "self.client"): { cfg: string; stale: string; httpClient: string } {
	return selfAccess === "self"
		? { cfg: "self.inner.cfg", stale: "self.inner.stale", httpClient: "self.inner.http_client" }
		: { cfg: "self.client.cfg", stale: "self.client.stale", httpClient: "self.client.http_client" }
}

function emitMethod(m: MethodInfo, selfAccess: "self" | "self.client", throwOnError: boolean): string[] {
	const l: string[] = []
	const actionFn = rustMethodIdent(m.action === "_call" ? m.resource : m.methodAction)
	const optsName = optsStructName(m)
	const httpMethod = m.httpMethod

	if (m.summary) {
		l.push(`/// ${m.summary}`)
		if (m.description) l.push(`/// ${m.description}`)
	}

	const params: string[] = [`&self`]
	for (const pp of m.pathParams) {
		params.push(`${rustSnake(pp)}: &str`)
	}
	/* body param depends on body kind; `asyncGenerics` collects generic parameter
	 * declarations for the function signature (only stream bodies need generics
	 * for zero-cost monomorphization over any `Stream<Bytes>`). */
	const asyncGenerics: string[] = []
	const bi = m.bodyInfo
	if (bi.kind === "json") {
		params.push(`body: &${bi.type}`)
	} else if (bi.kind === "form-url") {
		params.push(`body: &std::collections::HashMap<String, String>`)
	} else if (bi.kind === "multipart") {
		/* multipart Form is consumed (not Clone), passed by value */
		params.push(`body: reqwest::multipart::Form`)
	} else if (bi.kind === "stream") {
		/* octet-stream body: generic over any `Stream<Item = Result<Bytes, reqwest::Error>>`
		 * (reqwest::Body::wrap_stream bound). Owned body, single-shot, non-retryable on 401. */
		asyncGenerics.push(`S: futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + Sync + 'static`)
		params.push(`body: S`)
	}

	const { cfg: cfgAccess, stale: staleAccess, httpClient: httpClientAccess } = buildAccessors(selfAccess)

	if (m.isSSE) {
		params.push(`opts: &${optsName}`)
		l.push(`pub fn ${actionFn}(${params.join(", ")}) -> impl Stream<Item = Result<SseEvent, Error>> {`)
		/* clone all opts fields into owned locals before the stream block to avoid capturing &opts lifetime */
		l.push(`\tlet last_event_id_owned = opts.last_event_id.clone();`)
		l.push(`\tlet opts_headers_owned = opts.headers.clone();`)
		for (const qp of m.queryParams) {
			if (qp.name === "last-event-id") continue
			const fieldIdent = rustIdent(qp.name)
			l.push(`\tlet ${fieldIdent}_owned = opts.${fieldIdent}.clone();`)
		}

		const urlExpr = buildUrlExpr(m.path, m.pathParams)
		l.push(`\tlet url_path = ${urlExpr};`)
		const sseQueryMut = m.queryParams.filter((q) => q.name !== "last-event-id").length > 0 ? "mut " : ""
		l.push(`\tlet ${sseQueryMut}query: Vec<(String, String)> = Vec::new();`)
		for (const qp of m.queryParams) {
			if (qp.name === "last-event-id") continue
			const fieldIdent = rustIdent(qp.name)
			if (qp.required) {
				l.push(`\tquery.push((${JSON.stringify(qp.name)}.to_string(), ${fieldIdent}_owned.clone()));`)
			} else {
				l.push(
					`\tif let Some(ref v) = ${fieldIdent}_owned { query.push((${JSON.stringify(qp.name)}.to_string(), v.clone())); }`,
				)
			}
		}
		l.push(`\tlet cfg_clone = ${cfgAccess}.clone();`)
		l.push(`\tlet client_clone = ${httpClientAccess}.clone();`)
		l.push(`\tasync_stream::stream! {`)
		l.push(`\t\tuse crate::sse::parse_sse_stream;`)
		l.push(`\t\tlet mut req_headers = std::collections::HashMap::new();`)
		l.push(`\t\treq_headers.insert("Accept".to_string(), "text/event-stream".to_string());`)
		l.push(`\t\tif let Some(ref lei) = last_event_id_owned {`)
		l.push(`\t\t\treq_headers.insert("Last-Event-ID".to_string(), lei.clone());`)
		l.push(`\t\t}`)
		l.push(`\t\tfor (k, v) in &cfg_clone.headers {`)
		l.push(`\t\t\treq_headers.insert(k.clone(), v.clone());`)
		l.push(`\t\t}`)
		l.push(`\t\tif let Some(ref oh) = opts_headers_owned {`)
		l.push(`\t\t\tfor (k, v) in oh { req_headers.insert(k.clone(), v.clone()); }`)
		l.push(`\t\t}`)
		l.push(`\t\tlet mut req = client_clone`)
		l.push(`\t\t\t.get(format!("{}{}", cfg_clone.base_url, url_path))`)
		l.push(`\t\t\t.header("Accept", "text/event-stream");`)
		l.push(`\t\tif let Some(ref lei) = last_event_id_owned {`)
		l.push(`\t\t\treq = req.header("Last-Event-ID", lei.clone());`)
		l.push(`\t\t}`)
		l.push(`\t\tmatch req.send().await {`)
		l.push(`\t\t\tErr(e) => { yield Err(Error::Transport(e)); return; }`)
		l.push(`\t\t\tOk(r) => {`)
		l.push(`\t\t\t\tuse futures_util::StreamExt;`)
		l.push(`\t\t\t\tlet mut s = std::pin::pin!(parse_sse_stream(r));`)
		l.push(`\t\t\t\twhile let Some(item) = s.next().await { yield item; }`)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (m.isWS) {
		params.push(`opts: &${optsName}`)
		l.push(`pub async fn ${actionFn}(${params.join(", ")}) -> Result<TypedWebSocket, Error> {`)
		const urlExpr = buildUrlExpr(m.path, m.pathParams)
		l.push(`\tlet url_path = ${urlExpr};`)
		l.push(`\tlet mut query_str = String::new();`)
		for (const qp of m.queryParams) {
			if (qp.name === "reconnect_token") continue
			const fieldIdent = rustIdent(qp.name)
			if (qp.required) {
				l.push(`\tif !query_str.is_empty() { query_str.push('&'); }`)
				l.push(
					`\tquery_str.push_str(&format!("{}={}", ${JSON.stringify(qp.name)}, urlencoding::encode(&opts.${fieldIdent})));`,
				)
			} else {
				l.push(`\tif let Some(ref v) = opts.${fieldIdent} {`)
				l.push(`\t\tif !query_str.is_empty() { query_str.push('&'); }`)
				l.push(`\t\tquery_str.push_str(&format!("{}={}", ${JSON.stringify(qp.name)}, urlencoding::encode(v)));`)
				l.push(`\t}`)
			}
		}
		l.push(`\tif let Some(ref rt) = opts.reconnect_token {`)
		l.push(`\t\tif !query_str.is_empty() { query_str.push('&'); }`)
		l.push(`\t\tquery_str.push_str(&format!("reconnect_token={}", urlencoding::encode(rt)));`)
		l.push(`\t}`)
		l.push(`\tlet full_url = if query_str.is_empty() {`)
		l.push(`\t\tformat!("{}{}", ${cfgAccess}.base_url, url_path)`)
		l.push(`\t} else {`)
		l.push(`\t\tformat!("{}{}?{}", ${cfgAccess}.base_url, url_path, query_str)`)
		l.push(`\t};`)
		l.push(`\t/* convert http(s) → ws(s) */`)
		l.push(`\tlet ws_url = full_url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);`)
		l.push(`\tuse tokio_tungstenite::tungstenite::client::IntoClientRequest;`)
		l.push(`\tlet mut req = ws_url.as_str().into_client_request()`)
		l.push(`\t\t.map_err(|e| Error::Other(e.to_string()))?;`)
		l.push(`\tif let Some(ref protos) = opts.protocols {`)
		l.push(`\t\tif !protos.is_empty() {`)
		l.push(`\t\t\treq.headers_mut().insert(`)
		l.push(`\t\t\t\t"Sec-WebSocket-Protocol",`)
		l.push(
			`\t\t\t\tprotos.join(", ").parse().map_err(|e: tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue| Error::Other(e.to_string()))?,`,
		)
		l.push(`\t\t\t);`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`\tlet (stream, _) = tokio_tungstenite::connect_async(req).await`)
		l.push(`\t\t.map_err(|e| Error::Other(e.to_string()))?;`)
		l.push(`\tOk(TypedWebSocket::new(stream))`)
		l.push(`}`)
		l.push(``)
		return l
	}

	/* standard HTTP method */
	const opErrEnum = !throwOnError ? getOpErrorEnumName(m.opId, m.op) : null
	let retType: string
	if (throwOnError) {
		retType = m.responseType !== "" ? `Result<${m.responseType}, Error>` : `Result<(), Error>`
	} else if (opErrEnum && m.responseType !== "") {
		/* typed per-op error: SdkResult<T, OpError> — uses shorthand (no verbose Error default) */
		retType = `Result<SdkResult<${m.responseType}, ${opErrEnum}>, Error>`
	} else {
		/* SdkResult<T> — shorthand, E defaults to Error */
		retType = m.responseType !== "" ? `Result<SdkResult<${m.responseType}>, Error>` : `Result<(), Error>`
	}

	params.push(`opts: &${optsName}`)
	const asyncGenericStr = asyncGenerics.length > 0 ? `<${asyncGenerics.join(", ")}>` : ""
	l.push(`pub async fn ${actionFn}${asyncGenericStr}(${params.join(", ")}) -> ${retType} {`)

	const urlExpr = buildUrlExpr(m.path, m.pathParams)
	l.push(`\tlet url_path = ${urlExpr};`)
	const queryMut = m.queryParams.length > 0 ? "mut " : ""
	l.push(`\tlet ${queryMut}query: Vec<(String, String)> = Vec::new();`)
	emitQueryParamLoop(m.queryParams, l)

	/* RequestBody variant based on body kind */
	let bodyArg: string
	if (bi.kind === "json") {
		bodyArg = `crate::runtime::RequestBody::Json(&serde_json::to_value(body).unwrap_or_default())`
	} else if (bi.kind === "form-url") {
		bodyArg = `crate::runtime::RequestBody::FormUrl(body)`
	} else if (bi.kind === "multipart") {
		bodyArg = `crate::runtime::RequestBody::Multipart(body)`
	} else if (bi.kind === "stream") {
		bodyArg = `crate::runtime::RequestBody::Stream(reqwest::Body::wrap_stream(body))`
	} else {
		bodyArg = `crate::runtime::RequestBody::None`
	}

	/* invalidation pre-flight — build path-params map, interpolate to concrete
	 * selector, snapshot RequestMeta from the tracker. Emitted only for ops
	 * with x-invalidate; BuildRequestMeta short-circuits to None when disabled. */
	const hasInvalidate = m.invalidates.length > 0
	if (hasInvalidate) {
		const pathParamsMapExpr =
			m.pathParams.length > 0
				? `std::collections::HashMap::from([${m.pathParams.map((p) => `(${JSON.stringify(p)}.to_string(), ${rustSnake(p)}.to_string())`).join(", ")}])`
				: `std::collections::HashMap::<String, String>::new()`
		l.push(`\tlet _path_params_map: std::collections::HashMap<String, String> = ${pathParamsMapExpr};`)
		l.push(
			`\tlet _concrete_path = crate::invalidation::interpolate_path(${JSON.stringify(m.path)}, &_path_params_map).unwrap_or_else(|_| ${JSON.stringify(m.path)}.to_string());`,
		)
		l.push(`\tlet _concrete_selector = format!("${httpMethod} {}", _concrete_path);`)
		l.push(`\tlet _request_meta: Option<crate::invalidation::RequestMeta> = match ${staleAccess} {`)
		l.push(
			`\t\tSome(ref s) => s.build_request_meta(&_concrete_selector, &_concrete_path, ${JSON.stringify(httpMethod)}).await,`,
		)
		l.push(`\t\tNone => None,`)
		l.push(`\t};`)
	}

	/* idempotency-key auto-injection: build a local headers map that carries the key.
	 * opts is &-borrowed, so mutation happens on a clone. Precedence:
	 *   explicit opts.headers["Idempotency-Key"] (case-insensitive) → kept
	 *   opts.idempotency_key                                         → used
	 *   else                                                         → uuid::Uuid::new_v4()
	 * Matches TS/Python/Go emitter semantics (9.a.2 / 9.a.3 / 9.a.4). */
	const emitIdem = m.isIdempotent && !m.isSSE && !m.isWS && !m.isRealtime
	if (emitIdem) {
		l.push(
			`\tlet mut _call_headers: std::collections::HashMap<String, String> = opts.headers.clone().unwrap_or_default();`,
		)
		l.push(`\tlet _has_idem = _call_headers.keys().any(|k| k.eq_ignore_ascii_case("Idempotency-Key"));`)
		l.push(`\tif !_has_idem {`)
		l.push(`\t\tlet _k = opts.idempotency_key.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());`)
		l.push(`\t\t_call_headers.insert("Idempotency-Key".to_string(), _k);`)
		l.push(`\t}`)
	}

	const operationStr = JSON.stringify(`${httpMethod} ${m.path}`)
	const requestMetaArg = hasInvalidate ? `_request_meta.as_ref()` : `None`
	const headersArg = emitIdem ? `Some(&_call_headers)` : `opts.headers.as_ref()`
	l.push(`\tlet result = crate::runtime::do_request(`)
	l.push(`\t\t&${httpClientAccess},`)
	l.push(`\t\t&${cfgAccess},`)
	l.push(`\t\treqwest::Method::${httpMethod},`)
	l.push(`\t\t&url_path,`)
	l.push(`\t\t&query,`)
	l.push(`\t\t${bodyArg},`)
	l.push(`\t\t${headersArg},`)
	l.push(`\t\topts.timeout,`)
	l.push(`\t\topts.cancel_token.clone(),`)
	l.push(`\t\t${operationStr},`)
	l.push(`\t\t${requestMetaArg},`)
	l.push(`\t).await?;`)

	/* invalidation post-flight — expand templated x-invalidate targets with the
	 * call's concrete params (TS parity: GET /users/{id} → GET /users/abc),
	 * mark them stale, then clear keys that were already stale before this
	 * mutation completed (seq-bounded to avoid clobbering newer invalidations). */
	if (hasInvalidate) {
		l.push(`\tif let Some(ref stale) = ${staleAccess} {`)
		l.push(`\t\tif let Some(resource_map) = crate::client::INVALIDATION_MAP.get(${JSON.stringify(m.resource)}) {`)
		l.push(`\t\t\tif let Some(entry) = resource_map.get(${JSON.stringify(m.action)}) {`)
		l.push(`\t\t\t\tlet targets: Vec<String> = entry.invalidate.iter().map(|s| s.to_string()).collect();`)
		l.push(`\t\t\t\tstale.mark_stale(&targets, &_path_params_map, &_concrete_selector).await;`)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t\tif let Some(ref meta) = _request_meta {`)
		l.push(`\t\t\tif meta.is_stale {`)
		l.push(
			`\t\t\t\tstale.clear_stale(&_concrete_selector, &_concrete_path, ${JSON.stringify(httpMethod)}, meta.seq_snapshot).await;`,
		)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t}`)
	}

	if (m.responseType === "") {
		l.push(`\tOk(())`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (throwOnError) {
		l.push(`\tlet out: ${m.responseType} = serde_json::from_slice(&result.body)?;`)
		l.push(`\tOk(out)`)
	} else {
		l.push(`\tlet out: ${m.responseType} = serde_json::from_slice(&result.body)?;`)
		l.push(
			`\tOk(SdkResult { data: Some(out), error: None, status: result.status, response: crate::runtime::ResponseMeta { status: result.status, headers: result.headers.clone(), url: result.url.clone(), body: result.body.clone() } })`,
		)
	}

	l.push(`}`)
	l.push(``)
	return l
}

/** emitSyncMethod is the blocking twin of emitMethod — no async, calls do_request_blocking. */
function emitSyncMethod(m: MethodInfo, selfAccess: "self" | "self.client", throwOnError: boolean): string[] {
	/* SSE and WS operations have no sync variant */
	if (m.isSSE || m.isWS) return []

	const l: string[] = []
	const actionFn = rustMethodIdent(m.action === "_call" ? m.resource : m.methodAction)
	const optsName = optsStructName(m)
	const httpMethod = m.httpMethod

	if (m.summary) {
		l.push(`/// ${m.summary}`)
		if (m.description) l.push(`/// ${m.description}`)
	}

	const params: string[] = [`&self`]
	for (const pp of m.pathParams) {
		params.push(`${rustSnake(pp)}: &str`)
	}
	/* sync generics: stream body is generic over `R: Read + Send + 'static`
	 * (reqwest::blocking::Body::new bound). */
	const syncGenerics: string[] = []
	const bi = m.bodyInfo
	if (bi.kind === "json") {
		params.push(`body: &${bi.type}`)
	} else if (bi.kind === "form-url") {
		params.push(`body: &std::collections::HashMap<String, String>`)
	} else if (bi.kind === "multipart") {
		params.push(`body: reqwest::blocking::multipart::Form`)
	} else if (bi.kind === "stream") {
		syncGenerics.push(`R: std::io::Read + Send + 'static`)
		params.push(`body: R`)
	}

	const { cfg: cfgAccess, stale: staleAccess, httpClient: httpClientAccess } = buildAccessors(selfAccess)

	const opErrEnum = !throwOnError ? getOpErrorEnumName(m.opId, m.op) : null
	let retType: string
	if (throwOnError) {
		retType = m.responseType !== "" ? `Result<${m.responseType}, Error>` : `Result<(), Error>`
	} else if (opErrEnum && m.responseType !== "") {
		retType = `Result<SdkResult<${m.responseType}, ${opErrEnum}>, Error>`
	} else {
		retType = m.responseType !== "" ? `Result<SdkResult<${m.responseType}>, Error>` : `Result<(), Error>`
	}

	params.push(`opts: &${optsName}`)
	const syncGenericStr = syncGenerics.length > 0 ? `<${syncGenerics.join(", ")}>` : ""
	l.push(`pub fn ${actionFn}${syncGenericStr}(${params.join(", ")}) -> ${retType} {`)

	const urlExpr = buildUrlExpr(m.path, m.pathParams)
	l.push(`\tlet url_path = ${urlExpr};`)
	const queryMut = m.queryParams.length > 0 ? "mut " : ""
	l.push(`\tlet ${queryMut}query: Vec<(String, String)> = Vec::new();`)
	emitQueryParamLoop(m.queryParams, l)

	let bodyArg: string
	if (bi.kind === "json") {
		bodyArg = `crate::runtime_sync::SyncRequestBody::Json(&serde_json::to_value(body).unwrap_or_default())`
	} else if (bi.kind === "form-url") {
		bodyArg = `crate::runtime_sync::SyncRequestBody::FormUrl(body)`
	} else if (bi.kind === "multipart") {
		bodyArg = `crate::runtime_sync::SyncRequestBody::Multipart(body)`
	} else if (bi.kind === "stream") {
		bodyArg = `crate::runtime_sync::SyncRequestBody::Stream(reqwest::blocking::Body::new(body))`
	} else {
		bodyArg = `crate::runtime_sync::SyncRequestBody::None`
	}

	/* invalidation pre-flight (sync) — same shape as async, no .await. */
	const hasInvalidate = m.invalidates.length > 0
	if (hasInvalidate) {
		const pathParamsMapExpr =
			m.pathParams.length > 0
				? `std::collections::HashMap::from([${m.pathParams.map((p) => `(${JSON.stringify(p)}.to_string(), ${rustSnake(p)}.to_string())`).join(", ")}])`
				: `std::collections::HashMap::<String, String>::new()`
		l.push(`\tlet _path_params_map: std::collections::HashMap<String, String> = ${pathParamsMapExpr};`)
		l.push(
			`\tlet _concrete_path = crate::invalidation::interpolate_path(${JSON.stringify(m.path)}, &_path_params_map).unwrap_or_else(|_| ${JSON.stringify(m.path)}.to_string());`,
		)
		l.push(`\tlet _concrete_selector = format!("${httpMethod} {}", _concrete_path);`)
		l.push(`\tlet _request_meta: Option<crate::invalidation::RequestMeta> = match ${staleAccess} {`)
		l.push(
			`\t\tSome(ref s) => s.build_request_meta(&_concrete_selector, &_concrete_path, ${JSON.stringify(httpMethod)}),`,
		)
		l.push(`\t\tNone => None,`)
		l.push(`\t};`)
	}

	/* idempotency-key auto-injection (sync mirror of async path — same semantics). */
	const emitIdem = m.isIdempotent && !m.isSSE && !m.isWS && !m.isRealtime
	if (emitIdem) {
		l.push(
			`\tlet mut _call_headers: std::collections::HashMap<String, String> = opts.headers.clone().unwrap_or_default();`,
		)
		l.push(`\tlet _has_idem = _call_headers.keys().any(|k| k.eq_ignore_ascii_case("Idempotency-Key"));`)
		l.push(`\tif !_has_idem {`)
		l.push(`\t\tlet _k = opts.idempotency_key.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());`)
		l.push(`\t\t_call_headers.insert("Idempotency-Key".to_string(), _k);`)
		l.push(`\t}`)
	}

	const operationStr = JSON.stringify(`${httpMethod} ${m.path}`)
	const requestMetaArg = hasInvalidate ? `_request_meta.as_ref()` : `None`
	const headersArg = emitIdem ? `Some(&_call_headers)` : `opts.headers.as_ref()`
	l.push(`\tlet result = crate::runtime_sync::do_request_blocking(`)
	l.push(`\t\t&${httpClientAccess},`)
	l.push(`\t\t&${cfgAccess},`)
	l.push(`\t\treqwest::Method::${httpMethod},`)
	l.push(`\t\t&url_path,`)
	l.push(`\t\t&query,`)
	l.push(`\t\t${bodyArg},`)
	l.push(`\t\t${headersArg},`)
	l.push(`\t\topts.timeout,`)
	l.push(`\t\topts.sync_cancel_token.clone(),`)
	l.push(`\t\t${operationStr},`)
	l.push(`\t\t${requestMetaArg},`)
	l.push(`\t)?;`)

	if (hasInvalidate) {
		l.push(`\tif let Some(ref stale) = ${staleAccess} {`)
		l.push(`\t\tif let Some(resource_map) = crate::client::INVALIDATION_MAP.get(${JSON.stringify(m.resource)}) {`)
		l.push(`\t\t\tif let Some(entry) = resource_map.get(${JSON.stringify(m.action)}) {`)
		l.push(`\t\t\t\tlet targets: Vec<String> = entry.invalidate.iter().map(|s| s.to_string()).collect();`)
		l.push(`\t\t\t\tstale.mark_stale(&targets, &_path_params_map, &_concrete_selector);`)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t\tif let Some(ref meta) = _request_meta {`)
		l.push(`\t\t\tif meta.is_stale {`)
		l.push(
			`\t\t\t\tstale.clear_stale(&_concrete_selector, &_concrete_path, ${JSON.stringify(httpMethod)}, meta.seq_snapshot);`,
		)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t}`)
	}

	if (m.responseType === "") {
		l.push(`\tOk(())`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (throwOnError) {
		l.push(`\tlet out: ${m.responseType} = serde_json::from_slice(&result.body)?;`)
		l.push(`\tOk(out)`)
	} else {
		l.push(`\tlet out: ${m.responseType} = serde_json::from_slice(&result.body)?;`)
		l.push(
			`\tOk(SdkResult { data: Some(out), error: None, status: result.status, response: crate::runtime::ResponseMeta { status: result.status, headers: result.headers.clone(), url: result.url.clone(), body: result.body.clone() } })`,
		)
	}

	l.push(`}`)
	l.push(``)
	return l
}

/** Builds a Rust expression that produces an owned `String` from a query-param value place.
 * `valuePlace` is the place expression — either `opts.<field>` (required, owned T) or
 * `v` from `if let Some(ref v) = opts.<field>` (optional, &T). Both accept the same method
 * call syntax thanks to Rust's auto-deref on method dispatch.
 * - String → `.clone()` (owned copy)
 * - i64 / f64 / bool → `.to_string()` via `Display`
 * - Enums + complex types → `serde_json::to_string`; strip surrounding quotes so plain-string
 *   enum serialisations land as `value` not `"value"` in the URL.
 */
function rustQueryValueToString(schema: Record<string, unknown>, valuePlace: string): string {
	if (Array.isArray(schema.enum)) {
		return `serde_json::to_string(&${valuePlace}).map(|s| s.trim_matches('"').to_string()).unwrap_or_default()`
	}
	const t = schema.type
	if (t === "string") return `${valuePlace}.clone()`
	if (t === "integer" || t === "number" || t === "boolean") return `${valuePlace}.to_string()`
	return `serde_json::to_string(&${valuePlace}).unwrap_or_default()`
}

/** Emits query param push lines for a standard REST method (not SSE/WS). */
function emitQueryParamLoop(qps: QueryParam[], l: string[]): void {
	for (const qp of qps) {
		const fieldIdent = rustIdent(qp.name)
		if (qp.required) {
			const expr = rustQueryValueToString(qp.schema, `opts.${fieldIdent}`)
			l.push(`\tquery.push((${JSON.stringify(qp.name)}.to_string(), ${expr}));`)
		} else {
			const expr = rustQueryValueToString(qp.schema, `v`)
			l.push(
				`\tif let Some(ref v) = opts.${fieldIdent} { query.push((${JSON.stringify(qp.name)}.to_string(), ${expr})); }`,
			)
		}
	}
}

function buildUrlExpr(path: string, pathParams: string[]): string {
	/* always returns a String (not &str) so &url_path is &String, not &&str */
	if (pathParams.length === 0) return `${JSON.stringify(path)}.to_string()`
	let fmtStr = path
	const args: string[] = []
	for (const p of pathParams) {
		fmtStr = fmtStr.replace(`{${p}}`, `{}`)
		args.push(`urlencoding::encode(${rustSnake(p)}).into_owned()`)
	}
	return `format!(${JSON.stringify(fmtStr)}, ${args.join(", ")})`
}

/* Schema names defined in Rust runtime files — skip to avoid redeclaration. */
const RUST_RUNTIME_TYPES = new Set([
	"ClientConfig",
	"Error",
	"InvalidationConfig",
	"LogEntry",
	"OnAuthExpiredHook",
	"OnLogHook",
	"OnRequestHook",
	"OnResponseHook",
	"RequestBody",
	"RequestContext",
	"RequestMeta",
	"ResponseContext",
	"ResponseMeta",
	"SdkResult",
	"SseEvent",
	"StaleEntry",
	"StaleTracker",
	"StaleTrackerSync",
	"StatusError",
	"SyncClientConfig",
	"SyncRequestBody",
	"SyncRequestContext",
	"SyncResponseContext",
	"TypedWebSocket",
])

function buildRustTypes(spec: OpenApiSpec): string {
	const schemas = spec.components?.schemas ?? {}
	const l: string[] = []
	l.push(`/* Code generated by honey. DO NOT EDIT. */`)
	l.push(``)
	l.push(`#![allow(unused_imports)]`)
	l.push(`use serde::{Serialize, Deserialize};`)
	l.push(`use serde_repr::{Serialize_repr, Deserialize_repr};`)
	l.push(`use std::collections::HashMap;`)
	l.push(``)

	const sortedSchemas = Object.entries(schemas)
		.filter(([name]) => !RUST_RUNTIME_TYPES.has(name))
		.sort(([a], [b]) => a.localeCompare(b))
	const body: string[] = []
	const decls = new Map<string, string>()

	/* always emit shared error-envelope field type used by per-op error structs */
	body.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
	body.push(`pub struct ErrField {`)
	body.push(`\tpub error_key: String,`)
	body.push(`\tpub message: String,`)
	body.push(`\tpub path: String,`)
	body.push(`}`)
	body.push(``)

	for (const [name, schema] of sortedSchemas) {
		const rustType = renderTopLevelRust(name, schema, decls)
		body.push(rustType)
		body.push(``)
	}

	const hoistedNames = [...decls.keys()].sort((a, b) => a.localeCompare(b))
	for (const hname of hoistedNames) {
		body.push(decls.get(hname) as string)
		body.push(``)
	}

	l.push(body.join("\n"))
	return l.join("\n")
}

function buildCargoToml(
	crateName: string,
	meta: { version: string; description?: string; homepage?: string; repository?: string; license?: string },
): string {
	const pkgLines = [
		`[package]`,
		`name = "${crateName}"`,
		`version = ${JSON.stringify(meta.version)}`,
		`edition = "2021"`,
		`rust-version = "1.75"`,
	]
	if (meta.description) pkgLines.push(`description = ${JSON.stringify(meta.description)}`)
	if (meta.homepage) pkgLines.push(`homepage = ${JSON.stringify(meta.homepage)}`)
	if (meta.repository) pkgLines.push(`repository = ${JSON.stringify(meta.repository)}`)
	if (meta.license) pkgLines.push(`license = ${JSON.stringify(meta.license)}`)
	return [
		...pkgLines,
		``,
		`[dependencies]`,
		`tokio = { version = "^1.40", features = ["rt-multi-thread", "macros", "sync", "time"] }`,
		`tokio-util = { version = "^0.7", features = ["rt"] }`,
		`reqwest = { version = "^0.12", default-features = false, features = ["json", "stream", "rustls-tls", "multipart", "blocking"] }`,
		`tokio-tungstenite = { version = "^0.24", features = ["rustls-tls-webpki-roots"] }`,
		`futures = "^0.3"`,
		`futures-util = "^0.3"`,
		`serde = { version = "^1.0", features = ["derive"] }`,
		`serde_json = "^1.0"`,
		`serde_repr = "^0.1"`,
		`url = "^2.5"`,
		`urlencoding = "^2.1"`,
		`regex = "^1.10"`,
		`once_cell = "^1.20"`,
		`bytes = "^1.7"`,
		`uuid = { version = "^1", features = ["v4"] }`,
		`async-trait = "^0.1"`,
		`async-stream = "^0.3"`,
		``,
	].join("\n")
}

function buildLibRs(hasRealtime: boolean): string {
	const lines = [
		`/* Code generated by honey. DO NOT EDIT. */`,
		``,
		`pub mod client;`,
		`pub mod errors;`,
		`pub mod invalidation;`,
		`pub mod invalidation_sync;`,
		`pub mod resources;`,
		`pub mod result;`,
		`pub mod runtime;`,
		`pub mod runtime_sync;`,
		`pub mod sse;`,
		`pub mod types;`,
		`pub mod ws;`,
	]
	if (hasRealtime) {
		lines.push(`pub mod realtime;`)
	}
	lines.push(``)
	lines.push(`pub use client::Client;`)
	lines.push(`pub use client::SyncClient;`)
	lines.push(`pub use errors::Error;`)
	lines.push(`pub use runtime::ClientConfig;`)
	lines.push(`pub use runtime_sync::SyncClientConfig;`)
	lines.push(`pub use result::SdkResult;`)
	lines.push(``)
	return lines.join("\n")
}

function buildRustClient(spec: OpenApiSpec, options: RustSDKOptions, ir: ReturnType<typeof toIR>): string {
	const throwOnError = options.throwOnError ?? true
	const methods = collectMethodsFromIR(ir.tree, spec)
	const topLevel = methods.filter((m) => m.action === "_call")

	const serviceMap = collectSDKMethods(spec as Parameters<typeof collectSDKMethods>[0]).serviceMap

	const body: string[] = []

	/* build a realtime lookup map from collected methods */
	const realtimeLookup = new Map<string, boolean>()
	for (const m of methods) {
		realtimeLookup.set(`${m.resource}.${m.action}`, m.isRealtime)
	}

	body.push(`pub(crate) struct ServiceEntry {`)
	body.push(`\tpub method: &'static str,`)
	body.push(`\tpub path: &'static str,`)
	body.push(`\tpub params: &'static [&'static str],`)
	body.push(`\tpub sse: bool,`)
	body.push(`\tpub ws: bool,`)
	body.push(`\tpub realtime: bool,`)
	body.push(`\tpub invalidate: &'static [&'static str],`)
	body.push(`}`)
	body.push(``)

	body.push(
		`pub(crate) static INVALIDATION_MAP: once_cell::sync::Lazy<std::collections::HashMap<&'static str, std::collections::HashMap<&'static str, ServiceEntry>>> =`,
	)
	body.push(`\tonce_cell::sync::Lazy::new(|| {`)
	body.push(`\t\tlet mut map = std::collections::HashMap::new();`)
	for (const [resource, actions] of Object.entries(serviceMap).sort(([a], [b]) => a.localeCompare(b))) {
		body.push(`\t\t{`)
		body.push(`\t\t\tlet mut resource_map = std::collections::HashMap::new();`)
		for (const [action, entry] of Object.entries(actions as Record<string, Record<string, unknown>>).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const inv = entry.invalidate as string[] | undefined
			const invStr = inv && inv.length > 0 ? `&[${inv.map((s) => JSON.stringify(s)).join(", ")}]` : `&[]`
			const params = entry.params as string[] | undefined
			const paramsStr = params && params.length > 0 ? `&[${params.map((s) => JSON.stringify(s)).join(", ")}]` : `&[]`
			const isRealtime = realtimeLookup.get(`${resource}.${action}`) ?? false
			body.push(
				`\t\t\tresource_map.insert(${JSON.stringify(action)}, ServiceEntry { method: ${JSON.stringify(String(entry.method))}, path: ${JSON.stringify(String(entry.path))}, params: ${paramsStr}, sse: ${entry.sse === true}, ws: ${entry.ws === true}, realtime: ${isRealtime}, invalidate: ${invStr} });`,
			)
		}
		body.push(`\t\t\tmap.insert(${JSON.stringify(resource)}, resource_map);`)
		body.push(`\t\t}`)
	}
	body.push(`\t\tmap`)
	body.push(`\t});`)
	body.push(``)

	body.push(`pub(crate) struct ClientInner {`)
	body.push(`\tpub(crate) cfg: crate::runtime::ClientConfig,`)
	body.push(`\tpub(crate) stale: Option<crate::invalidation::StaleTracker>,`)
	body.push(`\tpub(crate) http_client: reqwest::Client,`)
	body.push(`}`)
	body.push(``)

	const auth = detectAuthScheme(spec as Record<string, unknown>)
	body.push(`/// Client is the generated SDK client.`)
	body.push(`pub struct Client {`)
	body.push(`\tpub(crate) inner: std::sync::Arc<ClientInner>,`)
	for (const [seg] of namespacesOf(ir.tree)) {
		const safeName = safeResourceName(seg)
		body.push(`\t${rustSnake(safeName)}: ${rustPascal(safeName)}Resource,`)
	}
	body.push(`}`)
	body.push(``)

	body.push(`impl Client {`)
	body.push(`\t/// new creates a new SDK client. base_url must be non-empty.`)
	body.push(`\tpub fn new(mut cfg: crate::runtime::ClientConfig) -> Self {`)
	body.push(`\t\tif cfg.base_url.is_empty() {`)
	body.push(`\t\t\tpanic!("honey sdk: ClientConfig.base_url must not be empty");`)
	body.push(`\t\t}`)
	body.push(`\t\t/* http_client: None → build a default reqwest::Client */`)
	body.push(`\t\tlet http_client = if cfg.http_client.is_none() {`)
	body.push(`\t\t\treqwest::Client::new()`)
	body.push(`\t\t} else {`)
	body.push(`\t\t\tcfg.http_client.take().unwrap()`)
	body.push(`\t\t};`)
	body.push(`\t\tif cfg.auth_header_name.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_name = Some(${JSON.stringify(auth.headerName)}.to_string());`)
	body.push(`\t\t}`)
	body.push(`\t\tif cfg.auth_header_prefix.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_prefix = Some(${JSON.stringify(auth.prefix)}.to_string());`)
	body.push(`\t\t}`)
	body.push(`\t\tlet stale = if let Some(ref inv) = cfg.invalidation {`)
	body.push(`\t\t\tif inv.stale_time > 0 {`)
	body.push(`\t\t\t\tSome(crate::invalidation::StaleTracker::new(Some(inv)))`)
	body.push(`\t\t\t} else { None }`)
	body.push(`\t\t} else { None };`)
	body.push(`\t\tlet inner = std::sync::Arc::new(ClientInner { cfg, stale, http_client });`)
	body.push(`\t\tClient {`)
	for (const [seg] of namespacesOf(ir.tree)) {
		const safeName = safeResourceName(seg)
		body.push(
			`\t\t\t${rustSnake(safeName)}: crate::resources::${rustSnake(safeName)}::new_${rustSnake(safeName)}_resource(&inner),`,
		)
	}
	body.push(`\t\t\tinner,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(``)

	for (const [seg] of namespacesOf(ir.tree)) {
		const safeName = safeResourceName(seg)
		const structName = `${rustPascal(safeName)}Resource`
		body.push(`\t/// ${rustSnake(safeName)} returns a reference to the ${structName}.`)
		body.push(`\tpub fn ${rustSnake(safeName)}(&self) -> &${structName} {`)
		body.push(`\t\t&self.${rustSnake(safeName)}`)
		body.push(`\t}`)
		body.push(``)
	}

	for (const m of topLevel.sort((a, b) => a.resource.localeCompare(b.resource))) {
		body.push(...emitMethod(m, "self", throwOnError))
	}

	/* is_stale — public predicate consumers call to drive refetch decisions.
	 * Delegates to the StaleTracker; returns false when invalidation is disabled. */
	body.push(`\t/// is_stale reports whether (method, path) is currently within an active stale window.`)
	body.push(`\tpub async fn is_stale(&self, method: &str, path: &str) -> bool {`)
	body.push(`\t\tmatch self.inner.stale {`)
	body.push(`\t\t\tSome(ref s) => s.is_stale(method, path).await,`)
	body.push(`\t\t\tNone => false,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(``)

	body.push(`}`)
	body.push(``)

	const topLevelOptsEmitted = new Set<string>()
	for (const m of topLevel.sort((a, b) => a.opId.localeCompare(b.opId))) {
		const optsName = optsStructName(m)
		if (topLevelOptsEmitted.has(optsName)) continue
		topLevelOptsEmitted.add(optsName)
		body.push(...emitOptsStruct(m))
	}

	/* ── SyncClient ── */

	/* root namespaces that have at least one non-SSE/non-WS descendant method */
	const syncNsSegs = namespacesOf(ir.tree)
		.map(([seg]) => seg)
		.filter((seg) => {
			const nsMs = methods.filter((m) => !m.isSSE && !m.isWS && m.namePath[0] === seg)
			return nsMs.length > 0
		})

	body.push(`pub(crate) struct SyncClientInner {`)
	body.push(`\tpub(crate) cfg: crate::runtime_sync::SyncClientConfig,`)
	body.push(`\tpub(crate) stale: Option<crate::invalidation_sync::StaleTrackerSync>,`)
	body.push(`\tpub(crate) http_client: reqwest::blocking::Client,`)
	body.push(`}`)
	body.push(``)

	body.push(`/// SyncClient is the generated blocking SDK client.`)
	body.push(`/// WARNING: Do not use from inside a tokio async task — reqwest blocking will deadlock.`)
	body.push(`pub struct SyncClient {`)
	body.push(`\tpub(crate) inner: std::sync::Arc<SyncClientInner>,`)
	for (const seg of syncNsSegs) {
		const safeName = safeResourceName(seg)
		body.push(`\t${rustSnake(safeName)}: ${rustPascal(safeName)}ResourceSync,`)
	}
	body.push(`}`)
	body.push(``)

	body.push(`impl SyncClient {`)
	body.push(`\t/// new creates a new blocking SDK client. base_url must be non-empty.`)
	body.push(`\tpub fn new(mut cfg: crate::runtime_sync::SyncClientConfig) -> Self {`)
	body.push(`\t\tif cfg.base_url.is_empty() {`)
	body.push(`\t\t\tpanic!("honey sdk: SyncClientConfig.base_url must not be empty");`)
	body.push(`\t\t}`)
	body.push(`\t\tlet http_client = if cfg.http_client.is_none() {`)
	body.push(`\t\t\treqwest::blocking::Client::new()`)
	body.push(`\t\t} else {`)
	body.push(`\t\t\tcfg.http_client.take().unwrap()`)
	body.push(`\t\t};`)
	body.push(`\t\tif cfg.auth_header_name.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_name = Some(${JSON.stringify(auth.headerName)}.to_string());`)
	body.push(`\t\t}`)
	body.push(`\t\tif cfg.auth_header_prefix.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_prefix = Some(${JSON.stringify(auth.prefix)}.to_string());`)
	body.push(`\t\t}`)
	body.push(`\t\tlet stale = if let Some(ref inv) = cfg.invalidation {`)
	body.push(`\t\t\tif inv.stale_time > 0 {`)
	body.push(`\t\t\t\tSome(crate::invalidation_sync::StaleTrackerSync::new(Some(inv)))`)
	body.push(`\t\t\t} else { None }`)
	body.push(`\t\t} else { None };`)
	body.push(`\t\tlet inner = std::sync::Arc::new(SyncClientInner { cfg, stale, http_client });`)
	body.push(`\t\tSyncClient {`)
	for (const seg of syncNsSegs) {
		const safeName = safeResourceName(seg)
		body.push(
			`\t\t\t${rustSnake(safeName)}: ${rustPascal(safeName)}ResourceSync { client: std::sync::Arc::clone(&inner) },`,
		)
	}
	body.push(`\t\t\tinner,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(``)

	for (const seg of syncNsSegs) {
		const safeName = safeResourceName(seg)
		const structName = `${rustPascal(safeName)}ResourceSync`
		body.push(`\t/// ${rustSnake(safeName)} returns a reference to the ${structName}.`)
		body.push(`\tpub fn ${rustSnake(safeName)}(&self) -> &${structName} {`)
		body.push(`\t\t&self.${rustSnake(safeName)}`)
		body.push(`\t}`)
		body.push(``)
	}

	/* top-level sync methods (operationIds without resource.action split, e.g. `getUser`)
	   mirror the async Client's top-level methods. SSE/WS skipped — no sync variant. */
	const syncTopLevel = topLevel.filter((m) => !m.isSSE && !m.isWS)
	for (const m of syncTopLevel.sort((a, b) => a.resource.localeCompare(b.resource))) {
		body.push(...emitSyncMethod(m, "self", throwOnError))
	}

	/* is_stale (sync) — public predicate consumers call to drive refetch decisions.
	 * Delegates to the StaleTrackerSync; returns false when invalidation is disabled. */
	body.push(`\t/// is_stale reports whether (method, path) is currently within an active stale window.`)
	body.push(`\tpub fn is_stale(&self, method: &str, path: &str) -> bool {`)
	body.push(`\t\tmatch self.inner.stale {`)
	body.push(`\t\t\tSome(ref s) => s.is_stale(method, path),`)
	body.push(`\t\t\tNone => false,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(``)

	body.push(`}`)
	body.push(``)

	const bodyStr = body.join("\n")

	const out: string[] = []
	out.push(`/* Code generated by honey. DO NOT EDIT. */`)
	out.push(``)
	out.push(`#![allow(unused_imports, unused_variables, dead_code)]`)
	out.push(`use std::sync::Arc;`)
	out.push(`use once_cell;`)
	out.push(`use reqwest;`)
	out.push(`use tokio_tungstenite;`)
	out.push(`use urlencoding;`)
	out.push(`use futures_util::{self, Stream};`)
	out.push(`use crate::errors::Error;`)
	out.push(`use crate::resources::*;`)
	out.push(`use crate::result::SdkResult;`)
	out.push(`use crate::runtime::ClientConfig;`)
	out.push(`use crate::sse::SseEvent;`)
	out.push(`use crate::types::*;`)
	out.push(`use crate::ws::TypedWebSocket;`)
	out.push(``)
	out.push(bodyStr)
	return out.join("\n")
}

/* ── buildRustResources ── */

/** Emit standard file header imports for a resource .rs file. */
function emitRustResourceFileHeader(rMethods: MethodInfo[]): string[] {
	const hasSSE = rMethods.some((m) => m.isSSE)
	const syncMethods = rMethods.filter((m) => !m.isSSE && !m.isWS)
	const hasSyncMethods = syncMethods.length > 0
	const lines: string[] = []
	lines.push(`/* Code generated by honey. DO NOT EDIT. */`)
	lines.push(``)
	lines.push(`#![allow(unused_imports, unused_variables, dead_code)]`)
	lines.push(`use std::sync::Arc;`)
	lines.push(`use futures_util::{self, Stream};`)
	lines.push(`use reqwest;`)
	lines.push(`use serde::{Serialize, Deserialize};`)
	lines.push(`use tokio_tungstenite;`)
	lines.push(`use urlencoding;`)
	lines.push(`use crate::client::ClientInner;`)
	if (hasSyncMethods) lines.push(`use crate::client::SyncClientInner;`)
	lines.push(`use crate::errors::Error;`)
	lines.push(`use crate::result::SdkResult;`)
	lines.push(`use crate::runtime::*;`)
	if (hasSyncMethods) lines.push(`use crate::runtime_sync::*;`)
	lines.push(`use crate::types::*;`)
	if (hasSSE) {
		lines.push(`use crate::sse::{SseEvent, parse_sse_stream};`)
	} else {
		lines.push(`use crate::sse::SseEvent;`)
	}
	lines.push(`use crate::ws::TypedWebSocket;`)
	lines.push(``)
	return lines
}

function buildRustResources(
	spec: OpenApiSpec,
	options: RustSDKOptions,
	ir: ReturnType<typeof toIR>,
): Map<string, string> {
	const throwOnError = options.throwOnError ?? true
	const allMethods = collectMethodsFromIR(ir.tree, spec)

	const files = new Map<string, string>()

	/* ---- src/resources/mod.rs: one `pub mod` per root namespace ---- */
	const modLines: string[] = [`/* Code generated by honey. DO NOT EDIT. */`, ``]
	for (const [seg] of namespacesOf(ir.tree)) {
		modLines.push(`pub mod ${rustSnake(safeResourceName(seg))};`)
	}
	for (const [seg] of namespacesOf(ir.tree)) {
		const safeName = safeResourceName(seg)
		modLines.push(`pub use ${rustSnake(safeName)}::${rustPascal(safeName)}Resource;`)
		const hasSyncDescendants = allMethods.some((m) => !m.isSSE && !m.isWS && m.namePath[0] === seg)
		if (hasSyncDescendants) {
			modLines.push(`pub use ${rustSnake(safeName)}::${rustPascal(safeName)}ResourceSync;`)
		}
	}
	modLines.push(``)
	files.set("src/resources/mod.rs", modLines.join("\n"))

	/* ---- recursive resource file emitter ---- */
	function emitNsFile(ns: IRNamespace, path: string[]): void {
		const safePath = path.map((s) => safeResourceName(s))
		const structName = `${safePath.map(rustPascal).join("")}Resource`
		const syncStructName = `${structName}Sync`

		/* collect methods directly on this ns (not descendants) */
		const directMethods = methodsOf(ns).map(([, op]) => {
			const m = allMethods.find((x) => x.opId === op.id)
			if (!m) throw new Error(`missing MethodInfo for ${op.id}`)
			return m
		})

		const childSegs = namespacesOf(ns).map(([seg]) => seg)
		const hasChildren = childSegs.length > 0

		const fileLines: string[] = [...emitRustResourceFileHeader(directMethods)]

		/* helper: full Pascal struct name for a child at a given path */
		const childStructName = (childSeg: string): string =>
			`${[...path, childSeg].map((s) => rustPascal(safeResourceName(s))).join("")}Resource`

		if (hasChildren) {
			/* sub-modules for child namespaces */
			for (const childSeg of childSegs) {
				fileLines.push(`pub mod ${rustSnake(safeResourceName(childSeg))};`)
			}
			/* re-export child resource types for convenience */
			for (const childSeg of childSegs) {
				const childSafe = safeResourceName(childSeg)
				fileLines.push(`pub use ${rustSnake(childSafe)}::${childStructName(childSeg)};`)
			}
			fileLines.push(``)
		}

		/* async resource struct — includes child namespace accessor fields */
		fileLines.push(`pub struct ${structName} {`)
		fileLines.push(`\tpub(crate) client: std::sync::Arc<crate::client::ClientInner>,`)
		for (const childSeg of childSegs) {
			const childSafe = safeResourceName(childSeg)
			fileLines.push(`\tpub ${rustSnake(childSafe)}: ${childStructName(childSeg)},`)
		}
		fileLines.push(`}`)
		fileLines.push(``)

		fileLines.push(`impl ${structName} {`)
		/* accessor methods for child namespaces */
		for (const childSeg of childSegs) {
			const childSafe = safeResourceName(childSeg)
			fileLines.push(`\tpub fn ${rustSnake(childSafe)}(&self) -> &${childStructName(childSeg)} {`)
			fileLines.push(`\t\t&self.${rustSnake(childSafe)}`)
			fileLines.push(`\t}`)
			fileLines.push(``)
		}
		/* direct methods */
		for (const m of directMethods.sort((a, b) => a.methodAction.localeCompare(b.methodAction))) {
			fileLines.push(...emitMethod(m, "self.client", throwOnError).map((l) => `\t${l}`))
		}
		fileLines.push(`}`)
		fileLines.push(``)

		/* constructor free-fn used by Client::new / parent resource constructors */
		const constructorFn = `new_${safePath.map(rustSnake).join("_")}_resource`
		fileLines.push(
			`pub(crate) fn ${constructorFn}(client: &std::sync::Arc<crate::client::ClientInner>) -> ${structName} {`,
		)
		fileLines.push(`\t${structName} {`)
		fileLines.push(`\t\tclient: std::sync::Arc::clone(client),`)
		for (const childSeg of childSegs) {
			const childSafe = safeResourceName(childSeg)
			const childConstructor = `${rustSnake(childSafe)}::new_${[...safePath.map(rustSnake), rustSnake(childSafe)].join("_")}_resource`
			fileLines.push(`\t\t${rustSnake(childSafe)}: ${childConstructor}(client),`)
		}
		fileLines.push(`\t}`)
		fileLines.push(`}`)
		fileLines.push(``)

		/* sync struct — only when direct non-SSE/non-WS methods exist */
		const directSyncMethods = directMethods.filter((m) => !m.isSSE && !m.isWS)
		if (directSyncMethods.length > 0) {
			fileLines.push(`pub struct ${syncStructName} {`)
			fileLines.push(`\tpub(crate) client: std::sync::Arc<crate::client::SyncClientInner>,`)
			fileLines.push(`}`)
			fileLines.push(``)
			fileLines.push(`impl ${syncStructName} {`)
			for (const m of directSyncMethods.sort((a, b) => a.methodAction.localeCompare(b.methodAction))) {
				fileLines.push(...emitSyncMethod(m, "self.client", throwOnError).map((l) => `\t${l}`))
			}
			fileLines.push(`}`)
			fileLines.push(``)
		}

		/* opts structs */
		const optsEmitted = new Set<string>()
		for (const m of directMethods.sort((a, b) => a.opId.localeCompare(b.opId))) {
			const optsName = optsStructName(m)
			if (optsEmitted.has(optsName)) continue
			optsEmitted.add(optsName)
			fileLines.push(...emitOptsStruct(m))
		}

		/* per-op error envelopes */
		const errEmitted = new Set<string>()
		for (const m of directMethods.sort((a, b) => a.opId.localeCompare(b.opId))) {
			if (errEmitted.has(m.opId)) continue
			errEmitted.add(m.opId)
			fileLines.push(...emitOperationErrorTypes(m.opId, m.op))
		}

		/* determine file path: namespace with children → dir/mod.rs, leaf → dir.rs */
		const dirPath = safePath.map(rustSnake).join("/")
		const filePath = hasChildren ? `src/resources/${dirPath}/mod.rs` : `src/resources/${dirPath}.rs`
		files.set(filePath, fileLines.join("\n"))

		/* recurse into children */
		for (const [childSeg, childNs] of namespacesOf(ns)) {
			emitNsFile(childNs, [...path, childSeg])
		}
	}

	for (const [seg, ns] of namespacesOf(ir.tree)) {
		emitNsFile(ns, [seg])
	}

	return files
}

export function generateRustSDK(spec: Record<string, unknown>, options: RustSDKOptions = {}): GeneratedRustSDK {
	const crateName = validateCrateName(options.crateName ?? "honey-sdk")

	/* toIR validates operationId collisions — throws before any codegen runs */
	const ir = toIR(spec as Parameters<typeof toIR>[0])

	const { serviceMap } = collectSDKMethods(spec as Parameters<typeof collectSDKMethods>[0])

	/* detect whether any operation uses x-realtime */
	const hasRealtime = collectMethodsFromIR(ir.tree, spec as unknown as OpenApiSpec).some((m) => m.isRealtime)

	const files: Record<string, string> = {}

	/* copy static runtime files; realtime.rs is conditional; runtime_sync + invalidation_sync always */
	for (const [name, content] of loadRustRuntimeTemplates()) {
		if (name === "realtime.rs") {
			if (hasRealtime) files[`src/${name}`] = content
		} else {
			files[`src/${name}`] = content
		}
	}

	/* types.rs uses unresolved spec — resolveRefs strips components.schemas */
	files["src/types.rs"] = buildRustTypes(spec as unknown as OpenApiSpec)
	files["src/client.rs"] = buildRustClient(spec as unknown as OpenApiSpec, options, ir)
	files["src/lib.rs"] = buildLibRs(hasRealtime)
	files["Cargo.toml"] = buildCargoToml(crateName, {
		version: options.version ?? "0.1.0",
		description: options.description,
		homepage: options.homepage,
		repository: options.repository,
		license: options.license,
	})

	for (const [relPath, content] of buildRustResources(spec as unknown as OpenApiSpec, options, ir)) {
		files[relPath] = content
	}

	if (!files["src/resources/mod.rs"]) {
		files["src/resources/mod.rs"] = `/* Code generated by honey. DO NOT EDIT. */\n`
	}

	return { files, serviceMap }
}
