/** Python SDK code generator.
 *
 * Input is the SDK request model (codegen-sdk-model.ts). Identifiers come from per-scope
 * NameScopes (module, class, method) and every spec string reaches source through pyString,
 * docstring or comment writers (codegen-lang.ts).
 */

import { readFileSync } from "node:fs"
import type { OpenApiSpecInput } from "./codegen.ts"
import { methodsOf, namespacesOf } from "./codegen-ir.ts"
import type { IRNamespace, IRSchema } from "./codegen-ir.ts"
import { NameScope, cmpCodeUnit, pyClassName, pyDocLines, pyIdentifier, pyString } from "./codegen-lang.ts"
import { buildSdkModel } from "./codegen-sdk-model.ts"
import type { SdkModel, SdkOp } from "./codegen-sdk-model.ts"
import { irToPythonNamed, isPyAttributeKey, pyIdent } from "./python-type-emitter.ts"
import type { PyTypeNames } from "./python-type-emitter.ts"

interface PySDKOptions {
	name?: string
	throwOnError?: boolean
	staleTime?: number
	staleMaxEntries?: number
}

interface ServiceMapEntry {
	method: string
	path: string
	operationId: string
	invalidate?: string[]
}

interface PySDKResult {
	files: Record<string, string>
	serviceMap: Record<string, ServiceMapEntry>
}

const PYTHON_FUTURE = "from __future__ import annotations"
const STATIC_FILE_NAMES = [
	"_runtime.py",
	"_errors.py",
	"_invalidation.py",
	"_sse.py",
	"_ws.py",
	"_transport.py",
	"_realtime.py",
] as const
const RUNTIME_TEMPLATE_CACHE = new Map<string, string>()

const ERROR_NAMES: Record<number, string> = {
	400: "BadRequestError",
	401: "UnauthorizedError",
	403: "ForbiddenError",
	404: "NotFoundError",
	409: "ConflictError",
	422: "UnprocessableEntityError",
	429: "RateLimitError",
	500: "InternalServerError",
	502: "BadGatewayError",
	503: "ServiceUnavailableError",
	504: "GatewayTimeoutError",
}

const ERROR_CLASSES = [
	"APIError",
	"APIStatusError",
	"BadGatewayError",
	"BadRequestError",
	"ConflictError",
	"ForbiddenError",
	"GatewayTimeoutError",
	"InternalServerError",
	"NotFoundError",
	"RateLimitError",
	"ServiceUnavailableError",
	"UnauthorizedError",
	"UnprocessableEntityError",
]

const TRANSPORT_EXPORTS = [
	"LongpollAdapter",
	"SseAdapter",
	"TransportAdapter",
	"TransportConn",
	"TransportKind",
	"TransportOpts",
	"WsAdapter",
]

const REALTIME_EXPORTS = ["ConnectionState", "ResumableConnection"]

/** Names a generated module-level type must not take: package exports, typing and builtins. */
const PY_MODULE_RESERVED = [
	"AsyncSDK",
	"SDK",
	...ERROR_CLASSES,
	...TRANSPORT_EXPORTS,
	...REALTIME_EXPORTS,
	"ClientConfig",
	"InvalidationConfig",
	"SDKResult",
	"SSEEvent",
	"PathParamError",
	"FileInput",
	"Any",
	"AsyncIterator",
	"Literal",
	"NotRequired",
	"TypeAlias",
	"TypedDict",
	"bool",
	"bytes",
	"dict",
	"float",
	"int",
	"list",
	"object",
	"str",
	"tuple",
	"type",
	"httpx",
	"asyncio",
	"threading",
	"uuid",
]

export function loadPythonRuntimeTemplates(): Map<string, string> {
	if (RUNTIME_TEMPLATE_CACHE.size > 0) return RUNTIME_TEMPLATE_CACHE
	for (const name of STATIC_FILE_NAMES) {
		const url = new URL(`./client-python/${name}`, import.meta.url)
		RUNTIME_TEMPLATE_CACHE.set(name, readFileSync(url, "utf8"))
	}
	RUNTIME_TEMPLATE_CACHE.set("py.typed", "")
	return RUNTIME_TEMPLATE_CACHE
}

/* ── types ── */

type PyNames = {
	module: NameScope
	types: PyTypeNames
	/** class name → source, for every emitted type (schemas first, then hoisted). */
	decls: Map<string, string>
	declOrder: string[]
	schemaNames: Map<string, string>
}

function typedDictSource(name: string, ir: Extract<IRSchema, { kind: "object" }>, names: PyTypeNames): string {
	const fields = ir.fields.slice().sort((a, b) => cmpCodeUnit(a.name, b.name))
	const rendered = fields.map((f) => {
		const t = irToPythonNamed(f.schema, names, name, f.name)
		return { annotation: f.required ? t : `NotRequired[${t}]`, field: f }
	})
	if (fields.every((f) => isPyAttributeKey(f.name))) {
		const l = [`class ${name}(TypedDict, total=False):`]
		for (const r of rendered) l.push(`    ${r.field.name}: ${r.annotation}`)
		if (rendered.length === 0) l.push(`    pass`)
		return l.join("\n")
	}
	/* functional syntax: any JSON key is allowed; annotations are strings, so forward refs work */
	const l = [`${name} = TypedDict(`, `    ${pyString(name)},`, `    {`]
	for (const r of rendered) l.push(`        ${pyString(r.field.name)}: ${pyString(r.annotation)},`)
	l.push(`    },`, `    total=False,`, `)`)
	return l.join("\n")
}

function buildPyNames(model: SdkModel): PyNames {
	const module = new NameScope(PY_MODULE_RESERVED)
	const schemaNames = new Map<string, string>()
	for (const name of model.schemaNames) {
		const base = pyClassName(name)
		schemaNames.set(name, module.has(base) ? module.claim(`${base}Model`) : module.claim(base))
	}
	const decls = new Map<string, string>()
	const declOrder: string[] = []
	const hoistKeys = new Map<string, string>()
	const names: PyNames = { declOrder, decls, module, schemaNames, types: undefined as unknown as PyTypeNames }
	names.types = {
		hoist: (key, base, schema) => {
			const hit = hoistKeys.get(key)
			if (hit) return hit
			const name = module.claim(pyClassName(base))
			hoistKeys.set(key, name)
			decls.set(name, "")
			declOrder.push(name)
			decls.set(name, typedDictSource(name, schema, names.types))
			return name
		},
		ref: (name) => schemaNames.get(name) ?? pyClassName(name),
	}
	return names
}

function buildPyTypes(model: SdkModel, names: PyNames): string {
	const body: string[] = []
	for (const name of model.schemaNames) {
		const ir = model.ir.schemas[name]
		const pyName = names.types.ref(name)
		if (ir.kind === "object" && ir.fields.length > 0) {
			body.push(typedDictSource(pyName, ir, names.types))
		} else {
			/* string alias: lazy, so the order of definitions does not matter */
			const t = irToPythonNamed(ir, names.types, pyName, "")
			body.push(`${pyName}: TypeAlias = ${pyString(t)}`)
		}
		body.push("")
	}
	return body.join("\n")
}

function typesFile(schemaSource: string, names: PyNames): string {
	const hoisted = names.declOrder.map((n) => `${names.decls.get(n)}\n`).join("\n")
	const bodyText = `${schemaSource}\n${hoisted}`
	const typing = ["Any", "Literal", "NotRequired", "TypeAlias", "TypedDict"].filter((sym) =>
		new RegExp(`\\b${sym}\\b`).test(bodyText),
	)
	const fileInput = /\bFileInput\b/.test(bodyText)
	/* string aliases mention `Any`/`Literal` only inside quotes; keep them importable for checkers */
	if (/TypeAlias = /.test(bodyText)) {
		for (const sym of ["Any", "Literal"]) if (!typing.includes(sym)) typing.push(sym)
	}
	const l: string[] = []
	l.push("# ruff: noqa: E501")
	l.push(PYTHON_FUTURE)
	l.push("")
	if (typing.length > 0) l.push(`from typing import ${typing.sort(cmpCodeUnit).join(", ")}`)
	if (fileInput) l.push(`from ._runtime import FileInput`)
	if (typing.length > 0 || fileInput) l.push("")
	l.push(bodyText)
	const exported = [...names.schemaNames.values(), ...names.declOrder]
	if (exported.length === 0) l.push("__all__: list[str] = []")
	else l.push(`__all__ = [${exported.map(pyString).join(", ")}]`)
	l.push("")
	return l.join("\n")
}

/* ── client ── */

type PyParam = { local: string; wire: string }

type PyOpPlan = {
	op: SdkOp
	methodName: string
	pathParams: PyParam[]
	queryParams: Array<PyParam & { required: boolean; type: string }>
	headerParams: Array<PyParam & { required: boolean; type: string }>
	body?: { local: string; type: string; required: boolean }
	multipart?: { files: string[]; listFiles: string[] }
	returnType: string
}

/** kwargs the generated methods always take; params must not reuse them. */
const PY_METHOD_RESERVED = [
	"self",
	"timeout",
	"headers",
	"cancel_token",
	"idempotency_key",
	"last_event_id",
	"protocols",
	"reconnect_token",
]

function planPyOp(op: SdkOp, methodName: string, names: PyNames, model: SdkModel): PyOpPlan {
	const locals = new NameScope(PY_METHOD_RESERVED)
	const typeParent = pyClassName(op.id)
	const plan: PyOpPlan = { headerParams: [], methodName, op, pathParams: [], queryParams: [], returnType: "None" }
	const b = op.body
	const hasBodyArg = b !== undefined && op.stream !== "ws" && op.stream !== "realtime"
	const bodyLocal = hasBodyArg ? locals.claim("body") : ""
	for (const p of op.pathParams) plan.pathParams.push({ local: locals.claim(pyIdentifier(p.name)), wire: p.name })
	if (op.stream !== "realtime") {
		for (const q of op.query) {
			if (op.stream === "sse" && /^last[-_]?event[-_]?id$/i.test(q.name)) continue
			plan.queryParams.push({
				local: locals.claim(pyIdentifier(q.name)),
				required: q.required === true,
				type: irToPythonNamed(q.schema, names.types, typeParent, q.name),
				wire: q.name,
			})
		}
		for (const h of op.headers) {
			plan.headerParams.push({
				local: locals.claim(pyIdentifier(h.name)),
				required: h.required === true,
				type: irToPythonNamed(h.schema, names.types, typeParent, h.name),
				wire: h.name,
			})
		}
	}
	if (hasBodyArg && b) {
		let type: string
		switch (b.kind) {
			case "json":
			case "form":
				type = irToPythonNamed(b.schema, names.types, typeParent, "Body")
				break
			case "binary":
				type = "bytes | AsyncIterator[bytes]"
				break
			case "text":
				type = "str"
				break
			case "multipart": {
				const files: string[] = []
				const listFiles: string[] = []
				const fields = b.parts.map((part) => {
					const schema = part.schema ? model.resolve(part.schema) : ({ kind: "unknown" } as IRSchema)
					if (part.type === "file") {
						if (schema.kind === "array") listFiles.push(part.name)
						else files.push(part.name)
						return {
							name: part.name,
							required: false,
							schema: { kind: "unknown" } as IRSchema,
							file: true,
							list: schema.kind === "array",
						}
					}
					return {
						file: false,
						list: false,
						name: part.name,
						required: false,
						schema: part.schema ?? ({ kind: "unknown" } as IRSchema),
					}
				})
				const objectIR: Extract<IRSchema, { kind: "object" }> = {
					fields: fields.map((f) => ({ name: f.name, required: f.required, schema: f.schema })),
					kind: "object",
				}
				type = names.types.hoist(`${op.id}.multipart`, `${typeParent}Body`, objectIR)
				/* file parts: re-render with the FileInput alias instead of Any */
				const decl = names.decls.get(type) ?? ""
				let patched = decl
				for (const f of fields.filter((x) => x.file)) {
					const key = pyString(f.name)
					const t = f.list ? "list[FileInput]" : "FileInput"
					patched = patched
						.replace(`    ${f.name}: NotRequired[Any]`, `    ${f.name}: NotRequired[${t}]`)
						.replace(`        ${key}: "NotRequired[Any]",`, `        ${key}: ${pyString(`NotRequired[${t}]`)},`)
				}
				names.decls.set(type, patched)
				plan.multipart = { files, listFiles }
				break
			}
		}
		plan.body = { local: bodyLocal, required: b.required, type }
	}
	if (op.stream === null) {
		const s = op.success
		if (s.kind === "json")
			plan.returnType = s.schema ? irToPythonNamed(s.schema, names.types, typeParent, "Response") : "Any"
		else if (s.kind === "text") plan.returnType = "str"
		else if (s.kind === "binary") plan.returnType = "bytes"
		else plan.returnType = "None"
	}
	return plan
}

function signature(plan: PyOpPlan, throwOnError: boolean, isAsync: boolean): string[] {
	const { op } = plan
	const defKw = op.stream === "ws" || op.stream === "realtime" || !isAsync ? "def" : "async def"
	const pos: string[] = ["self", ...plan.pathParams.map((p) => `${p.local}: str`)]
	const kw: string[] = []

	if (op.stream === "realtime") {
		kw.push(
			`reconnect_token: str | None = None`,
			`last_event_id: str | None = None`,
			`headers: dict[str, str] | None = None`,
		)
		return emitSignature(defKw, plan.methodName, pos, kw, "ResumableConnection")
	}

	if (plan.body) {
		if (plan.body.required) pos.push(`${plan.body.local}: ${plan.body.type}`)
		else kw.push(`${plan.body.local}: ${optional(plan.body.type)} = None`)
	}
	for (const q of [...plan.queryParams, ...plan.headerParams]) {
		if (q.required) pos.push(`${q.local}: ${q.type}`)
		else kw.push(`${q.local}: ${optional(q.type)} = None`)
	}
	if (op.stream === "sse") kw.push(`last_event_id: str | None = None`, `headers: dict[str, str] | None = None`)
	if (op.stream === "ws") {
		kw.push(
			`protocols: list[str] | None = None`,
			`reconnect_token: str | None = None`,
			`headers: dict[str, str] | None = None`,
		)
	}
	if (op.stream === null) {
		if (op.idempotent) kw.push(`idempotency_key: str | None = None`)
		kw.push(`timeout: float | None = None`, `headers: dict[str, str] | None = None`)
		kw.push(`cancel_token: "threading.Event | None" = None`)
	}

	let ret: string
	if (op.stream === "sse") ret = "AsyncIterator[SSEEvent]"
	else if (op.stream === "ws") ret = "_TypedWebSocket"
	else if (throwOnError) ret = plan.returnType
	else ret = `SDKResult[${plan.returnType}]`
	return emitSignature(defKw, plan.methodName, pos, kw, ret)
}

function optional(t: string): string {
	return t.endsWith("| None") ? t : `${t} | None`
}

function emitSignature(defKw: string, name: string, pos: string[], kw: string[], ret: string): string[] {
	if (kw.length === 0) return [`    ${defKw} ${name}(${pos.join(", ")}) -> ${ret}:`]
	const l = [`    ${defKw} ${name}(${pos.join(", ")},`, `        *,`]
	kw.forEach((k, i) => l.push(`        ${k}${i < kw.length - 1 ? "," : ""}`))
	l.push(`    ) -> ${ret}:`)
	return l
}

function docstring(op: SdkOp): string[] {
	const text = op.summary || op.description
	const lines = text ? pyDocLines(text) : []
	if (lines.length === 0 && op.errorStatuses.length === 0) return []
	const out: string[] = []
	if (op.errorStatuses.length === 0 && lines.length === 1) return [`        """${lines[0]}"""`]
	out.push(`        """${lines[0] ?? ""}`)
	for (const line of lines.slice(1)) out.push(line === "" ? "" : `        ${line}`)
	if (op.errorStatuses.length > 0) {
		out.push(``)
		out.push(`        Raises:`)
		for (const status of op.errorStatuses)
			out.push(`            ${ERROR_NAMES[status] ?? "APIStatusError"}: HTTP ${status}`)
	}
	out.push(`        """`)
	return out
}

function pathExpr(plan: PyOpPlan): string {
	if (plan.pathParams.length === 0) return pyString(plan.op.path)
	const dict = plan.pathParams.map((p) => `${pyString(p.wire)}: ${p.local}`).join(", ")
	return `_expand_path(${pyString(plan.op.path)}, {${dict}})`
}

function paramsDict(plan: PyOpPlan): string {
	const entries = plan.queryParams.map((q) => `${pyString(q.wire)}: ${q.local}`)
	return `{${entries.join(", ")}}`
}

function headerLines(plan: PyOpPlan, configRef: string, authRef: string, base: string): string[] {
	const l: string[] = []
	l.push(`        _extra: dict[str, str] = ${base}`)
	for (const h of plan.headerParams) {
		l.push(`        if ${h.local} is not None:`)
		l.push(`            _extra[${pyString(h.wire)}] = _format_value(${h.local})`)
	}
	l.push(`        _extra.update(headers or {})`)
	l.push(`        _headers = _build_headers(${configRef}, extra=_extra, bearer_token=${authRef}.token)`)
	return l
}

function bodyArgs(plan: PyOpPlan, l: string[]): string {
	const b = plan.op.body
	const local = plan.body?.local
	if (!b || !local) return ""
	switch (b.kind) {
		case "json":
			return `json=${local}`
		case "form":
			l.push(`        _headers.setdefault("Content-Type", "application/x-www-form-urlencoded")`)
			return `content=_form_content(${local})`
		case "text":
			l.push(`        _set_header(_headers, "Content-Type", ${pyString(b.contentType)})`)
			return `content=${local}.encode() if ${local} is not None else None`
		case "binary":
			l.push(`        _set_header(_headers, "Content-Type", ${pyString(b.contentType)})`)
			return `content=${local}`
		case "multipart": {
			const files = plan.multipart?.files ?? []
			const listFiles = plan.multipart?.listFiles ?? []
			l.push(
				`        _data, _files = _multipart_parts(${local}, files=[${files.map(pyString).join(", ")}], list_files=[${listFiles.map(pyString).join(", ")}])`,
			)
			return `data=_data, files=_files`
		}
	}
}

function methodBody(plan: PyOpPlan, throwOnError: boolean, isAsync: boolean, isTopLevel: boolean): string[] {
	const l: string[] = []
	const { op } = plan
	const self = isTopLevel ? "self" : "self._client"
	const configRef = `${self}._config`
	const authRef = `${self}._auth`
	const clientRef = isAsync ? `${self}._async_client` : `${self}._sync_client`
	const trackerRef = `${self}._stale_tracker`
	const aw = isAsync ? "await " : ""

	if (op.stream === "realtime") {
		l.push(`        _url = _build_url(${configRef}.base_url, ${pathExpr(plan)})`)
		l.push(`        _opts = TransportOpts(`)
		l.push(`            reconnect_token=reconnect_token,`)
		l.push(`            last_event_id=last_event_id,`)
		l.push(`            headers=_build_headers(${configRef}, extra=headers, bearer_token=${authRef}.token),`)
		l.push(`        )`)
		l.push(`        _transports: list[Any] = [WsAdapter(), SseAdapter(), LongpollAdapter()]`)
		l.push(`        return ResumableConnection(_url, _transports, _opts)`)
		return l
	}

	l.push(`        _path = ${pathExpr(plan)}`)

	if (op.stream === "ws") {
		l.push(`        _params: dict[str, Any] = ${paramsDict(plan)}`)
		l.push(`        if reconnect_token is not None:`)
		l.push(`            _params["reconnect_token"] = reconnect_token`)
		l.push(...headerLines(plan, configRef, authRef, "{}"))
		l.push(`        _url = _build_url(${configRef}.base_url, _path, _params)`)
		l.push(`        _ws_url = _to_ws_url(_url)`)
		l.push(`        return _TypedWebSocket(_ws_url, protocols=protocols, extra_headers=_headers)`)
		return l
	}

	if (op.stream === "sse") {
		l.push(`        _params: dict[str, Any] = ${paramsDict(plan)}`)
		l.push(...headerLines(plan, configRef, authRef, `{"Accept": "text/event-stream"}`))
		l.push(`        if last_event_id is not None:`)
		l.push(`            _headers["Last-Event-ID"] = last_event_id`)
		const args = bodyArgs(plan, l)
		l.push(`        _url = _build_url(${configRef}.base_url, _path, _params)`)
		l.push(
			`        async with _open_stream(${clientRef}, ${configRef}, ${pyString(op.method)}, _url, _headers${args ? `, ${args}` : ""}) as _response:`,
		)
		l.push(`            async for _event in parse_sse_stream(_response):`)
		l.push(`                yield _event`)
		return l
	}

	l.push(`        _params: dict[str, Any] = ${paramsDict(plan)}`)
	l.push(...headerLines(plan, configRef, authRef, "{}"))
	if (op.idempotent) {
		/* explicit header (any casing) > idempotency_key kwarg > uuid4 */
		l.push(`        if not _has_header(_headers, "Idempotency-Key"):`)
		l.push(
			`            _headers["Idempotency-Key"] = idempotency_key if idempotency_key is not None else str(uuid.uuid4())`,
		)
	}
	const args = bodyArgs(plan, l)
	const dictEntries = plan.pathParams.map((p) => `${pyString(p.wire)}: ${p.local}`)
	l.push(
		`        _path_params: dict[str, str] | None = ${dictEntries.length > 0 ? `{${dictEntries.join(", ")}}` : "None"}`,
	)
	l.push(`        _selector = ${pyString(`${op.method} `)} + _path`)
	l.push(`        _request_meta = ${aw}${trackerRef}.build_request_meta(_selector, _path, ${pyString(op.method)})`)
	l.push(`        _url = _build_url(${configRef}.base_url, _path, _params)`)
	l.push(`        _response = ${aw}${isAsync ? "_do_request_async" : "_do_request_sync"}(`)
	l.push(`            ${clientRef}, ${configRef}, ${pyString(op.method)}, _url,`)
	l.push(`            headers=_headers,${args ? ` ${args},` : ""} timeout=timeout,`)
	l.push(`            cancel_token=cancel_token, operation=${pyString(`${op.method} ${op.path}`)},`)
	l.push(`            request_meta=_request_meta, auth=${authRef},`)
	l.push(`        )`)
	l.push(`        if 200 <= _response.status_code < 300:`)
	const targets = op.invalidates.map(pyString).join(", ")
	l.push(`            ${aw}${trackerRef}.mark_stale([${targets}], _path_params, _selector)`)
	l.push(`            if _request_meta is not None and _request_meta.is_stale:`)
	l.push(
		`                ${aw}${trackerRef}.clear_stale(_selector, _path, ${pyString(op.method)}, _request_meta.seq_snapshot)`,
	)
	const kind = op.success.kind
	if (throwOnError) {
		l.push(`        _raise_for_status(_response)`)
		l.push(`        return _parse_body(_response, ${pyString(kind)})`)
	} else {
		l.push(`        if not 200 <= _response.status_code < 300:`)
		l.push(
			`            return SDKResult(data=None, error=_parse_body(_response), status=_response.status_code, response=_response)`,
		)
		l.push(
			`        return SDKResult(data=_parse_body(_response, ${pyString(kind)}), error=None, status=_response.status_code, response=_response)`,
		)
	}
	return l
}

type PyClassNode = {
	asyncName: string
	syncName?: string
	path: string[]
	ns: IRNamespace
	children: Array<{ attr: string; node: PyClassNode }>
	plans: PyOpPlan[]
}

function isSyncCapable(op: SdkOp): boolean {
	return op.stream === null && op.body?.kind !== "binary"
}

function hasSyncContent(node: PyClassNode): boolean {
	return node.plans.some((p) => isSyncCapable(p.op)) || node.children.some((c) => hasSyncContent(c.node))
}

function trackerInit(cls: string): string[] {
	return [
		"        _inv = config.invalidation",
		`        self._stale_tracker = ${cls}(`,
		"            stale_time=_inv.stale_time if _inv is not None else 0.0,",
		"            stale_max_entries=(",
		"                _inv.stale_max_entries if _inv is not None else 1000",
		"            ),",
		"            max_sources_per_target=(",
		"                _inv.max_sources_per_target if _inv is not None else 16",
		"            ),",
		"        )",
	]
}

function buildPyClient(
	model: SdkModel,
	names: PyNames,
	options: PySDKOptions,
	serviceMap: Record<string, ServiceMapEntry>,
): string {
	const throwOnError = options.throwOnError !== false
	function planNs(ns: IRNamespace, path: string[], reserved: string[]): PyClassNode {
		const members = new NameScope(reserved)
		const node: PyClassNode = {
			asyncName: path.length === 0 ? "AsyncSDK" : names.module.claim(`_${path.map(pyClassName).join("")}Resource`),
			children: [],
			ns,
			path,
			plans: [],
		}
		if (path.length > 0) node.syncName = names.module.claim(`_Sync${path.map(pyClassName).join("")}Resource`)
		for (const [seg, childNs] of namespacesOf(ns)) {
			const attr = members.claim(pyIdent(seg))
			node.children.push({ attr, node: planNs(childNs, [...path, seg], ["_client"]) })
		}
		for (const [seg, irOp] of methodsOf(ns)) {
			const op = model.opsById.get(irOp.id)
			if (!op) continue
			let base = pyIdentifier(seg)
			if (op.stream === "realtime") {
				/* realtime methods keep the `connectX` name they always had */
				const ident = pyIdentifier(seg)
				base = /^connect(_|$)/.test(ident) ? ident : `connect${ident.charAt(0).toUpperCase()}${ident.slice(1)}`
			}
			node.plans.push(planPyOp(op, members.claim(base), names, model))
		}
		return node
	}
	const root = planNs(
		model.ir.tree,
		[],
		["_config", "_auth", "_async_client", "_sync_client", "_stale_tracker", "is_stale", "aclose", "close"],
	)

	const body: string[] = []
	const invEntries = Object.entries(serviceMap).filter(([, v]) => v.invalidate && v.invalidate.length > 0)
	body.push("_INVALIDATION_MAP: dict[str, dict[str, Any]] = {")
	for (const [opId, entry] of invEntries) {
		body.push(`    ${pyString(opId)}: {`)
		body.push(`        "method": ${pyString(entry.method)},`)
		body.push(`        "path": ${pyString(entry.path)},`)
		body.push(`        "invalidate": [${(entry.invalidate ?? []).map(pyString).join(", ")}],`)
		body.push(`    },`)
	}
	body.push("}")
	body.push("")

	/* children before parents so class names resolve at definition time */
	/* every resource holds the root SDK: nested resources reach config and clients directly */
	function emitAsync(node: PyClassNode): void {
		for (const c of node.children) emitAsync(c.node)
		if (node.path.length === 0) return
		body.push(`class ${node.asyncName}:`)
		body.push(`    def __init__(self, _client: "AsyncSDK") -> None:`)
		body.push(`        self._client = _client`)
		for (const c of node.children) body.push(`        self.${c.attr} = ${c.node.asyncName}(_client)`)
		body.push("")
		for (const plan of node.plans) {
			body.push(...signature(plan, throwOnError, true))
			body.push(...docstring(plan.op))
			body.push(...methodBody(plan, throwOnError, true, false))
			body.push("")
		}
		body.push("")
	}

	function emitSync(node: PyClassNode): void {
		for (const c of node.children) emitSync(c.node)
		if (node.path.length === 0 || !hasSyncContent(node)) return
		body.push(`class ${node.syncName}:`)
		body.push(`    def __init__(self, _client: "SDK") -> None:`)
		body.push(`        self._client = _client`)
		for (const c of node.children) {
			if (hasSyncContent(c.node)) body.push(`        self.${c.attr} = ${c.node.syncName}(_client)`)
		}
		body.push("")
		for (const plan of node.plans.filter((p) => isSyncCapable(p.op))) {
			body.push(...signature(plan, throwOnError, false))
			body.push(...docstring(plan.op))
			body.push(...methodBody(plan, throwOnError, false, false))
			body.push("")
		}
		body.push("")
	}

	emitAsync(root)
	emitSync(root)

	body.push("class SDK:")
	body.push("    def __init__(self, config: ClientConfig) -> None:")
	body.push("        self._config = config")
	body.push("        self._auth = _AuthState(config.bearer_token)")
	body.push("        self._sync_client = httpx.Client(")
	body.push("            transport=config.sync_transport,")
	body.push("        )")
	body.push(...trackerInit("_StaleTrackerSync"))
	for (const c of root.children) {
		if (hasSyncContent(c.node)) body.push(`        self.${c.attr} = ${c.node.syncName}(self)`)
	}
	body.push("")
	body.push("    def close(self) -> None:")
	body.push('        """Closes the underlying HTTP client."""')
	body.push("        self._sync_client.close()")
	body.push("")
	body.push("    def is_stale(self, method: str, path: str) -> bool:")
	body.push('        """Returns True when (method, path) sits inside an active stale window."""')
	body.push("        return self._stale_tracker.is_stale(method, path)")
	body.push("")
	for (const plan of root.plans.filter((p) => isSyncCapable(p.op))) {
		body.push(...signature(plan, throwOnError, false))
		body.push(...docstring(plan.op))
		body.push(...methodBody(plan, throwOnError, false, true))
		body.push("")
	}
	body.push("")

	body.push("class AsyncSDK:")
	body.push("    def __init__(self, config: ClientConfig) -> None:")
	body.push("        self._config = config")
	body.push("        self._auth = _AuthState(config.bearer_token)")
	body.push("        self._async_client = httpx.AsyncClient(")
	body.push("            transport=config.transport,")
	body.push("        )")
	body.push(...trackerInit("_StaleTracker"))
	for (const c of root.children) body.push(`        self.${c.attr} = ${c.node.asyncName}(self)`)
	body.push("")
	body.push("    async def aclose(self) -> None:")
	body.push('        """Closes the underlying HTTP client."""')
	body.push("        await self._async_client.aclose()")
	body.push("")
	body.push("    async def is_stale(self, method: str, path: str) -> bool:")
	body.push('        """Returns True when (method, path) sits inside an active stale window."""')
	body.push("        return await self._stale_tracker.is_stale(method, path)")
	body.push("")
	for (const plan of root.plans) {
		body.push(...signature(plan, throwOnError, true))
		body.push(...docstring(plan.op))
		body.push(...methodBody(plan, throwOnError, true, true))
		body.push("")
	}

	return body.join("\n")
}

function clientFile(bodyText: string, names: PyNames): string {
	const uses = (sym: string) => new RegExp(`(?<![\\w.])${sym.replace(/[.]/g, "\\.")}\\b`).test(bodyText)
	const imports: string[] = []
	if (/\bthreading\b/.test(bodyText)) imports.push("import threading")
	if (/\buuid\.uuid4\b/.test(bodyText)) imports.push("import uuid")
	imports.push("import httpx")

	const typingUsed = ["Any", "AsyncIterator", "Literal", "NotRequired", "TypedDict"].filter(uses)
	if (typingUsed.length > 0) imports.push(`from typing import ${typingUsed.join(", ")}`)

	const groups: Array<[string, string[]]> = [
		[
			"._runtime",
			[
				"ClientConfig",
				"SDKResult",
				"_AuthState",
				"_build_headers",
				"_build_url",
				"_do_request_async",
				"_do_request_sync",
				"_expand_path",
				"_form_content",
				"_format_value",
				"_has_header",
				"_multipart_parts",
				"_open_stream",
				"_parse_body",
				"_raise_for_status",
				"_set_header",
				"_to_ws_url",
			],
		],
		["._invalidation", ["_StaleTracker", "_StaleTrackerSync"]],
		["._sse", ["SSEEvent", "parse_sse_stream"]],
		["._ws", ["_TypedWebSocket"]],
		["._transport", ["LongpollAdapter", "SseAdapter", "TransportOpts", "WsAdapter"]],
		["._realtime", ["ResumableConnection"]],
	]
	for (const [mod, syms] of groups) {
		const used = syms.filter(uses)
		if (used.length === 0) continue
		imports.push(`from ${mod} import (`)
		for (const s of used) imports.push(`    ${s},`)
		imports.push(")")
	}

	const typeNames = [...names.schemaNames.values(), ...names.declOrder].filter(uses).sort(cmpCodeUnit)
	if (typeNames.length > 0) {
		imports.push("from .types import (")
		for (const n of typeNames) imports.push(`    ${n},`)
		imports.push(")")
	}

	const out: string[] = []
	out.push("# ruff: noqa: E501")
	out.push(PYTHON_FUTURE)
	out.push("")
	out.push(...imports)
	out.push("")
	out.push(bodyText)
	out.push("")
	return out.join("\n")
}

function buildPyInit(names: PyNames): string {
	const typeNames = [...names.schemaNames.values()].sort(cmpCodeUnit)

	const l: string[] = []
	l.push(PYTHON_FUTURE)
	l.push("")
	l.push("from .client import AsyncSDK, SDK")
	l.push("from ._errors import (")
	for (const name of ERROR_CLASSES) l.push(`    ${name},`)
	l.push(")")
	l.push("from ._runtime import ClientConfig, InvalidationConfig, PathParamError")
	l.push("from ._transport import (")
	for (const name of TRANSPORT_EXPORTS) l.push(`    ${name},`)
	l.push(")")
	l.push("from ._realtime import (")
	for (const name of REALTIME_EXPORTS) l.push(`    ${name},`)
	l.push(")")
	if (typeNames.length > 0) {
		l.push("from .types import (")
		for (const name of typeNames) l.push(`    ${name},`)
		l.push(")")
	}

	l.push("")
	const allExports = [
		"AsyncSDK",
		"SDK",
		...ERROR_CLASSES,
		"ClientConfig",
		"InvalidationConfig",
		"PathParamError",
		...TRANSPORT_EXPORTS,
		...REALTIME_EXPORTS,
		...typeNames,
	]
	l.push("__all__ = [")
	for (const name of allExports) l.push(`    ${pyString(name)},`)
	l.push("]")
	l.push("")
	return l.join("\n")
}

function buildServiceMap(model: SdkModel): Record<string, ServiceMapEntry> {
	const result: Record<string, ServiceMapEntry> = Object.create(null)
	for (const op of model.ops) {
		result[op.id] = {
			invalidate: op.invalidates.length > 0 ? op.invalidates : undefined,
			method: op.method,
			operationId: op.id,
			path: op.path,
		}
	}
	return result
}

export function generatePythonSDK(spec: Record<string, unknown>, options: PySDKOptions = {}): PySDKResult {
	const templates = loadPythonRuntimeTemplates()
	const model = buildSdkModel(spec as unknown as OpenApiSpecInput)
	const serviceMap = buildServiceMap(model)
	const names = buildPyNames(model)

	const files: Record<string, string> = {}
	for (const [name, content] of templates) files[name] = content

	/* schema types claim their names first; the client then hoists into the same table */
	const schemaSource = buildPyTypes(model, names)
	files["client.py"] = clientFile(buildPyClient(model, names, options, serviceMap), names)
	files["types.py"] = typesFile(schemaSource, names)
	files["__init__.py"] = buildPyInit(names)

	return { files, serviceMap }
}
