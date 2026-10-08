/* Rust SDK emitter — generates a complete Rust crate from an OpenAPI 3.1 spec.
 *
 * Input is the SDK request model (codegen-sdk-model.ts). Every crate-level type name comes from one
 * NameScope seeded with the prelude and the runtime's own types; fields, params and methods are
 * claimed per scope; spec strings reach source only through rustString / rustDoc.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { OpenApiSpecInput } from "./codegen.ts"
import { collectSDKMethods, isStandardErrEnvelope } from "./codegen.ts"
import { detectAuthScheme } from "./codegen-go.ts"
import { methodsOf, namespacesOf } from "./codegen-ir.ts"
import type { IRNamespace, IRSchema } from "./codegen-ir.ts"
import {
	NameScope,
	RUST_PRELUDE_TYPES,
	cmpCodeUnit,
	rustDoc,
	rustPlainSnake,
	rustString,
	rustTypeIdent,
	rustValueIdent,
} from "./codegen-lang.ts"
import { buildSdkModel, valueCycleSchemas } from "./codegen-sdk-model.ts"
import type { SdkModel, SdkOp } from "./codegen-sdk-model.ts"
import { irRenderTopLevelRust, irRenderUseRust } from "./rust-type-emitter.ts"
import type { RustTypeNames } from "./rust-type-emitter.ts"

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

/* Names the runtime modules and generated client declare or glob-import. */
const RUST_RUNTIME_TYPES = [
	"ApiError",
	"AuthState",
	"BadGatewayError",
	"BadRequestError",
	"Client",
	"ClientConfig",
	"ClientInner",
	"ConflictError",
	"ConnectionState",
	"ErrField",
	"Error",
	"ForbiddenError",
	"GatewayTimeoutError",
	"InternalServerError",
	"InvalidationConfig",
	"LogEntry",
	"LongpollConn",
	"LongpollState",
	"LongpollTransport",
	"NotFoundError",
	"OnAuthExpiredHook",
	"OnLogHook",
	"OnRequestHook",
	"OnResponseHook",
	"QueryValue",
	"RateLimitError",
	"RealtimeError",
	"RequestBody",
	"RequestContext",
	"RequestMeta",
	"RequestResult",
	"ResponseContext",
	"ResponseMeta",
	"ResumableConnection",
	"ResumableConnectionOpts",
	"SdkResult",
	"ServiceEntry",
	"ServiceUnavailableError",
	"SseConn",
	"SseEvent",
	"SseParser",
	"SseState",
	"SseTransport",
	"StaleEntry",
	"StaleTracker",
	"StaleTrackerSync",
	"StatusError",
	"SyncAuthState",
	"SyncClient",
	"SyncClientConfig",
	"SyncClientInner",
	"SyncOnRequestHook",
	"SyncOnResponseHook",
	"SyncRequestBody",
	"SyncRequestContext",
	"SyncRequestResult",
	"SyncResponseContext",
	"Transport",
	"TransportConn",
	"TransportKind",
	"TransportOpts",
	"TypedWebSocket",
	"UnauthorizedError",
	"UnprocessableEntityError",
	"WsConn",
	"WsTransport",
]

type RustNames = {
	scope: NameScope
	types: RustTypeNames
	decls: Map<string, string>
}

function buildRustNames(model: SdkModel): RustNames {
	const scope = new NameScope([...RUST_PRELUDE_TYPES, ...RUST_RUNTIME_TYPES])
	const schemaNames = new Map<string, string>()
	for (const name of model.schemaNames) {
		const base = rustTypeIdent(name)
		schemaNames.set(name, scope.has(base) ? scope.claim(`${base}Model`) : scope.claim(base))
	}
	const hoistKeys = new Map<string, string>()
	return {
		decls: new Map(),
		scope,
		types: {
			cyclic: valueCycleSchemas(model.ir.schemas),
			hoist: (key, base) => {
				const hit = hoistKeys.get(key)
				if (hit) return hit
				const name = scope.claim(rustTypeIdent(base))
				hoistKeys.set(key, name)
				return name
			},
			ref: (name) => schemaNames.get(name) ?? rustTypeIdent(name),
			resolve: model.resolve,
		},
	}
}

/* ── per-op plan ── */

type RustOptField = { ident: string; type: string; wire: string; where: "query" | "header"; required: boolean }

type ErrEnvelopeInfo = { keyEnumName: string; keys: string[]; status: number; structName: string; variantName: string }

type RustOpPlan = {
	op: SdkOp
	fnName: string
	optsName: string
	optFields: RustOptField[]
	pathParams: Array<{ local: string; wire: string }>
	bodyParam?: { local: string; asyncType: string; syncType: string; generic?: { async: string; sync: string } }
	/** Rust type of the decoded success payload, "" for none */
	resultType: string
	errorEnum?: string
	envelopes: ErrEnvelopeInfo[]
	/** invalidation map keys */
	resource: string
	action: string
}

const OPTS_RESERVED = [
	"last_event_id",
	"reconnect_token",
	"protocols",
	"idempotency_key",
	"headers",
	"timeout",
	"cancel_token",
	"sync_cancel_token",
	"max_reconnect_attempts",
	"reconnect_delay_ms",
]

/** Locals every emitted method body uses. */
const METHOD_LOCALS = [
	"self",
	"opts",
	"query",
	"url_path",
	"result",
	"out",
	"req",
	"resp",
	"stream",
	"cfg",
	"client",
	"auth",
	"body_value",
	"call_headers",
	"path_params",
	"concrete_path",
	"selector",
	"request_meta",
	"stale",
	"targets",
	"headers",
]

function resolveRaw(
	schema: Record<string, unknown> | undefined,
	spec: Record<string, unknown>,
): Record<string, unknown> | undefined {
	let cur = schema
	for (let i = 0; i < 16 && cur && typeof cur.$ref === "string"; i++) {
		const name = (cur.$ref as string).split("/").pop() ?? ""
		const schemas = ((spec.components as Record<string, unknown> | undefined)?.schemas ?? {}) as Record<
			string,
			Record<string, unknown>
		>
		cur = Object.hasOwn(schemas, name) ? schemas[name] : undefined
	}
	return cur
}

/** Per-status error envelopes (standard shapes only), with `$ref` schemas resolved first. */
function errorEnvelopes(
	op: SdkOp,
	opPascal: string,
	spec: Record<string, unknown>,
	names: RustNames,
): ErrEnvelopeInfo[] {
	const responses = op.raw.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return []
	const out: ErrEnvelopeInfo[] = []
	for (const [status, response] of Object.entries(responses).sort(([a], [b]) => cmpCodeUnit(a, b))) {
		const code = Number.parseInt(status, 10)
		if (!/^[0-9]{3}$/.test(status) || code < 400) continue
		const content = response.content as Record<string, Record<string, unknown>> | undefined
		const schema = resolveRaw(content?.["application/json"]?.schema as Record<string, unknown> | undefined, spec)
		if (!schema) continue
		const envelope = isStandardErrEnvelope(schema)
		if (!envelope) continue
		out.push({
			keyEnumName: names.scope.claim(`${opPascal}Err${code}Key`),
			keys: envelope.keys,
			status: code,
			structName: names.scope.claim(`${opPascal}Err${code}`),
			variantName: `Status${code}`,
		})
	}
	return out
}

function emitErrorTypes(plan: RustOpPlan): string[] {
	if (plan.envelopes.length === 0 || !plan.errorEnum) return []
	const l: string[] = []
	for (const env of plan.envelopes) {
		const variants = new NameScope()
		l.push(`#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]`)
		l.push(`pub enum ${env.keyEnumName} {`)
		for (const k of env.keys) {
			const v = variants.claim(k === "" ? "Empty" : rustTypeIdent(k))
			l.push(`\t#[serde(rename = ${rustString(k)})]`)
			l.push(`\t${v},`)
		}
		l.push(`}`)
		l.push(``)
		l.push(`#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]`)
		l.push(`pub struct ${env.structName} {`)
		l.push(`\tpub error_key: ${env.keyEnumName},`)
		l.push(`\tpub message: String,`)
		l.push(`\tpub fields: std::collections::HashMap<String, Vec<crate::types::ErrField>>,`)
		l.push(`}`)
		l.push(``)
	}
	l.push(`#[derive(Debug)]`)
	l.push(`pub enum ${plan.errorEnum} {`)
	for (const env of plan.envelopes) l.push(`\t${env.variantName}(${env.structName}),`)
	l.push(`\tOther(Error),`)
	l.push(`}`)
	l.push(``)
	return l
}

function planOp(
	op: SdkOp,
	fnName: string,
	pathSegs: string[],
	names: RustNames,
	spec: Record<string, unknown>,
	throwOnError: boolean,
	model: SdkModel,
): RustOpPlan {
	const opPascal = pathSegs.map(rustTypeIdent).join("")
	const optsName = names.scope.claim(`${opPascal}Opts`)
	const locals = new NameScope(METHOD_LOCALS)
	const plan: RustOpPlan = {
		action: op.segments.length === 1 ? "_call" : op.segments.slice(1).join("."),
		envelopes: [],
		fnName,
		op,
		optFields: [],
		optsName,
		pathParams: [],
		resource: op.segments[0] ?? op.id,
		resultType: "",
	}

	const hasBody = op.body !== undefined && op.stream !== "ws" && op.stream !== "realtime"
	const bodyLocal = hasBody ? locals.claim("body") : ""
	for (const p of op.pathParams) plan.pathParams.push({ local: locals.claim(rustPlainSnake(p.name)), wire: p.name })

	if (op.stream !== "realtime") {
		const fieldScope = new NameScope(OPTS_RESERVED)
		const params: Array<[{ name: string; schema: IRSchema; required?: boolean }, "query" | "header"]> = [
			...op.query.map((p): [typeof p, "query"] => [p, "query"]),
			...op.headers.map((p): [typeof p, "header"] => [p, "header"]),
		]
		for (const [p, where] of params) {
			if (op.stream === "sse" && where === "query" && /^last[-_]?event[-_]?id$/i.test(p.name)) continue
			const ident = fieldScope.claim(rustPlainSnake(p.name))
			const t = irRenderUseRust(p.schema, {
				decls: names.decls,
				fieldName: p.name,
				names: names.types,
				parentName: optsName,
			})
			plan.optFields.push({
				ident,
				required: p.required === true,
				type: p.required === true || t.startsWith("Option<") ? t : `Option<${t}>`,
				where,
				wire: p.name,
			})
		}
	}

	if (hasBody && op.body) {
		const b = op.body
		switch (b.kind) {
			case "json": {
				let t: string
				if (b.schema.kind === "ref") t = names.types.ref(b.schema.name)
				else
					t = irRenderUseRust(b.schema, {
						decls: names.decls,
						fieldName: "Body",
						names: names.types,
						parentName: opPascal,
					})
				plan.bodyParam = { asyncType: `&${t}`, local: bodyLocal, syncType: `&${t}` }
				break
			}
			case "form":
				plan.bodyParam = {
					asyncType: "&std::collections::HashMap<String, String>",
					local: bodyLocal,
					syncType: "&std::collections::HashMap<String, String>",
				}
				break
			case "multipart":
				/* multipart Form is consumed (not Clone), passed by value */
				plan.bodyParam = {
					asyncType: "reqwest::multipart::Form",
					local: bodyLocal,
					syncType: "reqwest::blocking::multipart::Form",
				}
				break
			case "binary":
				/* octet-stream body: generic over any byte stream / reader; single-shot, not retried on 401 */
				plan.bodyParam = {
					asyncType: "S",
					generic: {
						async: `S: futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + Sync + 'static`,
						sync: `R: std::io::Read + Send + 'static`,
					},
					local: bodyLocal,
					syncType: "R",
				}
				break
			case "text":
				plan.bodyParam = { asyncType: "&str", local: bodyLocal, syncType: "&str" }
				break
		}
	}

	if (op.stream === null) {
		const s = op.success
		if (s.kind === "json") {
			if (!s.schema) plan.resultType = "serde_json::Value"
			else if (s.schema.kind === "ref") plan.resultType = names.types.ref(s.schema.name)
			else {
				const t = irRenderUseRust(s.schema, {
					decls: names.decls,
					fieldName: "Response",
					names: names.types,
					parentName: opPascal,
				})
				plan.resultType = t.startsWith("Box<") ? t.slice(4, -1) : t
			}
		} else if (s.kind === "text") plan.resultType = "String"
		else if (s.kind === "binary") plan.resultType = "Vec<u8>"
		/* the typed error enums exist in both modes; only safe-mode methods return them */
		plan.envelopes = errorEnvelopes(op, opPascal, spec, names)
		if (plan.envelopes.length > 0) plan.errorEnum = names.scope.claim(`${opPascal}Error`)
	}
	void model
	return plan
}

function emitOptsStruct(plan: RustOpPlan): string[] {
	const l: string[] = []
	const { op, optsName } = plan
	const fields: string[] = []
	if (op.stream === "realtime") {
		fields.push(`\tpub reconnect_token: Option<String>,`)
		fields.push(`\tpub last_event_id: Option<String>,`)
		fields.push(`\tpub protocols: Option<Vec<String>>,`)
		fields.push(`\tpub max_reconnect_attempts: Option<u32>,`)
		fields.push(`\tpub reconnect_delay_ms: Option<u64>,`)
		fields.push(`\t#[serde(skip)]`)
		fields.push(`\tpub headers: Option<std::collections::HashMap<String, String>>,`)
	} else {
		for (const f of plan.optFields) {
			const bare = f.ident.startsWith("r#") ? f.ident.slice(2) : f.ident
			const attrs: string[] = []
			if (bare !== f.wire) attrs.push(`rename = ${rustString(f.wire)}`)
			if (!f.required) attrs.push(`skip_serializing_if = "Option::is_none"`)
			if (attrs.length > 0) fields.push(`\t#[serde(${attrs.join(", ")})]`)
			fields.push(`\tpub ${f.ident}: ${f.type},`)
		}
		if (op.stream === "sse") fields.push(`\tpub last_event_id: Option<String>,`)
		if (op.stream === "ws") {
			fields.push(`\tpub reconnect_token: Option<String>,`)
			fields.push(`\tpub protocols: Option<Vec<String>>,`)
		}
		if (op.idempotent && op.stream === null) {
			fields.push(`\t#[serde(skip_serializing_if = "Option::is_none")]`)
			fields.push(`\tpub idempotency_key: Option<String>,`)
		}
		/* per-call headers for all non-WS methods (SSE included) */
		if (op.stream !== "ws") {
			fields.push(`\t#[serde(skip)]`)
			fields.push(`\tpub headers: Option<std::collections::HashMap<String, String>>,`)
		}
		if (op.stream === null) {
			fields.push(`\t#[serde(skip)]`)
			fields.push(`\tpub timeout: Option<std::time::Duration>,`)
			/* async consumes `cancel_token`, sync consumes `sync_cancel_token`; both runtime-only */
			fields.push(`\t#[serde(skip)]`)
			fields.push(`\tpub cancel_token: Option<tokio_util::sync::CancellationToken>,`)
			fields.push(`\t#[serde(skip)]`)
			fields.push(`\tpub sync_cancel_token: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,`)
		}
	}
	l.push(`#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]`)
	l.push(`pub struct ${optsName} {`)
	l.push(...fields)
	l.push(`}`)
	l.push(``)
	return l
}

function docLines(op: SdkOp): string[] {
	const l: string[] = []
	if (op.summary) l.push(...rustDoc(op.summary))
	if (op.description) {
		if (op.summary) l.push(`///`)
		l.push(...rustDoc(op.description))
	}
	if (op.deprecated) l.push(`#[deprecated(note = "the API marks this operation deprecated")]`)
	return l
}

function pathLines(plan: RustOpPlan): string[] {
	if (plan.pathParams.length === 0) return [`\tlet url_path = ${rustString(plan.op.path)}.to_string();`]
	const params = plan.pathParams.map((p) => `(${rustString(p.wire)}, ${p.local})`).join(", ")
	return [`\tlet url_path = crate::runtime::expand_path(${rustString(plan.op.path)}, &[${params}])?;`]
}

function queryLines(plan: RustOpPlan, opts = "opts"): string[] {
	const q = plan.optFields.filter((f) => f.where === "query")
	const l = [`\tlet ${q.length > 0 ? "mut " : ""}query: Vec<(String, String)> = Vec::new();`]
	for (const f of q)
		l.push(`\tcrate::runtime::push_serialized(${rustString(f.wire)}, &${opts}.${f.ident}, &mut query);`)
	return l
}

/** Lines that build `call_headers` from opts.headers, header params, then `extra` entries. */
function headerLines(plan: RustOpPlan, extra: string[] = []): string[] {
	const l = [
		`\tlet mut call_headers: std::collections::HashMap<String, String> = opts.headers.clone().unwrap_or_default();`,
	]
	for (const f of plan.optFields.filter((x) => x.where === "header")) {
		l.push(`\t{`)
		l.push(`\t\tlet mut values: Vec<(String, String)> = Vec::new();`)
		l.push(`\t\tcrate::runtime::push_serialized(${rustString(f.wire)}, &opts.${f.ident}, &mut values);`)
		l.push(`\t\tif !values.is_empty() {`)
		l.push(
			`\t\t\tcrate::runtime::set_header(&mut call_headers, ${rustString(f.wire)}, values.into_iter().map(|(_, v)| v).collect::<Vec<_>>().join(","));`,
		)
		l.push(`\t\t}`)
		l.push(`\t}`)
	}
	l.push(...extra)
	return l
}

function bodyExpr(plan: RustOpPlan, sync: boolean): { lines: string[]; expr: string } {
	const prefix = sync ? "crate::runtime_sync::SyncRequestBody" : "crate::runtime::RequestBody"
	const b = plan.op.body
	const local = plan.bodyParam?.local
	if (!b || !local) return { expr: `${prefix}::None`, lines: [] }
	switch (b.kind) {
		case "json":
			return { expr: `${prefix}::Json(&body_value)`, lines: [`\tlet body_value = serde_json::to_value(${local})?;`] }
		case "form":
			return { expr: `${prefix}::FormUrl(crate::runtime::form_pairs(${local}))`, lines: [] }
		case "multipart":
			return { expr: `${prefix}::Multipart(${local})`, lines: [] }
		case "binary":
			return {
				expr: sync
					? `${prefix}::Stream(reqwest::blocking::Body::new(${local}))`
					: `${prefix}::Stream(reqwest::Body::wrap_stream(${local}))`,
				lines: [],
			}
		case "text":
			return {
				expr: `${prefix}::Raw(${rustString(b.contentType)}, bytes::Bytes::from(${local}.to_string()))`,
				lines: [],
			}
	}
}

function decodeLines(plan: RustOpPlan): string[] {
	switch (plan.op.success.kind) {
		case "text":
			return [`\tlet out: String = String::from_utf8_lossy(&result.body).into_owned();`]
		case "binary":
			return [`\tlet out: Vec<u8> = result.body.clone();`]
		default:
			/* an empty JSON body decodes as `null` (Option / Value types accept it) */
			return [
				`\tlet out: ${plan.resultType} = serde_json::from_slice(if result.body.is_empty() { b"null" } else { &result.body })?;`,
			]
	}
}

type Access = { cfg: string; stale: string; http: string; auth: string }

function access(selfAccess: "self" | "self.client"): Access {
	return selfAccess === "self"
		? { auth: "self.inner.auth", cfg: "self.inner.cfg", http: "self.inner.http_client", stale: "self.inner.stale" }
		: { auth: "self.client.auth", cfg: "self.client.cfg", http: "self.client.http_client", stale: "self.client.stale" }
}

function returnType(plan: RustOpPlan, throwOnError: boolean): string {
	if (plan.resultType === "") return "Result<(), Error>"
	if (throwOnError) return `Result<${plan.resultType}, Error>`
	if (plan.errorEnum) return `Result<SdkResult<${plan.resultType}, ${plan.errorEnum}>, Error>`
	return `Result<SdkResult<${plan.resultType}>, Error>`
}

/** Shared tail: run the request (already bound to `result`), invalidate, decode. */
function resultLines(plan: RustOpPlan, throwOnError: boolean, sync: boolean, a: Access, call: string[]): string[] {
	const l: string[] = []
	const aw = sync ? "" : ".await"
	const method = plan.op.method

	/* invalidation pre-flight for every call: reads see and clear staleness too */
	const pp = plan.pathParams.map((p) => `(${rustString(p.wire)}.to_string(), ${p.local}.to_string())`).join(", ")
	l.push(
		`\tlet path_params: std::collections::HashMap<String, String> = ${plan.pathParams.length > 0 ? `std::collections::HashMap::from([${pp}])` : "std::collections::HashMap::new()"};`,
	)
	l.push(`\tlet selector = format!("{} {}", ${rustString(method)}, url_path);`)
	l.push(`\tlet request_meta: Option<crate::invalidation::RequestMeta> = match ${a.stale} {`)
	l.push(`\t\tSome(ref s) => s.build_request_meta(&selector, &url_path, ${rustString(method)})${aw},`)
	l.push(`\t\tNone => None,`)
	l.push(`\t};`)

	const safe = !throwOnError && plan.resultType !== ""
	if (safe) {
		l.push(`\tlet result = match ${call.join("\n\t\t")} {`)
		l.push(`\t\tOk(r) => r,`)
		l.push(`\t\tErr(Error::Api(api)) => {`)
		l.push(`\t\t\tlet status = api.status();`)
		if (plan.errorEnum) {
			l.push(`\t\t\tlet body = api.body().to_vec();`)
			l.push(`\t\t\tlet error = match status {`)
			for (const env of plan.envelopes) {
				l.push(`\t\t\t\t${env.status} => match serde_json::from_slice::<${env.structName}>(&body) {`)
				l.push(`\t\t\t\t\tOk(v) => ${plan.errorEnum}::${env.variantName}(v),`)
				l.push(`\t\t\t\t\tErr(_) => ${plan.errorEnum}::Other(Error::Api(api)),`)
				l.push(`\t\t\t\t},`)
			}
			l.push(`\t\t\t\t_ => ${plan.errorEnum}::Other(Error::Api(api)),`)
			l.push(`\t\t\t};`)
			l.push(`\t\t\tlet mut response = crate::runtime::ResponseMeta::empty(status);`)
			l.push(`\t\t\tresponse.body = body;`)
			l.push(`\t\t\treturn Ok(SdkResult { data: None, error: Some(error), status, response });`)
		} else {
			l.push(`\t\t\tlet mut response = crate::runtime::ResponseMeta::empty(status);`)
			l.push(`\t\t\tresponse.body = api.body().to_vec();`)
			l.push(`\t\t\treturn Ok(SdkResult { data: None, error: Some(Error::Api(api)), status, response });`)
		}
		l.push(`\t\t}`)
		l.push(`\t\tErr(e) => return Err(e),`)
		l.push(`\t};`)
	} else {
		l.push(`\tlet result = ${call.join("\n\t\t")}?;`)
	}

	/* invalidation post-flight: mark declared targets stale (templated ones expanded with this
	 * call's params), then clear this key if the call read through a stale window */
	l.push(`\tif let Some(ref stale) = ${a.stale} {`)
	if (plan.op.invalidates.length > 0) {
		l.push(
			`\t\tlet targets: Vec<String> = vec![${plan.op.invalidates.map((t) => `${rustString(t)}.to_string()`).join(", ")}];`,
		)
		l.push(`\t\tstale.mark_stale(&targets, &path_params, &selector)${aw};`)
	}
	l.push(`\t\tif let Some(ref meta) = request_meta {`)
	l.push(`\t\t\tif meta.is_stale {`)
	l.push(`\t\t\t\tstale.clear_stale(&selector, &url_path, ${rustString(method)}, meta.seq_snapshot)${aw};`)
	l.push(`\t\t\t}`)
	l.push(`\t\t}`)
	l.push(`\t}`)

	if (plan.resultType === "") {
		l.push(`\tlet _ = result;`)
		l.push(`\tOk(())`)
		return l
	}
	l.push(...decodeLines(plan))
	if (throwOnError) {
		l.push(`\tOk(out)`)
	} else {
		l.push(
			`\tOk(SdkResult { data: Some(out), error: None, status: result.status, response: crate::runtime::ResponseMeta { status: result.status, headers: result.headers.clone(), url: result.url.clone(), body: result.body.clone() } })`,
		)
	}
	return l
}

function signature(plan: RustOpPlan, sync: boolean): { generics: string; params: string } {
	const params: string[] = [`&self`]
	for (const p of plan.pathParams) params.push(`${p.local}: &str`)
	let generics = ""
	if (plan.bodyParam) {
		params.push(`${plan.bodyParam.local}: ${sync ? plan.bodyParam.syncType : plan.bodyParam.asyncType}`)
		if (plan.bodyParam.generic) generics = `<${sync ? plan.bodyParam.generic.sync : plan.bodyParam.generic.async}>`
	}
	params.push(`opts: &${plan.optsName}`)
	return { generics, params: params.join(", ") }
}

function emitMethod(plan: RustOpPlan, selfAccess: "self" | "self.client", throwOnError: boolean): string[] {
	const l: string[] = []
	const { op } = plan
	const a = access(selfAccess)
	l.push(...docLines(op))
	const sig = signature(plan, false)

	if (op.stream === "realtime") {
		l.push(
			`pub async fn ${plan.fnName}(${sig.params}) -> Result<crate::realtime::ResumableConnection<serde_json::Value, serde_json::Value>, crate::realtime::RealtimeError> {`,
		)
		l.push(`\tlet connect_err = |e: Error| crate::realtime::RealtimeError::Connect(e);`)
		l.push(...pathLines(plan).map((x) => x.replace(/\?;$/, ".map_err(connect_err)?;")))
		l.push(`\tlet url = crate::runtime::build_url(&${a.cfg}.base_url, &url_path, &[]).map_err(connect_err)?;`)
		l.push(`\tlet headers = crate::runtime::auth_headers(&${a.cfg}, &${a.auth}, opts.headers.as_ref()).await;`)
		l.push(`\tlet rt_opts = crate::realtime::ResumableConnectionOpts {`)
		l.push(`\t\treconnect_token: opts.reconnect_token.clone(),`)
		l.push(`\t\tprotocols: opts.protocols.clone(),`)
		l.push(`\t\tmax_reconnect_attempts: opts.max_reconnect_attempts,`)
		l.push(`\t\treconnect_delay_ms: opts.reconnect_delay_ms,`)
		l.push(`\t\tlast_event_id: opts.last_event_id.clone(),`)
		l.push(`\t\theaders,`)
		l.push(`\t\thttp_client: Some(${a.http}.clone()),`)
		l.push(`\t};`)
		l.push(
			`\tcrate::realtime::ResumableConnection::<serde_json::Value, serde_json::Value>::connect_with_defaults(url.to_string(), rt_opts).await`,
		)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (op.stream === "sse") {
		l.push(`pub fn ${plan.fnName}${sig.generics}(${sig.params}) -> impl Stream<Item = Result<SseEvent, Error>> {`)
		/* clone everything the stream needs into owned locals: the stream outlives &self/&opts */
		if (plan.pathParams.length === 0) {
			l.push(`\tlet url_path: Result<String, Error> = Ok(${rustString(op.path)}.to_string());`)
		} else {
			const params = plan.pathParams.map((p) => `(${rustString(p.wire)}, ${p.local})`).join(", ")
			l.push(`\tlet url_path = crate::runtime::expand_path(${rustString(op.path)}, &[${params}]);`)
		}
		l.push(...queryLines(plan))
		l.push(
			...headerLines(plan, [
				`\tcrate::runtime::set_header(&mut call_headers, "Accept", "text/event-stream".to_string());`,
				`\tif let Some(ref lei) = opts.last_event_id {`,
				`\t\tcrate::runtime::set_header(&mut call_headers, "Last-Event-ID", lei.clone());`,
				`\t}`,
			]),
		)
		const body = op.body && plan.bodyParam?.local ? op.body : undefined
		if (body?.kind === "json") l.push(`\tlet body_value = serde_json::to_value(${plan.bodyParam?.local});`)
		l.push(`\tlet cfg = ${a.cfg}.clone();`)
		l.push(`\tlet client = ${a.http}.clone();`)
		l.push(`\tlet auth = std::sync::Arc::clone(&${a.auth});`)
		if (body?.kind === "form") l.push(`\tlet form = crate::runtime::form_pairs(${plan.bodyParam?.local});`)
		if (body?.kind === "text") l.push(`\tlet text = bytes::Bytes::from(${plan.bodyParam?.local}.to_string());`)
		if (body?.kind === "multipart" || body?.kind === "binary") l.push(`\tlet raw_body = ${plan.bodyParam?.local};`)
		l.push(`\tasync_stream::stream! {`)
		l.push(`\t\tuse futures_util::StreamExt;`)
		l.push(`\t\tlet url_path = match url_path {`)
		l.push(`\t\t\tOk(p) => p,`)
		l.push(`\t\t\tErr(e) => { yield Err(e); return; }`)
		l.push(`\t\t};`)
		let expr = "crate::runtime::RequestBody::None"
		if (body?.kind === "json") {
			l.push(`\t\tlet body_value = match body_value {`)
			l.push(`\t\t\tOk(v) => v,`)
			l.push(`\t\t\tErr(e) => { yield Err(Error::Json(e)); return; }`)
			l.push(`\t\t};`)
			expr = "crate::runtime::RequestBody::Json(&body_value)"
		} else if (body?.kind === "form") expr = "crate::runtime::RequestBody::FormUrl(form)"
		else if (body?.kind === "text") expr = `crate::runtime::RequestBody::Raw(${rustString(body.contentType)}, text)`
		else if (body?.kind === "multipart") expr = "crate::runtime::RequestBody::Multipart(raw_body)"
		else if (body?.kind === "binary") expr = "crate::runtime::RequestBody::Stream(reqwest::Body::wrap_stream(raw_body))"
		l.push(
			`\t\tlet opened = crate::runtime::open_stream(&client, &cfg, &auth, reqwest::Method::${op.method}, &url_path, &query, ${expr}, Some(&call_headers)).await;`,
		)
		l.push(`\t\tmatch opened {`)
		l.push(`\t\t\tErr(e) => { yield Err(e); }`)
		l.push(`\t\t\tOk(r) => {`)
		l.push(`\t\t\t\tlet mut s = std::pin::pin!(crate::sse::parse_sse_stream(r));`)
		l.push(`\t\t\t\twhile let Some(item) = s.next().await { yield item; }`)
		l.push(`\t\t\t}`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`}`)
		l.push(``)
		return l
	}

	if (op.stream === "ws") {
		l.push(`pub async fn ${plan.fnName}(${sig.params}) -> Result<TypedWebSocket, Error> {`)
		l.push(...pathLines(plan))
		l.push(...queryLines(plan))
		l.push(`\tif let Some(ref rt) = opts.reconnect_token {`)
		l.push(`\t\tquery.push(("reconnect_token".to_string(), rt.clone()));`)
		l.push(`\t}`)
		l.push(`\tlet url = crate::runtime::build_url(&${a.cfg}.base_url, &url_path, &query)?;`)
		l.push(`\tlet ws_url = crate::runtime::to_ws_url(url.as_str());`)
		l.push(`\tuse tokio_tungstenite::tungstenite::client::IntoClientRequest;`)
		l.push(`\tlet mut req = ws_url.as_str().into_client_request().map_err(|e| Error::Other(e.to_string()))?;`)
		l.push(`\tfor (k, v) in crate::runtime::auth_headers(&${a.cfg}, &${a.auth}, None).await {`)
		l.push(`\t\tif let (Ok(name), Ok(val)) = (`)
		l.push(`\t\t\ttokio_tungstenite::tungstenite::http::HeaderName::from_bytes(k.as_bytes()),`)
		l.push(`\t\t\tv.parse::<tokio_tungstenite::tungstenite::http::HeaderValue>(),`)
		l.push(`\t\t) {`)
		l.push(`\t\t\treq.headers_mut().insert(name, val);`)
		l.push(`\t\t}`)
		l.push(`\t}`)
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
		l.push(`\tlet (stream, _) = tokio_tungstenite::connect_async(req).await.map_err(|e| Error::Other(e.to_string()))?;`)
		l.push(`\tOk(TypedWebSocket::new(stream))`)
		l.push(`}`)
		l.push(``)
		return l
	}

	l.push(`pub async fn ${plan.fnName}${sig.generics}(${sig.params}) -> ${returnType(plan, throwOnError)} {`)
	l.push(...pathLines(plan))
	l.push(...queryLines(plan))
	l.push(...headerLines(plan, idempotencyLines(plan)))
	const body = bodyExpr(plan, false)
	l.push(...body.lines)
	const call = [
		`crate::runtime::do_request(`,
		`\t&${a.http},`,
		`\t&${a.cfg},`,
		`\t&${a.auth},`,
		`\treqwest::Method::${op.method},`,
		`\t&url_path,`,
		`\t&query,`,
		`\t${body.expr},`,
		`\tSome(&call_headers),`,
		`\topts.timeout,`,
		`\topts.cancel_token.clone(),`,
		`\t${rustString(`${op.method} ${op.path}`)},`,
		`\trequest_meta.as_ref(),`,
		`).await`,
	]
	l.push(...resultLines(plan, throwOnError, false, a, call))
	l.push(`}`)
	l.push(``)
	return l
}

function idempotencyLines(plan: RustOpPlan): string[] {
	if (!plan.op.idempotent || plan.op.stream !== null) return []
	/* explicit header (any casing) > opts.idempotency_key > fresh UUID */
	return [
		`\tif !call_headers.keys().any(|k| k.eq_ignore_ascii_case("Idempotency-Key")) {`,
		`\t\tlet key = opts.idempotency_key.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());`,
		`\t\tcall_headers.insert("Idempotency-Key".to_string(), key);`,
		`\t}`,
	]
}

/** emitSyncMethod is the blocking twin of emitMethod — no async, calls do_request_blocking. */
function emitSyncMethod(plan: RustOpPlan, selfAccess: "self" | "self.client", throwOnError: boolean): string[] {
	if (!isSyncCapable(plan.op)) return []
	const l: string[] = []
	const { op } = plan
	const a = access(selfAccess)
	l.push(...docLines(op))
	const sig = signature(plan, true)
	l.push(`pub fn ${plan.fnName}${sig.generics}(${sig.params}) -> ${returnType(plan, throwOnError)} {`)
	l.push(...pathLines(plan))
	l.push(...queryLines(plan))
	l.push(...headerLines(plan, idempotencyLines(plan)))
	const body = bodyExpr(plan, true)
	l.push(...body.lines)
	const call = [
		`crate::runtime_sync::do_request_blocking(`,
		`\t&${a.http},`,
		`\t&${a.cfg},`,
		`\t&${a.auth},`,
		`\treqwest::Method::${op.method},`,
		`\t&url_path,`,
		`\t&query,`,
		`\t${body.expr},`,
		`\tSome(&call_headers),`,
		`\topts.timeout,`,
		`\topts.sync_cancel_token.clone(),`,
		`\t${rustString(`${op.method} ${op.path}`)},`,
		`\trequest_meta.as_ref(),`,
		`)`,
	]
	l.push(...resultLines(plan, throwOnError, true, a, call))
	l.push(`}`)
	l.push(``)
	return l
}

function isSyncCapable(op: SdkOp): boolean {
	return op.stream === null
}

/* ── resource tree ── */

type RustNode = {
	path: string[]
	modName: string
	structName: string
	syncStructName: string
	ns: IRNamespace
	children: Array<{ accessor: string; node: RustNode }>
	plans: RustOpPlan[]
}

function hasSync(node: RustNode): boolean {
	return node.plans.some((p) => isSyncCapable(p.op)) || node.children.some((c) => hasSync(c.node))
}

function buildTree(
	model: SdkModel,
	names: RustNames,
	spec: Record<string, unknown>,
	throwOnError: boolean,
): { root: RustNode; plans: RustOpPlan[] } {
	const plans: RustOpPlan[] = []
	function visit(ns: IRNamespace, path: string[], modName: string, reserved: string[]): RustNode {
		const isRoot = path.length === 0
		const pascal = path.map(rustTypeIdent).join("")
		const node: RustNode = {
			children: [],
			modName,
			ns,
			path,
			plans: [],
			structName: isRoot ? "Client" : names.scope.claim(`${pascal}Resource`),
			syncStructName: isRoot ? "SyncClient" : names.scope.claim(`${pascal}ResourceSync`),
		}
		const members = new NameScope(reserved)
		const modules = new NameScope()
		const childInfo: Array<{ accessor: string; seg: string; ns: IRNamespace; mod: string }> = []
		for (const [seg, childNs] of namespacesOf(ns)) {
			childInfo.push({
				accessor: members.claim(rustPlainSnake(seg)),
				mod: modules.claim(rustPlainSnake(seg)),
				ns: childNs,
				seg,
			})
		}
		for (const [seg, irOp] of methodsOf(ns)) {
			const op = model.opsById.get(irOp.id)
			if (!op) continue
			const ident = rustValueIdent(seg)
			const plain = ident.startsWith("r#") ? ident.slice(2) : ident
			const claimed = members.claim(plain)
			const plan = planOp(op, claimed === plain ? ident : claimed, [...path, seg], names, spec, throwOnError, model)
			node.plans.push(plan)
			plans.push(plan)
		}
		for (const c of childInfo) {
			node.children.push({ accessor: c.accessor, node: visit(c.ns, [...path, c.seg], c.mod, ["client", "new"]) })
		}
		return node
	}
	const root = visit(model.ir.tree, [], "", ["inner", "new", "is_stale"])
	return { plans, root }
}

/* ── files ── */

function buildRustTypes(model: SdkModel, names: RustNames, spec: Record<string, unknown>): string {
	const rawSchemas = ((spec.components as Record<string, unknown> | undefined)?.schemas ?? {}) as Record<
		string,
		Record<string, unknown>
	>
	const body: string[] = []
	/* always emit shared error-envelope field type used by per-op error structs */
	body.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
	body.push(`pub struct ErrField {`)
	body.push(`\tpub error_key: String,`)
	body.push(`\tpub message: String,`)
	body.push(`\tpub path: String,`)
	body.push(`}`)
	body.push(``)
	for (const name of model.schemaNames) {
		const raw = Object.hasOwn(rawSchemas, name) ? rawSchemas[name] : undefined
		if (typeof raw?.description === "string") body.push(...rustDoc(raw.description))
		body.push(irRenderTopLevelRust(names.types.ref(name), model.ir.schemas[name], names.decls, raw, names.types))
		body.push(``)
	}
	return body.join("\n")
}

function typesFile(schemaSource: string, names: RustNames): string {
	const l: string[] = []
	l.push(`/* Code generated by honey. DO NOT EDIT. */`)
	l.push(``)
	l.push(`#![allow(unused_imports, clippy::large_enum_variant)]`)
	l.push(`use serde::{Serialize, Deserialize};`)
	l.push(`use serde_repr::{Serialize_repr, Deserialize_repr};`)
	l.push(`use std::collections::HashMap;`)
	l.push(``)
	l.push(schemaSource)
	for (const name of [...names.decls.keys()].sort(cmpCodeUnit)) {
		const decl = names.decls.get(name)
		if (!decl) continue
		l.push(decl)
		l.push(``)
	}
	return l.join("\n")
}

function buildCargoToml(
	crateName: string,
	meta: { version: string; description?: string; homepage?: string; repository?: string; license?: string },
): string {
	/* TOML basic strings share JSON's escapes */
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
	if (hasRealtime) lines.push(`pub mod realtime;`)
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

function fileHeader(sync: boolean): string[] {
	const lines: string[] = []
	lines.push(`/* Code generated by honey. DO NOT EDIT. */`)
	lines.push(``)
	lines.push(`#![allow(unused_imports, unused_variables, unused_mut, dead_code, deprecated)]`)
	lines.push(`use std::sync::Arc;`)
	lines.push(`use futures_util::{self, Stream};`)
	lines.push(`use reqwest;`)
	lines.push(`use serde::{Serialize, Deserialize};`)
	lines.push(`use tokio_tungstenite;`)
	lines.push(`use crate::client::ClientInner;`)
	if (sync) lines.push(`use crate::client::SyncClientInner;`)
	lines.push(`use crate::errors::Error;`)
	lines.push(`use crate::result::SdkResult;`)
	lines.push(`use crate::types::*;`)
	lines.push(`use crate::sse::SseEvent;`)
	lines.push(`use crate::ws::TypedWebSocket;`)
	lines.push(``)
	return lines
}

function staleInit(tracker: string): string[] {
	return [
		`\t\tlet stale = match cfg.invalidation.clone() {`,
		`\t\t\tSome(mut inv) if inv.stale_time > 0 => {`,
		`\t\t\t\tif inv.stale_max_entries == 0 {`,
		`\t\t\t\t\tinv.stale_max_entries = cfg.stale_max_entries;`,
		`\t\t\t\t}`,
		`\t\t\t\tSome(${tracker}::new(Some(&inv)))`,
		`\t\t\t}`,
		`\t\t\t_ => None,`,
		`\t\t};`,
	]
}

function buildRustClient(
	root: RustNode,
	plans: RustOpPlan[],
	throwOnError: boolean,
	auth: { headerName: string; prefix: string },
	serviceMap: Record<string, Record<string, unknown>>,
	realtimeIds: Set<string>,
): string {
	const body: string[] = []

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
	for (const [resource, actions] of Object.entries(serviceMap).sort(([a], [b]) => cmpCodeUnit(a, b))) {
		body.push(`\t\t{`)
		body.push(`\t\t\tlet mut resource_map = std::collections::HashMap::new();`)
		for (const [action, entry] of Object.entries(actions as Record<string, Record<string, unknown>>).sort(([a], [b]) =>
			cmpCodeUnit(a, b),
		)) {
			const inv = (entry.invalidate as string[] | undefined) ?? []
			const params = (entry.params as string[] | undefined) ?? []
			const opId = action === "_call" ? resource : `${resource}.${action}`
			body.push(
				`\t\t\tresource_map.insert(${rustString(action)}, ServiceEntry { method: ${rustString(String(entry.method))}, path: ${rustString(String(entry.path))}, params: &[${params.map(rustString).join(", ")}], sse: ${entry.sse === true}, ws: ${entry.ws === true}, realtime: ${realtimeIds.has(opId)}, invalidate: &[${inv.map(rustString).join(", ")}] });`,
			)
		}
		body.push(`\t\t\tmap.insert(${rustString(resource)}, resource_map);`)
		body.push(`\t\t}`)
	}
	body.push(`\t\tmap`)
	body.push(`\t});`)
	body.push(``)

	body.push(`pub(crate) struct ClientInner {`)
	body.push(`\tpub(crate) cfg: crate::runtime::ClientConfig,`)
	body.push(`\tpub(crate) stale: Option<crate::invalidation::StaleTracker>,`)
	body.push(`\tpub(crate) http_client: reqwest::Client,`)
	body.push(`\tpub(crate) auth: std::sync::Arc<crate::runtime::AuthState>,`)
	body.push(`}`)
	body.push(``)

	body.push(`/// Client is the generated SDK client.`)
	body.push(`pub struct Client {`)
	body.push(`\tpub(crate) inner: std::sync::Arc<ClientInner>,`)
	for (const c of root.children) body.push(`\t${c.accessor}: ${c.node.structName},`)
	body.push(`}`)
	body.push(``)
	body.push(`impl Client {`)
	body.push(`\t/// new creates a new SDK client. base_url must be non-empty.`)
	body.push(`\tpub fn new(mut cfg: crate::runtime::ClientConfig) -> Self {`)
	body.push(`\t\tif cfg.base_url.is_empty() {`)
	body.push(`\t\t\tpanic!("honey sdk: ClientConfig.base_url must not be empty");`)
	body.push(`\t\t}`)
	body.push(`\t\t/* http_client: None → a default client that never redirects to another origin */`)
	body.push(`\t\tlet http_client = match cfg.http_client.take() {`)
	body.push(`\t\t\tSome(c) => c,`)
	body.push(`\t\t\tNone => crate::runtime::default_http_client(),`)
	body.push(`\t\t};`)
	body.push(`\t\tif cfg.auth_header_name.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_name = Some(${rustString(auth.headerName)}.to_string());`)
	body.push(`\t\t}`)
	body.push(`\t\tif cfg.auth_header_prefix.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_prefix = Some(${rustString(auth.prefix)}.to_string());`)
	body.push(`\t\t}`)
	body.push(...staleInit("crate::invalidation::StaleTracker"))
	body.push(`\t\tlet auth = std::sync::Arc::new(crate::runtime::AuthState::new(cfg.bearer_token.clone()));`)
	body.push(`\t\tlet inner = std::sync::Arc::new(ClientInner { cfg, stale, http_client, auth });`)
	body.push(`\t\tClient {`)
	for (const c of root.children) {
		body.push(`\t\t\t${c.accessor}: crate::resources::${c.node.modName}::new_resource(&inner),`)
	}
	body.push(`\t\t\tinner,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(``)
	for (const c of root.children) {
		body.push(`\t/// ${c.accessor} returns a reference to the ${c.node.structName}.`)
		body.push(`\tpub fn ${c.accessor}(&self) -> &${c.node.structName} {`)
		body.push(`\t\t&self.${c.accessor}`)
		body.push(`\t}`)
		body.push(``)
	}
	for (const plan of root.plans) body.push(...emitMethod(plan, "self", throwOnError).map((x) => `\t${x}`))
	body.push(`\t/// is_stale reports whether (method, path) is currently within an active stale window.`)
	body.push(`\tpub async fn is_stale(&self, method: &str, path: &str) -> bool {`)
	body.push(`\t\tmatch self.inner.stale {`)
	body.push(`\t\t\tSome(ref s) => s.is_stale(method, path).await,`)
	body.push(`\t\t\tNone => false,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(`}`)
	body.push(``)

	for (const plan of root.plans) body.push(...emitOptsStruct(plan), ...emitErrorTypes(plan))

	/* ── SyncClient ── */
	const syncChildren = root.children.filter((c) => hasSync(c.node))
	body.push(`pub(crate) struct SyncClientInner {`)
	body.push(`\tpub(crate) cfg: crate::runtime_sync::SyncClientConfig,`)
	body.push(`\tpub(crate) stale: Option<crate::invalidation_sync::StaleTrackerSync>,`)
	body.push(`\tpub(crate) http_client: reqwest::blocking::Client,`)
	body.push(`\tpub(crate) auth: std::sync::Arc<crate::runtime_sync::SyncAuthState>,`)
	body.push(`}`)
	body.push(``)
	body.push(`/// SyncClient is the generated blocking SDK client.`)
	body.push(`/// WARNING: Do not use from inside a tokio async task — reqwest blocking will deadlock.`)
	body.push(`pub struct SyncClient {`)
	body.push(`\tpub(crate) inner: std::sync::Arc<SyncClientInner>,`)
	for (const c of syncChildren) body.push(`\t${c.accessor}: ${c.node.syncStructName},`)
	body.push(`}`)
	body.push(``)
	body.push(`impl SyncClient {`)
	body.push(`\t/// new creates a new blocking SDK client. base_url must be non-empty.`)
	body.push(`\tpub fn new(mut cfg: crate::runtime_sync::SyncClientConfig) -> Self {`)
	body.push(`\t\tif cfg.base_url.is_empty() {`)
	body.push(`\t\t\tpanic!("honey sdk: SyncClientConfig.base_url must not be empty");`)
	body.push(`\t\t}`)
	body.push(`\t\tlet http_client = match cfg.http_client.take() {`)
	body.push(`\t\t\tSome(c) => c,`)
	body.push(`\t\t\tNone => crate::runtime_sync::default_http_client_blocking(),`)
	body.push(`\t\t};`)
	body.push(`\t\tif cfg.auth_header_name.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_name = Some(${rustString(auth.headerName)}.to_string());`)
	body.push(`\t\t}`)
	body.push(`\t\tif cfg.auth_header_prefix.is_none() {`)
	body.push(`\t\t\tcfg.auth_header_prefix = Some(${rustString(auth.prefix)}.to_string());`)
	body.push(`\t\t}`)
	body.push(...staleInit("crate::invalidation_sync::StaleTrackerSync"))
	body.push(`\t\tlet auth = std::sync::Arc::new(crate::runtime_sync::SyncAuthState::new(cfg.bearer_token.clone()));`)
	body.push(`\t\tlet inner = std::sync::Arc::new(SyncClientInner { cfg, stale, http_client, auth });`)
	body.push(`\t\tSyncClient {`)
	for (const c of syncChildren) {
		body.push(`\t\t\t${c.accessor}: crate::resources::${c.node.modName}::new_resource_sync(&inner),`)
	}
	body.push(`\t\t\tinner,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(``)
	for (const c of syncChildren) {
		body.push(`\t/// ${c.accessor} returns a reference to the ${c.node.syncStructName}.`)
		body.push(`\tpub fn ${c.accessor}(&self) -> &${c.node.syncStructName} {`)
		body.push(`\t\t&self.${c.accessor}`)
		body.push(`\t}`)
		body.push(``)
	}
	for (const plan of root.plans) body.push(...emitSyncMethod(plan, "self", throwOnError).map((x) => `\t${x}`))
	body.push(`\t/// is_stale reports whether (method, path) is currently within an active stale window.`)
	body.push(`\tpub fn is_stale(&self, method: &str, path: &str) -> bool {`)
	body.push(`\t\tmatch self.inner.stale {`)
	body.push(`\t\t\tSome(ref s) => s.is_stale(method, path),`)
	body.push(`\t\t\tNone => false,`)
	body.push(`\t\t}`)
	body.push(`\t}`)
	body.push(`}`)
	body.push(``)
	void plans

	const out: string[] = []
	out.push(`/* Code generated by honey. DO NOT EDIT. */`)
	out.push(``)
	out.push(`#![allow(unused_imports, unused_variables, unused_mut, dead_code, deprecated)]`)
	out.push(`use std::sync::Arc;`)
	out.push(`use once_cell;`)
	out.push(`use reqwest;`)
	out.push(`use tokio_tungstenite;`)
	out.push(`use futures_util::{self, Stream};`)
	out.push(`use crate::errors::Error;`)
	out.push(`use crate::resources::*;`)
	out.push(`use crate::result::SdkResult;`)
	out.push(`use crate::runtime::ClientConfig;`)
	out.push(`use crate::sse::SseEvent;`)
	out.push(`use crate::types::*;`)
	out.push(`use crate::ws::TypedWebSocket;`)
	out.push(``)
	out.push(body.join("\n"))
	return out.join("\n")
}

function buildRustResources(root: RustNode, throwOnError: boolean): Map<string, string> {
	const files = new Map<string, string>()

	const modLines: string[] = [`/* Code generated by honey. DO NOT EDIT. */`, ``]
	for (const c of root.children) modLines.push(`pub mod ${c.node.modName};`)
	for (const c of root.children) {
		modLines.push(`pub use ${c.node.modName}::${c.node.structName};`)
		if (hasSync(c.node)) modLines.push(`pub use ${c.node.modName}::${c.node.syncStructName};`)
	}
	modLines.push(``)
	files.set("src/resources/mod.rs", modLines.join("\n"))

	function emitNode(node: RustNode, dir: string[]): void {
		const sync = hasSync(node)
		const l: string[] = [...fileHeader(sync)]
		for (const c of node.children) l.push(`pub mod ${c.node.modName};`)
		for (const c of node.children) {
			l.push(`pub use ${c.node.modName}::${c.node.structName};`)
			if (hasSync(c.node)) l.push(`pub use ${c.node.modName}::${c.node.syncStructName};`)
		}
		if (node.children.length > 0) l.push(``)

		l.push(`pub struct ${node.structName} {`)
		l.push(`\tpub(crate) client: std::sync::Arc<crate::client::ClientInner>,`)
		for (const c of node.children) l.push(`\tpub ${c.accessor}: ${c.node.structName},`)
		l.push(`}`)
		l.push(``)
		l.push(`impl ${node.structName} {`)
		for (const c of node.children) {
			l.push(`\tpub fn ${c.accessor}(&self) -> &${c.node.structName} {`)
			l.push(`\t\t&self.${c.accessor}`)
			l.push(`\t}`)
			l.push(``)
		}
		for (const plan of node.plans) l.push(...emitMethod(plan, "self.client", throwOnError).map((x) => `\t${x}`))
		l.push(`}`)
		l.push(``)
		l.push(`pub(crate) fn new_resource(client: &std::sync::Arc<crate::client::ClientInner>) -> ${node.structName} {`)
		l.push(`\t${node.structName} {`)
		l.push(`\t\tclient: std::sync::Arc::clone(client),`)
		for (const c of node.children) l.push(`\t\t${c.accessor}: ${c.node.modName}::new_resource(client),`)
		l.push(`\t}`)
		l.push(`}`)
		l.push(``)

		if (sync) {
			const syncKids = node.children.filter((c) => hasSync(c.node))
			l.push(`pub struct ${node.syncStructName} {`)
			l.push(`\tpub(crate) client: std::sync::Arc<crate::client::SyncClientInner>,`)
			for (const c of syncKids) l.push(`\tpub ${c.accessor}: ${c.node.syncStructName},`)
			l.push(`}`)
			l.push(``)
			l.push(`impl ${node.syncStructName} {`)
			for (const c of syncKids) {
				l.push(`\tpub fn ${c.accessor}(&self) -> &${c.node.syncStructName} {`)
				l.push(`\t\t&self.${c.accessor}`)
				l.push(`\t}`)
				l.push(``)
			}
			for (const plan of node.plans) l.push(...emitSyncMethod(plan, "self.client", throwOnError).map((x) => `\t${x}`))
			l.push(`}`)
			l.push(``)
			l.push(
				`pub(crate) fn new_resource_sync(client: &std::sync::Arc<crate::client::SyncClientInner>) -> ${node.syncStructName} {`,
			)
			l.push(`\t${node.syncStructName} {`)
			l.push(`\t\tclient: std::sync::Arc::clone(client),`)
			for (const c of syncKids) l.push(`\t\t${c.accessor}: ${c.node.modName}::new_resource_sync(client),`)
			l.push(`\t}`)
			l.push(`}`)
			l.push(``)
		}

		for (const plan of node.plans) l.push(...emitOptsStruct(plan), ...emitErrorTypes(plan))

		const here = [...dir, node.modName]
		const filePath =
			node.children.length > 0 ? `src/resources/${here.join("/")}/mod.rs` : `src/resources/${here.join("/")}.rs`
		files.set(filePath, l.join("\n"))
		for (const c of node.children) emitNode(c.node, here)
	}
	for (const c of root.children) emitNode(c.node, [])
	return files
}

export function generateRustSDK(spec: Record<string, unknown>, options: RustSDKOptions = {}): GeneratedRustSDK {
	const crateName = validateCrateName(options.crateName ?? "honey-sdk")
	const throwOnError = options.throwOnError ?? true

	const input = spec as unknown as OpenApiSpecInput
	const model = buildSdkModel(input)
	const { serviceMap } = collectSDKMethods(input)
	const names = buildRustNames(model)
	const hasRealtime = model.ops.some((op) => op.stream === "realtime")
	const realtimeIds = new Set(model.ops.filter((op) => op.stream === "realtime").map((op) => op.id))

	const files: Record<string, string> = {}
	for (const [name, content] of loadRustRuntimeTemplates()) {
		if (name === "realtime.rs" && !hasRealtime) continue
		files[`src/${name}`] = content
	}

	/* schema types claim their names first; operations then hoist into the same table */
	const schemaSource = buildRustTypes(model, names, spec)
	const { plans, root } = buildTree(model, names, spec, throwOnError)
	files["src/client.rs"] = buildRustClient(root, plans, throwOnError, detectAuthScheme(spec), serviceMap, realtimeIds)
	for (const [relPath, content] of buildRustResources(root, throwOnError)) files[relPath] = content
	files["src/types.rs"] = typesFile(schemaSource, names)
	files["src/lib.rs"] = buildLibRs(hasRealtime)
	files["Cargo.toml"] = buildCargoToml(crateName, {
		description: options.description,
		homepage: options.homepage,
		license: options.license,
		repository: options.repository,
		version: options.version ?? "0.1.0",
	})
	if (!files["src/resources/mod.rs"]) files["src/resources/mod.rs"] = `/* Code generated by honey. DO NOT EDIT. */\n`

	return { files, serviceMap }
}
