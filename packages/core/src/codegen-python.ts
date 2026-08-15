/** Python SDK code generator. Mirrors TS SDK emitter in codegen.ts. */

import { readFileSync } from "node:fs"
import { extractOpenApiPathParams, isSSEOperation } from "./codegen.ts"
import { methodsOf, namespacesOf, toIR } from "./codegen-ir.ts"
import type { IRNamespace } from "./codegen-ir.ts"
import { jsonSchemaToPy, pyIdent } from "./python-type-emitter.ts"

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

interface OperationInfo {
	operationId: string
	method: string
	path: string
	summary?: string
	description?: string
	pathParams: string[]
	queryParams: ParamInfo[]
	bodySchema: Record<string, unknown> | undefined
	bodyRequired: boolean
	bodyIsStream: boolean
	successType: string
	errorStatuses: number[]
	isSSE: boolean
	isWS: boolean
	isRealtime: boolean
	isIdempotent: boolean
	invalidate: string[]
	parameters: Array<{ in: string; name: string; required: boolean; schema: Record<string, unknown> }>
}

interface ParamInfo {
	name: string
	required: boolean
	schema: Record<string, unknown>
}

const PYTHON_FUTURE = "from __future__ import annotations"
const STATIC_FILE_NAMES = ["_runtime.py", "_errors.py", "_invalidation.py", "_sse.py", "_ws.py", "_transport.py", "_realtime.py"] as const
const RUNTIME_TEMPLATE_CACHE = new Map<string, string>()
const WS_EXTENSION = "x-websocket"
const REALTIME_EXTENSION = "x-realtime"
const INVALIDATE_EXTENSION = "x-invalidate"
const IDEMPOTENCY_EXTENSION = "x-idempotency-key"
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const

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

export function loadPythonRuntimeTemplates(): Map<string, string> {
	if (RUNTIME_TEMPLATE_CACHE.size > 0) return RUNTIME_TEMPLATE_CACHE
	for (const name of STATIC_FILE_NAMES) {
		const url = new URL(`./client-python/${name}`, import.meta.url)
		RUNTIME_TEMPLATE_CACHE.set(name, readFileSync(url, "utf8"))
	}
	RUNTIME_TEMPLATE_CACHE.set("py.typed", "")
	return RUNTIME_TEMPLATE_CACHE
}

function resolveSchema(
	spec: Record<string, unknown>,
	schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!schema) return undefined
	if (!schema.$ref) return schema
	const ref = schema.$ref as string
	const parts = ref.replace(/^#\//, "").split("/")
	let cur: unknown = spec
	for (const part of parts) {
		cur = (cur as Record<string, unknown>)[part]
	}
	return cur as Record<string, unknown> | undefined
}

function getSuccessType(
	spec: Record<string, unknown>,
	operation: Record<string, unknown>,
): string {
	const responses = operation.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return "None"
	const successCodes = ["200", "201", "202", "204"]
	for (const code of successCodes) {
		const resp = responses[code]
		if (!resp) continue
		if (code === "204") return "None"
		const content = resp.content as Record<string, Record<string, unknown>> | undefined
		if (!content) continue
		const jsonContent = content["application/json"]
		if (!jsonContent) continue
		const schema = resolveSchema(spec, jsonContent.schema as Record<string, unknown> | undefined)
		if (!schema) continue
		const rawRef = (jsonContent.schema as Record<string, unknown> | undefined)?.$ref as string | undefined
		if (rawRef) {
			const parts = rawRef.split("/")
			return parts[parts.length - 1]
		}
		return jsonSchemaToPy(schema, 0)
	}
	return "None"
}

function getErrorStatuses(operation: Record<string, unknown>): number[] {
	const responses = operation.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return []
	return Object.keys(responses)
		.map(Number)
		.filter((n) => n >= 400)
		.sort()
}

function collectOperations(spec: Record<string, unknown>): OperationInfo[] {
	const paths = spec.paths as Record<string, Record<string, unknown>> | undefined
	if (!paths) return []
	const ops: OperationInfo[] = []

	for (const [path, pathItem] of Object.entries(paths)) {
		for (const httpMethod of HTTP_METHODS) {
			const operation = pathItem[httpMethod] as Record<string, unknown> | undefined
			if (!operation) continue
			const operationId = operation.operationId as string | undefined
			if (!operationId) continue

			const rawParams = (operation.parameters ?? []) as Array<Record<string, unknown>>
			const pathParams = extractOpenApiPathParams(path)
			const queryParams: ParamInfo[] = rawParams
				.filter((p) => p.in === "query")
				.map((p) => ({
					name: p.name as string,
					required: p.required === true,
					schema: (p.schema ?? {}) as Record<string, unknown>,
				}))

			const requestBody = operation.requestBody as Record<string, unknown> | undefined
			let bodySchema: Record<string, unknown> | undefined
			let bodyIsStream = false
			const bodyRequired = requestBody?.required === true
			if (requestBody) {
				const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
				const jsonContent = content?.["application/json"]
				const octetContent = content?.["application/octet-stream"]
				if (octetContent) {
					bodyIsStream = true
				} else if (jsonContent) {
					const rawSchema = jsonContent.schema as Record<string, unknown> | undefined
					bodySchema = resolveSchema(spec, rawSchema)
					if (rawSchema?.$ref) {
						const refParts = (rawSchema.$ref as string).split("/")
						bodySchema = { $ref: rawSchema.$ref, _refName: refParts[refParts.length - 1] }
					}
				}
			}

			const isRealtime = operation[REALTIME_EXTENSION] === true
			ops.push({
				bodyIsStream,
				bodyRequired,
				bodySchema,
				description: operation.description as string | undefined,
				errorStatuses: getErrorStatuses(operation),
				invalidate: (operation[INVALIDATE_EXTENSION] as string[] | undefined) ?? [],
				isIdempotent: operation[IDEMPOTENCY_EXTENSION] === true,
				/* realtime wins over SSE / WS when extensions conflict — higher-level protocol */
				isRealtime,
				isSSE: !isRealtime && isSSEOperation(operation),
				isWS: !isRealtime && operation[WS_EXTENSION] === true,
				method: httpMethod.toUpperCase(),
				operationId,
				parameters: rawParams as Array<{ in: string; name: string; required: boolean; schema: Record<string, unknown> }>,
				path,
				pathParams,
				queryParams,
				successType: getSuccessType(spec, operation),
				summary: operation.summary as string | undefined,
			})
		}
	}

	return ops
}

function nestedClassName(path: string[]): string {
	const pascal = path.map((seg) => {
		const safe = pyIdent(seg)
		return safe.charAt(0).toUpperCase() + safe.slice(1)
	}).join("")
	return `_${pascal}Resource`
}

function collectSDKMethods(spec: Record<string, unknown>): {
	tree: IRNamespace
	topLevel: OperationInfo[]
	opsByOpId: Map<string, OperationInfo>
} {
	const ops = collectOperations(spec)
	const ir = toIR(spec as Parameters<typeof toIR>[0])
	const topLevel: OperationInfo[] = []
	const opsByOpId = new Map<string, OperationInfo>()

	for (const op of ops) {
		opsByOpId.set(op.operationId, op)
		if (!op.operationId.includes(".")) {
			topLevel.push(op)
		}
	}

	return { opsByOpId, topLevel, tree: ir.tree }
}

function pyParamName(name: string): string {
	const safe = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^([0-9])/, "_$1")
	return pyIdent(safe)
}

function bodyTypeName(bodySchema: Record<string, unknown> | undefined): string {
	if (!bodySchema) return "Any"
	const refName = bodySchema._refName as string | undefined
	if (refName) return refName
	return "Any"
}

function buildMethodSignature(op: OperationInfo, throwOnError: boolean, isAsync: boolean): string[] {
	const lines: string[] = []
	/* WS methods just construct the _TypedWebSocket context-manager — no async
	 * work happens until __aenter__; emit as sync `def` matching TS / Go / Rust
	 * surface (caller awaits __aenter__ via `async with`, not the constructor). */
	let defKw: string
	if (op.isWS) defKw = "def"
	else if (isAsync) defKw = "async def"
	else defKw = "def"
	const segments = op.operationId.split(".")
	const actionPart = segments[segments.length - 1] ?? op.operationId
	/* convert camelCase to snake_case for Python naming convention */
	const snakeAction = actionPart.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, "")
	const ident = pyIdent(snakeAction)
	/* realtime method always named `connect<X>` — follow camelCase convention used elsewhere
	 * in the emitted SDK (connectWs, createUser). If operationId already begins with "connect",
	 * use verbatim; otherwise prepend "connect" + capitalize first char of action. */
	const alreadyConnectPrefixed = /^connect([A-Z_]|$)/.test(ident)
	const realtimeName = alreadyConnectPrefixed ? ident : `connect${ident.charAt(0).toUpperCase()}${ident.slice(1)}`
	const methodName = op.isRealtime ? realtimeName : ident

	const posArgs: string[] = ["self"]

	for (const pp of op.pathParams) {
		posArgs.push(`${pyParamName(pp)}: str`)
	}

	if (op.isRealtime) {
		const kwArgsRt: string[] = [
			`reconnect_token: str | None = None`,
			`last_event_id: str | None = None`,
			`headers: dict[str, str] | None = None`,
		]
		const posLineRt = posArgs.join(", ")
		/* realtime method is sync — returns ResumableConnection (async-iterable).
		 * matches TS: `sdk.connectRealtime()` returns object, not a Promise. */
		lines.push(`    def ${methodName}(${posLineRt},`)
		lines.push(`        *,`)
		for (let i = 0; i < kwArgsRt.length; i++) {
			const comma = i < kwArgsRt.length - 1 ? "," : ""
			lines.push(`        ${kwArgsRt[i]}${comma}`)
		}
		lines.push(`    ) -> ResumableConnection:`)
		return lines
	}

	if (op.bodyIsStream) {
		posArgs.push(`body: AsyncIterator[bytes] | bytes | bytearray`)
	} else if (op.bodySchema && op.bodyRequired) {
		posArgs.push(`body: ${bodyTypeName(op.bodySchema)}`)
	}

	const kwArgs: string[] = []

	if (!op.bodyIsStream && op.bodySchema && !op.bodyRequired) {
		kwArgs.push(`body: ${bodyTypeName(op.bodySchema)} | None = None`)
	}

	if (op.isSSE) {
		kwArgs.push(`last_event_id: str | None = None`)
	}

	if (op.isWS) {
		kwArgs.push(`protocols: list[str] | None = None`)
	}

	for (const qp of op.queryParams) {
		const pname = pyParamName(qp.name)
		const pyType = jsonSchemaToPy(qp.schema, 0)
		if (qp.required) {
			posArgs.push(`${pname}: ${pyType}`)
		} else {
			/* skip last-event-id as already handled above */
			if (op.isSSE && (qp.name === "last-event-id" || qp.name === "last_event_id")) continue
			kwArgs.push(`${pname}: ${pyType} | None = None`)
		}
	}

	/* SSE/WS use config-level timeout/headers, not per-call */
	if (!op.isSSE && !op.isWS) {
		if (op.isIdempotent) kwArgs.push(`idempotency_key: str | None = None`)
		kwArgs.push(`timeout: float | None = None`)
		kwArgs.push(`headers: dict[str, str] | None = None`)
		kwArgs.push(`cancel_token: "threading.Event | None" = None`)
	}

	let returnType: string
	if (op.isSSE) {
		returnType = "AsyncIterator[SSEEvent]"
	} else if (op.isWS) {
		returnType = "_TypedWebSocket"
	} else if (throwOnError) {
		returnType = op.successType
	} else {
		returnType = `SDKResult[${op.successType}]`
	}

	if (kwArgs.length === 0) {
		lines.push(`    ${defKw} ${methodName}(${posArgs.join(", ")}) -> ${returnType}:`)
	} else {
		const posLine = posArgs.join(", ")
		lines.push(`    ${defKw} ${methodName}(${posLine},`)
		lines.push(`        *,`)
		for (let i = 0; i < kwArgs.length; i++) {
			const comma = i < kwArgs.length - 1 ? "," : ""
			lines.push(`        ${kwArgs[i]}${comma}`)
		}
		lines.push(`    ) -> ${returnType}:`)
	}

	return lines
}

function buildMethodDocstring(op: OperationInfo): string[] {
	const lines: string[] = []
	const text = op.summary ?? op.description ?? ""
	if (!text && op.errorStatuses.length === 0) return lines

	if (op.errorStatuses.length === 0) {
		/* single-line docstring when no Raises section */
		lines.push(`        """${text}"""`)
		return lines
	}

	lines.push(`        """${text}`)
	lines.push(``)
	lines.push(`        Raises:`)
	for (const status of op.errorStatuses) {
		const name = ERROR_NAMES[status] ?? "APIStatusError"
		lines.push(`            ${name}: HTTP ${status}`)
	}
	lines.push(`        """`)
	return lines
}

function buildUrlLine(op: OperationInfo, isTopLevel: boolean): string {
	const configRef = isTopLevel ? "self._config" : "self._client._config"
	if (op.pathParams.length > 0) {
		const urlExpr = op.path.replace(/\{(\w+)\}/g, (_, p) => `{quote(${pyParamName(p)}, safe='')}`)
		return `        url = _build_url(${configRef}.base_url, f"${urlExpr}")`
	}
	return `        url = _build_url(${configRef}.base_url, "${op.path}")`
}

function buildResponseLines(throwOnError: boolean): string[] {
	if (throwOnError) {
		return [
			`        _raise_for_status(_response)`,
			`        return _parse_body(_response)`,
		]
	}
	return [
		`        _body = _parse_body(_response)`,
		`        if _response.status_code >= 400:`,
		`            return SDKResult(data=None, error=_body, status=_response.status_code, response=_response)`,
		`        return SDKResult(data=_body, error=None, status=_response.status_code, response=_response)`,
	]
}

/* Build path-params dict literal string used by mark_stale / interpolate_path:
 * { "id": id, "orgId": org_id } — keys are the OpenAPI placeholder names,
 * values are the python-safe local identifiers from the method signature. */
function buildPathParamsDict(op: OperationInfo): string {
	if (op.pathParams.length === 0) return "None"
	const entries = op.pathParams.map((p) => `"${p}": ${pyParamName(p)}`)
	return `{${entries.join(", ")}}`
}

function buildInvalidateListLiteral(op: OperationInfo): string {
	if (op.invalidate.length === 0) return "[]"
	return `[${op.invalidate.map((s) => `"${s}"`).join(", ")}]`
}

/* Emit Idempotency-Key injection block. Precedence:
 * explicit header (any casing) > idempotency_key kwarg > uuid.uuid4().
 * Runs after _headers is built so config.headers + per-call headers merge is visible. */
function buildIdempotencyLines(op: OperationInfo): string[] {
	if (!op.isIdempotent || op.isSSE || op.isWS || op.isRealtime) return []
	return [
		`        _idem_existing = None`,
		`        for _k in list(_headers.keys()):`,
		`            if _k.lower() == "idempotency-key":`,
		`                _idem_existing = _headers[_k]`,
		`                break`,
		`        if _idem_existing is None:`,
		`            _headers["Idempotency-Key"] = idempotency_key if idempotency_key is not None else str(uuid.uuid4())`,
	]
}

function buildAsyncMethodBody(op: OperationInfo, throwOnError: boolean, isTopLevel = false): string[] {
	const lines: string[] = []
	const configRef = isTopLevel ? "self._config" : "self._client._config"
	const asyncClientRef = isTopLevel ? "self._async_client" : "self._client._async_client"
	const trackerRef = isTopLevel ? "self._stale_tracker" : "self._client._stale_tracker"

	if (op.isRealtime) {
		lines.push(`        _transports = [WsAdapter(), SseAdapter(), LongpollAdapter()]`)
		lines.push(`        _opts = TransportOpts(`)
		lines.push(`            reconnect_token=reconnect_token,`)
		lines.push(`            last_event_id=last_event_id,`)
		lines.push(`            headers=headers,`)
		lines.push(`        )`)
		lines.push(`        _url = _build_url(${configRef}.base_url, "${op.path}")`)
		lines.push(`        return ResumableConnection(_url, _transports, _opts)`)
		return lines
	}

	lines.push(buildUrlLine(op, isTopLevel))

	if (op.isSSE) {
		lines.push(`        _headers = _build_headers(${configRef}, extra={"Accept": "text/event-stream"})`)
		lines.push(`        if last_event_id is not None: _headers["Last-Event-ID"] = last_event_id`)
	} else if (op.isWS) {
		lines.push(`        _headers = _build_headers(${configRef}, extra=None)`)
	} else if (op.bodyIsStream) {
		lines.push(`        _headers = _build_headers(${configRef}, extra={"Content-Type": "application/octet-stream", **(headers or {})})`)
	} else {
		lines.push(`        _headers = _build_headers(${configRef}, extra=headers)`)
	}
	lines.push(...buildIdempotencyLines(op))

	/* SSE skips last-event-id query param — sent as header instead */
	const qpNames = op.queryParams
		.filter((qp) => !(op.isSSE && (qp.name === "last-event-id" || qp.name === "last_event_id")))
		.map((qp) => `"${qp.name}": ${pyParamName(qp.name)}`)
	if (qpNames.length > 0) {
		lines.push(`        _params: dict[str, Any] = {${qpNames.join(", ")}}`)
	} else {
		lines.push(`        _params: dict[str, Any] = {}`)
	}

	if (op.isWS) {
		lines.push(`        ws_url = url.replace("https://", "wss://").replace("http://", "ws://")`)
		if (op.queryParams.some((qp) => qp.name === "reconnect_token")) {
			lines.push(`        if reconnect_token is not None:`)
			lines.push(`            _params["reconnect_token"] = reconnect_token`)
		}
		lines.push(`        if _params:`)
		lines.push(`            from urllib.parse import urlencode`)
		lines.push(`            ws_url = f"{ws_url}?{urlencode({k: v for k, v in _params.items() if v is not None})}"`)
		lines.push(`        return _TypedWebSocket(ws_url, protocols=protocols, extra_headers=_headers)`)
		return lines
	}

	if (op.isSSE) {
		lines.push(`        async with ${asyncClientRef}.stream(`)
		lines.push(`            "${op.method}", url, headers=_headers,`)
		lines.push(`            params={k: v for k, v in _params.items() if v is not None} or None,`)
		lines.push(`        ) as _response:`)
		lines.push(`            _raise_for_status(_response)`)
		lines.push(`            async for _event in parse_sse_stream(_response):`)
		lines.push(`                yield _event`)
		return lines
	}

	const pathParamsDict = buildPathParamsDict(op)
	const invalidateLiteral = buildInvalidateListLiteral(op)
	lines.push(`        _path_params: dict[str, str] | None = ${pathParamsDict}`)
	lines.push(`        _concrete_path = interpolate_path("${op.path}", _path_params)`)
	lines.push(`        _concrete_selector = "${op.method} " + _concrete_path`)
	lines.push(`        _request_meta = await ${trackerRef}.build_request_meta(`)
	lines.push(`            _concrete_selector, _concrete_path, "${op.method}",`)
	lines.push(`        )`)

	let bodyArg: string
	if (op.bodyIsStream) bodyArg = "json=None, content=body"
	else if (op.bodySchema) bodyArg = "json=body"
	else bodyArg = "json=None"
	lines.push(`        _response = await _do_request_async(`)
	lines.push(`            ${asyncClientRef}, ${configRef}, "${op.method}", url,`)
	lines.push(`            headers=_headers, ${bodyArg}, params=_params, timeout=timeout,`)
	lines.push(`            cancel_token=cancel_token, operation="${op.method} ${op.path}",`)
	lines.push(`            request_meta=_request_meta,`)
	lines.push(`        )`)
	lines.push(`        if _response.status_code < 400:`)
	lines.push(`            await ${trackerRef}.mark_stale(`)
	lines.push(`                ${invalidateLiteral}, _path_params, _concrete_selector,`)
	lines.push(`            )`)
	lines.push(`            if _request_meta is not None and _request_meta.is_stale:`)
	lines.push(`                await ${trackerRef}.clear_stale(`)
	lines.push(`                    _concrete_selector, _concrete_path, "${op.method}",`)
	lines.push(`                    _request_meta.seq_snapshot,`)
	lines.push(`                )`)
	lines.push(...buildResponseLines(throwOnError))

	return lines
}

function buildSyncMethodBody(op: OperationInfo, throwOnError: boolean, isTopLevel = false): string[] {
	const lines: string[] = []
	const configRef = isTopLevel ? "self._config" : "self._client._config"
	const syncClientRef = isTopLevel ? "self._sync_client" : "self._client._sync_client"
	const trackerRef = isTopLevel ? "self._stale_tracker" : "self._client._stale_tracker"

	lines.push(buildUrlLine(op, isTopLevel))
	lines.push(`        _headers = _build_headers(${configRef}, extra=headers)`)
	lines.push(...buildIdempotencyLines(op))

	const qpNames = op.queryParams.map((qp) => `"${qp.name}": ${pyParamName(qp.name)}`)
	if (qpNames.length > 0) {
		lines.push(`        _params: dict[str, Any] = {${qpNames.join(", ")}}`)
	} else {
		lines.push(`        _params: dict[str, Any] = {}`)
	}

	const pathParamsDict = buildPathParamsDict(op)
	const invalidateLiteral = buildInvalidateListLiteral(op)
	lines.push(`        _path_params: dict[str, str] | None = ${pathParamsDict}`)
	lines.push(`        _concrete_path = interpolate_path("${op.path}", _path_params)`)
	lines.push(`        _concrete_selector = "${op.method} " + _concrete_path`)
	lines.push(`        _request_meta = ${trackerRef}.build_request_meta(`)
	lines.push(`            _concrete_selector, _concrete_path, "${op.method}",`)
	lines.push(`        )`)

	const jsonArg = op.bodySchema ? "json=body" : "json=None"
	lines.push(`        _response = _do_request_sync(`)
	lines.push(`            ${syncClientRef}, ${configRef}, "${op.method}", url,`)
	lines.push(`            headers=_headers, ${jsonArg}, params=_params, timeout=timeout,`)
	lines.push(`            cancel_token=cancel_token, operation="${op.method} ${op.path}",`)
	lines.push(`            request_meta=_request_meta,`)
	lines.push(`        )`)
	lines.push(`        if _response.status_code < 400:`)
	lines.push(`            ${trackerRef}.mark_stale(`)
	lines.push(`                ${invalidateLiteral}, _path_params, _concrete_selector,`)
	lines.push(`            )`)
	lines.push(`            if _request_meta is not None and _request_meta.is_stale:`)
	lines.push(`                ${trackerRef}.clear_stale(`)
	lines.push(`                    _concrete_selector, _concrete_path, "${op.method}",`)
	lines.push(`                    _request_meta.seq_snapshot,`)
	lines.push(`                )`)
	lines.push(...buildResponseLines(throwOnError))

	return lines
}

/* ── buildPyTypes ── */

function buildPyTypes(spec: Record<string, unknown>): string {
	const schemas = (spec.components as Record<string, unknown> | undefined)?.schemas as
		Record<string, Record<string, unknown>> | undefined

	const body: string[] = []
	const allNames: string[] = []

	if (schemas) {
		for (const [name, schema] of Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) {
			allNames.push(name)
			const props = schema.properties as Record<string, Record<string, unknown>> | undefined
			const required = new Set((schema.required as string[] | undefined) ?? [])

			if (props && Object.keys(props).length > 0) {
				body.push(`class ${name}(TypedDict, total=False):`)
				for (const [key, val] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) {
					const pyType = jsonSchemaToPy(val, 0)
					if (required.has(key)) {
						body.push(`    ${key}: ${pyType}`)
					} else {
						body.push(`    ${key}: NotRequired[${pyType}]`)
					}
				}
				body.push("")
			} else if (schema.type === "string" && schema.format === "uuid") {
				body.push(`${name} = NewType("${name}", str)`)
				body.push("")
			} else {
				body.push(`${name} = NewType("${name}", Any)  # type: ignore[misc]`)
				body.push("")
			}
		}
	}

	const bodyText = body.join("\n")
	const typingImports = new Set<string>(["TypedDict", "Literal", "NotRequired", "NewType"])
	if (!bodyText.includes("NewType(")) typingImports.delete("NewType")
	if (!/\bAny\b/.test(bodyText)) typingImports.delete("Any")
	else typingImports.add("Any")
	if (!/\bLiteral\b/.test(bodyText)) typingImports.delete("Literal")
	if (!/\bNotRequired\b/.test(bodyText)) typingImports.delete("NotRequired")
	if (!/\bTypedDict\b/.test(bodyText)) typingImports.delete("TypedDict")

	const l: string[] = []
	l.push("# ruff: noqa: E501")
	l.push(PYTHON_FUTURE)
	l.push("")
	if (typingImports.size > 0) {
		const sorted = [...typingImports].sort()
		l.push(`from typing import ${sorted.join(", ")}`)
		l.push("")
	}
	if (bodyText.length > 0) {
		l.push(bodyText)
	}

	if (allNames.length === 0) {
		l.push("__all__: list[str] = []")
	} else {
		l.push(`__all__ = [${allNames.map((n) => `"${n}"`).join(", ")}]`)
	}
	return l.join("\n")
}

function buildPyClient(
	spec: Record<string, unknown>,
	options: PySDKOptions,
	serviceMap: Record<string, ServiceMapEntry>,
): string {
	const throwOnError = options.throwOnError !== false
	const { opsByOpId, topLevel, tree } = collectSDKMethods(spec)

	const schemas = (spec.components as Record<string, unknown> | undefined)?.schemas as
		Record<string, Record<string, unknown>> | undefined
	const schemaNames = schemas ? Object.keys(schemas) : []

	const body: string[] = []

	const invEntries = Object.entries(serviceMap)
		.filter(([, v]) => v.invalidate && v.invalidate.length > 0)

	body.push("_INVALIDATION_MAP: dict[str, dict[str, Any]] = {")
	for (const [opId, entry] of invEntries) {
		const invItems = (entry.invalidate ?? []).map((s) => `"${s}"`).join(", ")
		body.push(`    "${opId}": {`)
		body.push(`        "method": "${entry.method}",`)
		body.push(`        "path": "${entry.path}",`)
		body.push(`        "invalidate": [${invItems}],`)
		body.push(`    },`)
	}
	body.push("}")
	body.push("")

	/* emit async resource classes in post-order (children before parents) */
	function emitAsyncResourceClasses(ns: IRNamespace, path: string[]): void {
		/* recurse into sub-namespaces first (post-order so children declared before parents) */
		for (const [seg, childNs] of namespacesOf(ns)) {
			emitAsyncResourceClasses(childNs, [...path, seg])
		}

		if (path.length === 0) return

		const className = nestedClassName(path)
		const parentType = path.length === 1 ? '"AsyncSDK"' : nestedClassName(path.slice(0, -1))
		body.push(`class ${className}:`)
		body.push(`    def __init__(self, _client: ${parentType}) -> None:`)
		body.push(`        self._client = _client`)

		for (const [seg] of namespacesOf(ns)) {
			const childClass = nestedClassName([...path, seg])
			body.push(`        self.${pyIdent(seg)} = ${childClass}(self)`)
		}
		body.push("")

		for (const [, op] of methodsOf(ns)) {
			const opInfo = opsByOpId.get(op.id)
			if (!opInfo) continue
			body.push(...buildMethodSignature(opInfo, throwOnError, true))
			body.push(...buildMethodDocstring(opInfo))
			body.push(...buildAsyncMethodBody(opInfo, throwOnError))
			body.push("")
		}
		body.push("")
	}

	/* emit sync resource classes in post-order */
	function emitSyncResourceClasses(ns: IRNamespace, path: string[]): void {
		for (const [seg, childNs] of namespacesOf(ns)) {
			emitSyncResourceClasses(childNs, [...path, seg])
		}

		if (path.length === 0) return

		const syncMethods = methodsOf(ns).filter(([, op]) => {
			const opInfo = opsByOpId.get(op.id)
			return opInfo && !opInfo.isSSE && !opInfo.isWS && !opInfo.isRealtime && !opInfo.bodyIsStream
		})
		/* check if any sub-namespace has sync methods */
		const hasAnySyncContent = syncMethods.length > 0 || namespacesOf(ns).length > 0
		if (!hasAnySyncContent) return

		const className = nestedClassName(path)
		const syncClassName = `_Sync${className.slice(1)}`
		const parentType = path.length === 1 ? '"SDK"' : `_Sync${nestedClassName(path.slice(0, -1)).slice(1)}`
		body.push(`class ${syncClassName}:`)
		body.push(`    def __init__(self, _client: ${parentType}) -> None:`)
		body.push(`        self._client = _client`)

		for (const [seg, childNs] of namespacesOf(ns)) {
			const childClass = `_Sync${nestedClassName([...path, seg]).slice(1)}`
			const childSyncMethods = methodsOf(childNs).filter(([, op]) => {
				const opInfo = opsByOpId.get(op.id)
				return opInfo && !opInfo.isSSE && !opInfo.isWS && !opInfo.isRealtime && !opInfo.bodyIsStream
			})
			if (childSyncMethods.length > 0 || namespacesOf(childNs).length > 0) {
				body.push(`        self.${pyIdent(seg)} = ${childClass}(self)`)
			}
		}
		body.push("")

		for (const [, op] of syncMethods) {
			const opInfo = opsByOpId.get(op.id)
			if (!opInfo) continue
			body.push(...buildMethodSignature(opInfo, throwOnError, false))
			body.push(...buildMethodDocstring(opInfo))
			body.push(...buildSyncMethodBody(opInfo, throwOnError))
			body.push("")
		}
		body.push("")
	}

	emitAsyncResourceClasses(tree, [])
	emitSyncResourceClasses(tree, [])

	body.push("class SDK:")
	body.push("    def __init__(self, config: ClientConfig) -> None:")
	body.push("        self._config = config")
	body.push("        self._sync_client = httpx.Client(")
	body.push("            transport=config.sync_transport,")
	body.push("        )")
	body.push("        _inv = config.invalidation")
	body.push("        self._stale_tracker = _StaleTrackerSync(")
	body.push("            stale_time=_inv.stale_time if _inv is not None else 0.0,")
	body.push("            stale_max_entries=(")
	body.push("                _inv.stale_max_entries if _inv is not None else 1000")
	body.push("            ),")
	body.push("            max_sources_per_target=(")
	body.push("                _inv.max_sources_per_target if _inv is not None else 16")
	body.push("            ),")
	body.push("        )")
	for (const [seg] of namespacesOf(tree)) {
		const className = `_Sync${nestedClassName([seg]).slice(1)}`
		body.push(`        self.${pyIdent(seg)} = ${className}(self)`)
	}
	body.push("")
	body.push("    def is_stale(self, method: str, path: str) -> bool:")
	body.push("        \"\"\"Returns True when (method, path) sits inside an active stale window.\"\"\"")
	body.push("        return self._stale_tracker.is_stale(method, path)")
	body.push("")

	const syncTopLevel = topLevel.filter((op) => !op.isSSE && !op.isWS && !op.isRealtime && !op.bodyIsStream)
	for (const op of syncTopLevel.sort((a, b) => a.operationId.localeCompare(b.operationId))) {
		body.push(...buildMethodSignature(op, throwOnError, false))
		body.push(...buildMethodDocstring(op))
		const bodyLines = buildSyncMethodBody(op, throwOnError, true)
		body.push(...bodyLines)
		body.push("")
	}

	body.push("")

	body.push("class AsyncSDK:")
	body.push("    def __init__(self, config: ClientConfig) -> None:")
	body.push("        self._config = config")
	body.push("        self._async_client = httpx.AsyncClient(")
	body.push("            transport=config.transport,")
	body.push("        )")
	body.push("        _inv = config.invalidation")
	body.push("        self._stale_tracker = _StaleTracker(")
	body.push("            stale_time=_inv.stale_time if _inv is not None else 0.0,")
	body.push("            stale_max_entries=(")
	body.push("                _inv.stale_max_entries if _inv is not None else 1000")
	body.push("            ),")
	body.push("            max_sources_per_target=(")
	body.push("                _inv.max_sources_per_target if _inv is not None else 16")
	body.push("            ),")
	body.push("        )")
	for (const [seg] of namespacesOf(tree)) {
		const className = nestedClassName([seg])
		body.push(`        self.${pyIdent(seg)} = ${className}(self)`)
	}
	body.push("")
	body.push("    async def is_stale(self, method: str, path: str) -> bool:")
	body.push("        \"\"\"Returns True when (method, path) sits inside an active stale window.\"\"\"")
	body.push("        return await self._stale_tracker.is_stale(method, path)")
	body.push("")

	for (const op of topLevel.sort((a, b) => a.operationId.localeCompare(b.operationId))) {
		body.push(...buildMethodSignature(op, throwOnError, true))
		body.push(...buildMethodDocstring(op))
		const bodyLines = buildAsyncMethodBody(op, throwOnError, true)
		body.push(...bodyLines)
		body.push("")
	}

	const bodyText = body.join("\n")
	const imports: string[] = []
	if (/\basyncio\b/.test(bodyText)) imports.push("import asyncio")
	if (/\bthreading\b/.test(bodyText)) imports.push("import threading")
	if (/\buuid\.uuid4\b/.test(bodyText)) imports.push("import uuid")
	imports.push("import httpx")
	if (/\bquote\b/.test(bodyText)) imports.push("from urllib.parse import quote")

	const typingUsed: string[] = []
	if (/\bAny\b/.test(bodyText)) typingUsed.push("Any")
	if (/\bAsyncIterator\b/.test(bodyText)) typingUsed.push("AsyncIterator")
	if (/\bLiteral\b/.test(bodyText)) typingUsed.push("Literal")
	if (/\bNotRequired\b/.test(bodyText)) typingUsed.push("NotRequired")
	if (/\bTypedDict\b/.test(bodyText)) typingUsed.push("TypedDict")
	if (typingUsed.length > 0) imports.push(`from typing import ${typingUsed.join(", ")}`)

	const runtimeUsed: string[] = []
	for (const sym of ["ClientConfig", "InvalidationConfig", "SDKResult", "_build_headers", "_build_url", "_do_request_async", "_do_request_sync", "_parse_body", "_raise_for_status"]) {
		if (new RegExp(`\\b${sym}\\b`).test(bodyText)) runtimeUsed.push(sym)
	}
	if (runtimeUsed.length > 0) {
		const line = `from ._runtime import ${runtimeUsed.join(", ")}`
		if (line.length <= 88) {
			imports.push(line)
		} else {
			imports.push("from ._runtime import (")
			for (const sym of runtimeUsed) imports.push(`    ${sym},`)
			imports.push(")")
		}
	}

	const invalidationUsed: string[] = []
	for (const sym of ["_StaleTracker", "_StaleTrackerSync", "interpolate_path"]) {
		if (new RegExp(`\\b${sym}\\b`).test(bodyText)) invalidationUsed.push(sym)
	}
	if (invalidationUsed.length > 0) {
		imports.push(`from ._invalidation import ${invalidationUsed.join(", ")}`)
	}

	/* APIStatusError only appears in docstring Raises sections, never as a code symbol */
	const errorsUsed: string[] = []
	for (const sym of ["APIError", "_STATUS_ERROR_MAP"]) {
		if (new RegExp(`\\b${sym}\\b`).test(bodyText)) errorsUsed.push(sym)
	}
	if (errorsUsed.length > 0) {
		imports.push(`from ._errors import ${errorsUsed.join(", ")}`)
	}

	const sseUsed: string[] = []
	for (const sym of ["SSEEvent", "parse_sse_stream"]) {
		if (new RegExp(`\\b${sym}\\b`).test(bodyText)) sseUsed.push(sym)
	}
	if (sseUsed.length > 0) {
		imports.push(`from ._sse import ${sseUsed.join(", ")}`)
	}

	if (/\b_TypedWebSocket\b/.test(bodyText)) {
		imports.push("from ._ws import _TypedWebSocket")
	}

	const transportUsed: string[] = []
	for (const sym of ["LongpollAdapter", "SseAdapter", "TransportOpts", "WsAdapter"]) {
		if (new RegExp(`\\b${sym}\\b`).test(bodyText)) transportUsed.push(sym)
	}
	if (transportUsed.length > 0) {
		imports.push(`from ._transport import ${transportUsed.join(", ")}`)
	}

	if (/\bResumableConnection\b/.test(bodyText)) {
		imports.push("from ._realtime import ResumableConnection")
	}

	const usedSchemas = schemaNames.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyText))
	if (usedSchemas.length > 0) {
		const typesLine = `from .types import ${usedSchemas.join(", ")}`
		if (typesLine.length <= 88) {
			imports.push(typesLine)
		} else {
			imports.push("from .types import (")
			for (const name of usedSchemas) imports.push(`    ${name},`)
			imports.push(")")
		}
	}

	const out: string[] = []
	out.push("# ruff: noqa: E501")
	out.push(PYTHON_FUTURE)
	out.push("")
	out.push(...imports)
	out.push("")
	out.push(bodyText)
	return out.join("\n")
}

function buildPyInit(spec: Record<string, unknown>): string {
	const errorClasses = [
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

	const transportExports = [
		"LongpollAdapter",
		"SseAdapter",
		"TransportAdapter",
		"TransportConn",
		"TransportKind",
		"TransportOpts",
		"WsAdapter",
	]

	const realtimeExports = ["ConnectionState", "ResumableConnection"]

	const l: string[] = []
	l.push(PYTHON_FUTURE)
	l.push("")
	l.push("from .client import AsyncSDK, SDK")
	l.push("from ._errors import (")
	for (const name of errorClasses) {
		l.push(`    ${name},`)
	}
	l.push(")")
	l.push("from ._transport import (")
	for (const name of transportExports) {
		l.push(`    ${name},`)
	}
	l.push(")")
	l.push("from ._realtime import (")
	for (const name of realtimeExports) {
		l.push(`    ${name},`)
	}
	l.push(")")

	const schemas = (spec.components as Record<string, unknown> | undefined)?.schemas as
		Record<string, Record<string, unknown>> | undefined
	const schemaNames = schemas ? Object.keys(schemas).sort() : []
	if (schemaNames.length > 0) {
		l.push("from .types import (")
		for (const name of schemaNames) {
			l.push(`    ${name},`)
		}
		l.push(")")
	}

	l.push("")
	const allExports = ["AsyncSDK", "SDK", ...errorClasses, ...transportExports, ...realtimeExports, ...schemaNames]
	l.push("__all__ = [")
	for (const name of allExports) {
		l.push(`    "${name}",`)
	}
	l.push("]")

	return l.join("\n")
}

function buildServiceMap(spec: Record<string, unknown>): Record<string, ServiceMapEntry> {
	const ops = collectOperations(spec)
	const result: Record<string, ServiceMapEntry> = {}
	for (const op of ops) {
		result[op.operationId] = {
			invalidate: op.invalidate.length > 0 ? op.invalidate : undefined,
			method: op.method,
			operationId: op.operationId,
			path: op.path,
		}
	}
	return result
}

export function generatePythonSDK(
	spec: Record<string, unknown>,
	options: PySDKOptions = {},
): PySDKResult {
	const templates = loadPythonRuntimeTemplates()
	const serviceMap = buildServiceMap(spec)

	const files: Record<string, string> = {}

	for (const [name, content] of templates) {
		files[name] = content
	}

	files["types.py"] = buildPyTypes(spec)
	files["client.py"] = buildPyClient(spec, options, serviceMap)
	files["__init__.py"] = buildPyInit(spec)

	return { files, serviceMap }
}
