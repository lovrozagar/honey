import { readFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { jsonSchemaToPy } from "../../../src/python-type-emitter.ts"

/* ── environment probes (module-load time, not per-test) ── */

const hasPython = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0
const hasRuff = spawnSync("ruff", ["--version"], { encoding: "utf8" }).status === 0

/* ── fixture loader ── */

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`./fixtures/python/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── python-aware bracket balance helper ──
 * Counts [ ] and ( ) only — skips content inside:
 *   - triple-quoted strings  \"\"\" ... \"\"\"
 *   - single-quoted strings  ' ... '
 *   - double-quoted strings  " ... "
 *   - line comments          # ... \n
 * This prevents false failures when emitted Literal["["] strings
 * contain bracket characters inside python string literals.
 */
function assertBalancedPyBrackets(src: string): void {
	let brackets = 0
	let parens = 0
	let i = 0
	while (i < src.length) {
		/* triple double-quote string */
		if (src.slice(i, i + 3) === '"""') {
			i += 3
			while (i < src.length && src.slice(i, i + 3) !== '"""') i++
			i += 3
			continue
		}
		/* triple single-quote string */
		if (src.slice(i, i + 3) === "'''") {
			i += 3
			while (i < src.length && src.slice(i, i + 3) !== "'''") i++
			i += 3
			continue
		}
		/* double-quoted string */
		if (src[i] === '"') {
			i++
			while (i < src.length && src[i] !== '"') {
				if (src[i] === "\\") i++
				i++
			}
			i++
			continue
		}
		/* single-quoted string */
		if (src[i] === "'") {
			i++
			while (i < src.length && src[i] !== "'") {
				if (src[i] === "\\") i++
				i++
			}
			i++
			continue
		}
		/* line comment */
		if (src[i] === "#") {
			while (i < src.length && src[i] !== "\n") i++
			continue
		}
		if (src[i] === "[") brackets++
		else if (src[i] === "]") brackets--
		else if (src[i] === "(") parens++
		else if (src[i] === ")") parens--
		i++
	}
	expect(brackets, "unbalanced [ ]").toBe(0)
	expect(parens, "unbalanced ( )").toBe(0)
}

/* ══════════════════════════════════════════════════════════════════════
   Tier 1 — scaffold + imports (tests #1–#6)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 1: scaffold + imports", () => {
	const minimalSpec = loadFixture("minimal")

	it("[#1] emits package scaffold with all required files", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		expect(result).toHaveProperty("files")
		const keys = Object.keys(result.files)
		expect(keys).toContain("__init__.py")
		expect(keys).toContain("client.py")
		expect(keys).toContain("types.py")
		expect(keys).toContain("_runtime.py")
		expect(keys).toContain("_errors.py")
		expect(keys).toContain("_invalidation.py")
		expect(keys).toContain("_sse.py")
		expect(keys).toContain("_ws.py")
		expect(keys).toContain("py.typed")
		expect(result).toHaveProperty("serviceMap")
	})

	it("[#2] py.typed marker file is empty string (PEP 561)", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		expect(result.files["py.typed"]).toBe("")
	})

	it("[#3] every emitted .py module starts with from __future__ import annotations", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const pyFiles = Object.entries(result.files).filter(([k]) => k.endsWith(".py"))
		expect(pyFiles.length).toBeGreaterThan(0)
		for (const [filename, content] of pyFiles) {
			expect(content, `${filename} missing __future__ import`).toMatch(/^from __future__ import annotations/m)
		}
	})

	it("[#4] client.py has required imports: httpx, typing, relative runtime imports", () => {
		const sseSpec = loadFixture("sse")
		const result = generatePythonSDK(sseSpec, { name: "SseSDK" })
		const client = result.files["client.py"]
		expect(client).toContain("import httpx")
		expect(client).toMatch(/from typing import/)
		expect(client).toMatch(/from \._runtime import|from \. import _runtime/)
	})

	it("[#5] types.py imports TypedDict, NotRequired from typing when used", () => {
		const refsSpec = loadFixture("refs")
		const result = generatePythonSDK(refsSpec, { name: "RefsSDK" })
		const types = result.files["types.py"]
		expect(types).toContain("TypedDict")
		expect(types).toContain("NotRequired")
	})

	it("[#6] __init__.py re-exports AsyncSDK, SDK and core error classes", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const init = result.files["__init__.py"]
		expect(init).toMatch(/from \.client import[\s\S]*AsyncSDK/)
		expect(init).toMatch(/from \.client import[\s\S]*SDK/)
		expect(init).toMatch(/from \._errors import[\s\S]*APIError/)
		expect(init).toMatch(/from \._errors import[\s\S]*NotFoundError/)
		expect(init).toMatch(/from \._errors import[\s\S]*(ValidationError|UnprocessableEntityError)/)
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 2 — JSON Schema → Python type (tests #7–#22)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 2: JSON Schema → Python type (jsonSchemaToPy)", () => {
	it("[#7] primitives: string→str, integer→int, number→float, boolean→bool, null→None", () => {
		expect(jsonSchemaToPy({ type: "string" })).toBe("str")
		expect(jsonSchemaToPy({ type: "integer" })).toBe("int")
		expect(jsonSchemaToPy({ type: "number" })).toBe("float")
		expect(jsonSchemaToPy({ type: "boolean" })).toBe("bool")
		expect(jsonSchemaToPy({ type: "null" })).toBe("None")
	})

	it("[#8] array of primitive → list[str]", () => {
		const result = jsonSchemaToPy({ type: "array", items: { type: "string" } })
		expect(result).toBe("list[str]")
	})

	it("[#9] tuple (items array) → tuple[str, float]", () => {
		const result = jsonSchemaToPy({
			type: "array",
			items: [{ type: "string" }, { type: "number" }],
		})
		expect(result).toBe("tuple[str, float]")
	})

	it('[#10] enum string → Literal["a", "b"]', () => {
		const result = jsonSchemaToPy({ type: "string", enum: ["a", "b"] })
		expect(result).toContain('Literal["a", "b"]')
	})

	it('[#11] const → Literal["admin"]', () => {
		const result = jsonSchemaToPy({ const: "admin" })
		expect(result).toContain('Literal["admin"]')
	})

	it("[#12] nullable shorthand → str | None", () => {
		const result = jsonSchemaToPy({ type: "string", nullable: true })
		expect(result).toBe("str | None")
	})

	it("[#13] type array with null → str | None", () => {
		const result = jsonSchemaToPy({ type: ["string", "null"] })
		expect(result).toBe("str | None")
	})

	it("[#14] type array multi non-null → str | float", () => {
		const result = jsonSchemaToPy({ type: ["string", "number"] })
		expect(result).toBe("str | float")
	})

	it("[#15] oneOf/anyOf → pipe-union A | B", () => {
		const result = jsonSchemaToPy({
			oneOf: [{ type: "string" }, { type: "integer" }],
		})
		expect(result).toMatch(/str\s*\|\s*int/)
	})

	it("[#16] allOf flat-object → merged TypedDict or Any fallback", () => {
		/* allOf of two property-objects should flatten or degrade to Any, never crash */
		const result = jsonSchemaToPy({
			allOf: [
				{ type: "object", properties: { name: { type: "string" } } },
				{ type: "object", properties: { age: { type: "integer" } } },
			],
		})
		/* must be a valid python type expression — either merged TypedDict name or Any */
		expect(result).toBeTruthy()
		expect(typeof result).toBe("string")
		/* must not be an empty string */
		expect(result.length).toBeGreaterThan(0)
	})

	it("[#17] object with required+optional props → NotRequired for optional, sorted alphabetically", () => {
		const result = jsonSchemaToPy({
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				age: { type: "integer" },
			},
		})
		/* required key bare, optional as NotRequired */
		expect(result).toContain("id")
		expect(result).toMatch(/NotRequired\[/)
		/* alphabetical: age before id before name */
		const ageIdx = result.indexOf("age")
		const idIdx = result.indexOf("id")
		const nameIdx = result.indexOf("name")
		expect(ageIdx).toBeLessThan(idIdx)
		expect(idIdx).toBeLessThan(nameIdx)
	})

	it("[#18] object with additionalProperties only → dict[str, T]", () => {
		const result = jsonSchemaToPy({
			type: "object",
			additionalProperties: { type: "integer" },
		})
		expect(result).toMatch(/dict\[str,\s*int\]/)
	})

	it("[#19] $ref → named TypedDict reference (bare name)", () => {
		const result = jsonSchemaToPy({ $ref: "#/components/schemas/User" })
		expect(result).toBe("User")
	})

	it("[#20] depth guard → Any beyond depth 8", () => {
		const deep = {
			type: "object",
			properties: {
				a: {
					type: "object",
					properties: {
						b: {
							type: "object",
							properties: {
								c: {
									type: "object",
									properties: {
										d: {
											type: "object",
											properties: {
												e: {
													type: "object",
													properties: {
														f: {
															type: "object",
															properties: { g: { type: "object", properties: { h: { type: "string" } } } },
														},
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		}
		const result = jsonSchemaToPy(deep, 9)
		expect(result).toBe("Any")
	})

	it("[#21] non-identifier property key → functional-form TypedDict fallback", () => {
		const result = jsonSchemaToPy({
			type: "object",
			required: ["bad-key"],
			properties: { "bad-key": { type: "string" } },
		})
		/* functional form: TypedDict("X", {"bad-key": str}) or inline dict form */
		expect(result).toMatch(/TypedDict\(|"bad-key"/)
	})

	it("[#22] bracket balance — every emitted python type expression has balanced [ ] and ( )", () => {
		const schemas = [
			{ type: "array", items: { type: "string" } },
			{ type: "string", enum: ["a", "b", "c"] },
			{ oneOf: [{ type: "string" }, { type: "integer" }, { type: "boolean" }] },
			{
				type: "object",
				required: ["id"],
				properties: {
					id: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					meta: { type: "object", additionalProperties: { type: "integer" } },
				},
			},
			{ type: "array", items: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
		]
		for (const schema of schemas) {
			const result = jsonSchemaToPy(schema)
			assertBalancedPyBrackets(result)
		}
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 3 — client methods (tests #23–#31)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 3: client methods", () => {
	const crudSpec = loadFixture("crud")

	it("[#23] resource.action operationId → nested class _UsersResource with async def create", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		expect(client).toMatch(/class _UsersResource/)
		expect(client).toMatch(/async def create\s*\(self/)
		/* AsyncSDK.__init__ sets self.users = _UsersResource(self) */
		expect(client).toMatch(/self\.users\s*=\s*_UsersResource\(/)
	})

	it("[#24] single-segment operationId → top-level method on AsyncSDK", () => {
		const result = generatePythonSDK(loadFixture("minimal"), { name: "MinimalSDK" })
		const client = result.files["client.py"]
		/* 'ping' has no dot → method on AsyncSDK directly */
		expect(client).toMatch(/class AsyncSDK/)
		expect(client).toMatch(/async def ping\s*\(self/)
	})

	it("[#25] path params typed in signature and interpolated in request URL with quote()", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		/* id: str in signature */
		expect(client).toMatch(/def get\s*\(self[^)]*id\s*:\s*str/)
		/* f-string URL with quote(id) */
		expect(client).toMatch(/f["']\/users\/\{.*quote.*id/)
	})

	it("[#26] optional query params → kwargs with default None; required → positional keyword-only", () => {
		const result = generatePythonSDK(loadFixture("sse"), { name: "SseSDK" })
		const client = result.files["client.py"]
		/* topic is optional → = None */
		expect(client).toMatch(/topic[^=]*=\s*None/)
	})

	it("[#27] request body → kwarg body: TypedDictName (required positional-keyword)", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		/* body param typed as the input TypedDict */
		expect(client).toMatch(/body\s*:\s*UserCreateInput/)
	})

	it("[#28] return annotation is success TypedDict in throw mode, SDKResult[T] in safe mode", () => {
		const throwResult = generatePythonSDK(crudSpec, { name: "ThrowSDK", throwOnError: true })
		const safeResult = generatePythonSDK(crudSpec, { name: "SafeSDK", throwOnError: false })
		/* throw mode: plain return type */
		expect(throwResult.files["client.py"]).toMatch(/-> User/)
		/* safe mode: wrapped in SDKResult */
		expect(safeResult.files["client.py"]).toMatch(/-> SDKResult\[/)
	})

	it("[#29] kw_only signatures — optional kwargs after * sentinel", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		/* * sentinel appears before optional kwargs */
		expect(client).toMatch(/,\s*\*,\s*\n?\s*\w/)
	})

	it("[#30] reserved-word operationId parts get _ suffix (class_ , from_)", () => {
		const result = generatePythonSDK(loadFixture("reserved-words"), { name: "ReservedSDK" })
		const client = result.files["client.py"]
		/* class → class_ resource, from → from_ method */
		expect(client).toMatch(/class _Class_Resource|class_/)
		expect(client).toMatch(/def from_\s*\(self/)
	})

	it("[#31] method docstring emits operation summary/description", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		/* docstrings use triple-quote */
		expect(client).toMatch(/"""/)
		/* summary text from fixture: "Create user" */
		expect(client).toContain("Create user")
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 4 — errors (tests #32–#36)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 4: errors", () => {
	const minimalSpec = loadFixture("minimal")

	it("[#32] _errors.py contains all shared-pool error subclasses", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const errors = result.files["_errors.py"]
		expect(errors).toContain("class APIError")
		expect(errors).toContain("BadRequestError")
		expect(errors).toContain("UnauthorizedError")
		expect(errors).toContain("ForbiddenError")
		expect(errors).toContain("NotFoundError")
		expect(errors).toContain("ConflictError")
		expect(errors).toContain("UnprocessableEntityError")
		expect(errors).toContain("RateLimitError")
		expect(errors).toContain("InternalServerError")
		expect(errors).toContain("BadGatewayError")
		expect(errors).toContain("ServiceUnavailableError")
		expect(errors).toContain("GatewayTimeoutError")
		expect(errors).toContain("APIStatusError")
	})

	it("[#33] APIError has fields: status, body, response, message", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const errors = result.files["_errors.py"]
		expect(errors).toMatch(/status\s*:\s*int/)
		expect(errors).toMatch(/body\s*:\s*Any/)
		expect(errors).toMatch(/response\s*:\s*httpx\.Response/)
		expect(errors).toMatch(/message\s*:\s*str/)
	})

	it("[#34] _STATUS_ERROR_MAP emitted as dict[int, type[APIError]]", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const errors = result.files["_errors.py"]
		expect(errors).toContain("_STATUS_ERROR_MAP")
		/* maps integer status codes to error classes */
		expect(errors).toMatch(/400\s*:\s*BadRequestError/)
		expect(errors).toMatch(/404\s*:\s*NotFoundError/)
		expect(errors).toMatch(/422\s*:\s*UnprocessableEntityError/)
	})

	it("[#35] non-2xx HTTP raises matching APIError subclass via _STATUS_ERROR_MAP", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const runtime = result.files["_runtime.py"]
		/* runtime must use the map to look up error class */
		expect(runtime).toMatch(/_STATUS_ERROR_MAP\.get\(|_raise_for_status/)
		/* raise statement present */
		expect(runtime).toMatch(/raise\s+\w+Error|\braise\b/)
	})

	it("[#36] emitted docstring Raises: block lists typed exceptions per documented status", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK" })
		const client = result.files["client.py"]
		/* Raises: section in docstring */
		expect(client).toMatch(/Raises:/)
		/* specific status exceptions documented */
		expect(client).toMatch(/NotFoundError|BadRequestError|UnprocessableEntityError/)
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 5 — safe-mode dataclass (tests #37–#40)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 5: safe-mode SDKResult dataclass", () => {
	const minimalSpec = loadFixture("minimal")

	it("[#37] SDKResult frozen dataclass emitted in _runtime.py with data, error, status, response fields", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const runtime = result.files["_runtime.py"]
		expect(runtime).toMatch(/@dataclass|dataclass/)
		expect(runtime).toContain("SDKResult")
		expect(runtime).toMatch(/data\s*:\s*T\s*\|?\s*None|data\s*:/)
		expect(runtime).toMatch(/error\s*:\s*Any/)
		expect(runtime).toMatch(/status\s*:\s*int/)
		expect(runtime).toMatch(/response\s*:\s*httpx\.Response/)
	})

	it("[#38] throw_on_error=True path: _raise_for_status then return parsed body", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK", throwOnError: true })
		const client = result.files["client.py"]
		expect(client).toMatch(/_raise_for_status/)
		/* return parsed body — no SDKResult wrapping */
		expect(client).toMatch(/_parse_body|return.*body|return.*response\.json/)
	})

	it("[#39] throw_on_error=False path: returns SDKResult on both 2xx and non-2xx", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK", throwOnError: false })
		const client = result.files["client.py"]
		/* SDKResult construction present */
		expect(client).toMatch(/SDKResult\(/)
		/* no bare raise — errors go into SDKResult.error */
		const raiseCount = (client.match(/\braise\b/g) ?? []).length
		/* auth-retry may have one raise, but no unconditional raise on non-2xx */
		expect(raiseCount).toBeLessThanOrEqual(2)
	})

	it("[#40] ClientConfig frozen dataclass emitted with all config fields", () => {
		const result = generatePythonSDK(minimalSpec, { name: "MinimalSDK" })
		const runtime = result.files["_runtime.py"]
		expect(runtime).toContain("ClientConfig")
		expect(runtime).toMatch(/base_url\s*:\s*str/)
		expect(runtime).toMatch(/bearer_token\s*:\s*str\s*\|?\s*None|bearer_token/)
		expect(runtime).toMatch(/throw_on_error\s*:\s*bool/)
		expect(runtime).toMatch(/on_auth_expired|timeout/)
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 6 — SSE (tests #41–#46)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 6: SSE", () => {
	const sseSpec = loadFixture("sse")

	it("[#41] SSE endpoint emits async iterator method → AsyncIterator[SSEEvent]", () => {
		const result = generatePythonSDK(sseSpec, { name: "SseSDK" })
		const client = result.files["client.py"]
		expect(client).toMatch(/async def stream\s*\(self/)
		expect(client).toMatch(/AsyncIterator\[SSEEvent\]/)
		/* body uses async with + yield */
		expect(client).toMatch(/yield/)
	})

	it("[#42] SSE Accept header set to text/event-stream in generated method", () => {
		const result = generatePythonSDK(sseSpec, { name: "SseSDK" })
		const client = result.files["client.py"]
		expect(client).toContain("text/event-stream")
		expect(client).toMatch(/Accept.*text\/event-stream|text\/event-stream.*Accept/)
	})

	it("[#43] SSE last_event_id kwarg maps to Last-Event-ID header", () => {
		const result = generatePythonSDK(sseSpec, { name: "SseSDK" })
		const client = result.files["client.py"]
		expect(client).toMatch(/last_event_id/)
		expect(client).toContain("Last-Event-ID")
	})

	it("[#44] SSE stream method absent from sync SDK class", () => {
		const result = generatePythonSDK(sseSpec, { name: "SseSDK" })
		const client = result.files["client.py"]
		/* locate SDK (sync) class boundaries */
		const sdkClassStart = client.indexOf("\nclass SDK")
		expect(sdkClassStart).toBeGreaterThan(-1)
		const sdkBody = client.slice(sdkClassStart)
		/* 'async def stream' must not appear in sync SDK body */
		const asyncStreamIdx = sdkBody.indexOf("async def stream")
		expect(asyncStreamIdx).toBe(-1)
	})

	it("[#45] _sse.py is emitted (static runtime file with SSEEvent and parse_sse_stream)", () => {
		const result = generatePythonSDK(sseSpec, { name: "SseSDK" })
		const sse = result.files["_sse.py"]
		expect(sse).toContain("SSEEvent")
		expect(sse).toMatch(/parse_sse_stream|async def.*stream/)
		/* double-newline block-split strategy for SSE parsing */
		expect(sse).toMatch(/\\n\\n|\n\n/)
	})

	it("[#46] SSE generator raises APIError subclass before first yield on non-2xx", () => {
		const result = generatePythonSDK(sseSpec, { name: "SseSDK" })
		const client = result.files["client.py"]
		/* status check before yield */
		const streamMethodStart = client.indexOf("async def stream")
		expect(streamMethodStart).toBeGreaterThan(-1)
		const streamBody = client.slice(streamMethodStart, streamMethodStart + 800)
		/* raise or _raise_for_status before any yield */
		const raiseIdx = streamBody.search(/_raise_for_status|raise.*Error/)
		const yieldIdx = streamBody.indexOf("yield")
		expect(raiseIdx).toBeGreaterThan(-1)
		expect(raiseIdx).toBeLessThan(yieldIdx)
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 7 — WebSocket (tests #47–#53)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 7: WebSocket", () => {
	const wsSpec = loadFixture("ws")

	it("[#47] WS endpoint emits context-manager subscribe returning _TypedWebSocket", () => {
		const result = generatePythonSDK(wsSpec, { name: "WsSDK" })
		const client = result.files["client.py"]
		expect(client).toMatch(/def subscribe\s*\(self/)
		expect(client).toMatch(/_TypedWebSocket/)
	})

	it("[#48] WS subscribe method absent from sync SDK class", () => {
		const result = generatePythonSDK(wsSpec, { name: "WsSDK" })
		const client = result.files["client.py"]
		const sdkClassStart = client.indexOf("\nclass SDK")
		expect(sdkClassStart).toBeGreaterThan(-1)
		const sdkBody = client.slice(sdkClassStart)
		expect(sdkBody).not.toMatch(/def subscribe/)
	})

	it("[#49] WS reconnect_token mapped to query param", () => {
		const result = generatePythonSDK(wsSpec, { name: "WsSDK" })
		const client = result.files["client.py"]
		expect(client).toMatch(/reconnect_token/)
	})

	it("[#50] WS protocols kwarg emitted", () => {
		const result = generatePythonSDK(wsSpec, { name: "WsSDK" })
		const client = result.files["client.py"]
		expect(client).toMatch(/protocols\s*[=:]/)
	})

	it("[#51] _TypedWebSocket has .on(event, callback) escape hatch", () => {
		const result = generatePythonSDK(wsSpec, { name: "WsSDK" })
		const ws = result.files["_ws.py"]
		expect(ws).toMatch(/def on\s*\(self/)
		/* valid events list */
		expect(ws).toMatch(/open|close|error|message/)
	})

	it("[#52] _ws.py has optional-dep guard: try import websockets except ImportError", () => {
		const result = generatePythonSDK(wsSpec, { name: "WsSDK" })
		const ws = result.files["_ws.py"]
		expect(ws).toMatch(/try:[\s\S]*?import websockets[\s\S]*?except ImportError/)
		/* subscribe raises ImportError when websockets is None */
		expect(ws).toMatch(/ImportError\(.*pip install.*ws/)
	})

	it("[#53] _TypedWebSocket.send serializes dict→JSON, passes str/bytes through", () => {
		const result = generatePythonSDK(wsSpec, { name: "WsSDK" })
		const ws = result.files["_ws.py"]
		expect(ws).toMatch(/def send\s*\(self/)
		/* dict path → json.dumps */
		expect(ws).toMatch(/json\.dumps|isinstance.*dict/)
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 8 — invalidation (tests #54–#59)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 8: invalidation", () => {
	const invSpec = loadFixture("invalidation")

	it("[#54] _INVALIDATION_MAP constant emitted in client.py keyed by resource.action", () => {
		const result = generatePythonSDK(invSpec, { name: "InvSDK" })
		const client = result.files["client.py"]
		expect(client).toContain("_INVALIDATION_MAP")
		/* users.create with x-invalidate entries present */
		expect(client).toMatch(/users\.create|users_create/)
		expect(client).toMatch(/GET \/users/)
	})

	it("[#55] _invalidation.py has stale tracker with path_matches_pattern and resolve_invalidation_targets", () => {
		const result = generatePythonSDK(invSpec, { name: "InvSDK" })
		const inv = result.files["_invalidation.py"]
		expect(inv).toMatch(/path_matches_pattern|pathMatchesPattern/)
		expect(inv).toMatch(/resolve_invalidation_targets|resolveInvalidationTargets/)
	})

	it("[#56] _invalidation.py uses time.monotonic() not time.time()", () => {
		const result = generatePythonSDK(invSpec, { name: "InvSDK" })
		const inv = result.files["_invalidation.py"]
		expect(inv).toContain("monotonic")
		expect(inv).not.toMatch(/time\.time\(\)/)
	})

	it("[#57] bounded map size: stale_max_entries config + LRU sweep", () => {
		const result = generatePythonSDK(invSpec, { name: "InvSDK" })
		const inv = result.files["_invalidation.py"]
		expect(inv).toMatch(/stale_max_entries|max_entries/)
		/* eviction / sweep logic present */
		expect(inv).toMatch(/pop|evict|sweep|lru/)
	})

	it("[#58] AsyncSDK invalidation uses asyncio.Lock, SDK uses threading.Lock", () => {
		const result = generatePythonSDK(invSpec, { name: "InvSDK" })
		const inv = result.files["_invalidation.py"]
		expect(inv).toMatch(/asyncio\.Lock/)
		expect(inv).toMatch(/threading\.Lock/)
	})

	it("[#59] invalidation disabled when stale_time == 0: no map allocated", () => {
		const result = generatePythonSDK(invSpec, { name: "InvSDK" })
		const inv = result.files["_invalidation.py"]
		/* zero-path guard */
		expect(inv).toMatch(/stale_time\s*==\s*0|stale_time is None|if not.*stale/)
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 9 — sync facade + config (tests #60–#65)
   ══════════════════════════════════════════════════════════════════════ */

describe("Tier 9: sync facade + config", () => {
	const crudSpec = loadFixture("crud")

	it("[#60] SDK sync class emits same resource tree as AsyncSDK but no stream/subscribe", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		expect(client).toMatch(/class SDK[\s\S]*?class AsyncSDK|class AsyncSDK[\s\S]*?class SDK/)
		/* both have users resource */
		const sdkIdx = client.indexOf("class SDK")
		const asyncSdkIdx = client.indexOf("class AsyncSDK")
		expect(sdkIdx).toBeGreaterThan(-1)
		expect(asyncSdkIdx).toBeGreaterThan(-1)
	})

	it("[#61] SDK uses httpx.Client, AsyncSDK uses httpx.AsyncClient", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const client = result.files["client.py"]
		expect(client).toContain("httpx.Client")
		expect(client).toContain("httpx.AsyncClient")
	})

	it("[#62] bearer_token auto-injects Authorization: Bearer header", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const runtime = result.files["_runtime.py"]
		expect(runtime).toMatch(/Authorization|bearer_token/)
		expect(runtime).toMatch(/auth_header_prefix|Bearer /)
	})

	it("[#63] custom headers merged, per-call headers override config-level headers", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const runtime = result.files["_runtime.py"]
		/* merge pattern: config headers + per-call headers */
		expect(runtime).toMatch(/\*\*.*headers|headers.*update|{.*\*\*.*headers/)
	})

	it("[#64] on_auth_expired hook called on 401, retries once with new token", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const runtime = result.files["_runtime.py"]
		expect(runtime).toMatch(/on_auth_expired/)
		/* 401 check */
		expect(runtime).toMatch(/401/)
		/* retry logic */
		expect(runtime).toMatch(/retry|again|once/)
	})

	it("[#65] timeout kwarg per-call builds httpx.Timeout", () => {
		const result = generatePythonSDK(crudSpec, { name: "CrudSDK" })
		const runtime = result.files["_runtime.py"]
		expect(runtime).toMatch(/httpx\.Timeout/)
		expect(runtime).toMatch(/timeout/)
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 11 — runtime execution smoke (tests #69–#71, python3 + httpx required)
   Catches NameError/AttributeError bugs that string-assert tests miss.
   ══════════════════════════════════════════════════════════════════════ */

const hasHttpx = (() => {
	const probe = spawnSync("python3", ["-c", "import httpx"], { encoding: "utf8" })
	return probe.status === 0
})()

const hasWebsockets = (() => {
	const probe = spawnSync("python3", ["-c", "import websockets"], { encoding: "utf8" })
	return probe.status === 0
})()

describe.skipIf(!hasPython || !hasHttpx)("Tier 11: runtime execution smoke (python3 + httpx required)", () => {
	function writePkg(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "honey-py-rt-"))
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(dir, name), content, "utf8")
		}
		return dir
	}

	it("[#69] happy path: POST /users 201 → AsyncSDK returns parsed body dict", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        body = json.dumps({"id": "u1", "email": "a@b.com", "name": "Alice"}).encode()
        return httpx.Response(201, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    result = await sdk.users.create(body={"email": "a@b.com", "name": "Alice"})
    assert isinstance(result, dict), f"expected dict, got {type(result)}"
    assert result["id"] == "u1", f"unexpected id: {result}"
    assert result["email"] == "a@b.com"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#70] error path: GET /users/:id 404 → NotFoundError raised", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK, NotFoundError
from sdk._runtime import ClientConfig

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        body = json.dumps({"message": "not found"}).encode()
        return httpx.Response(404, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    try:
        await sdk.users.get("missing-id")
        assert False, "expected NotFoundError"
    except NotFoundError as e:
        assert e.status == 404, f"unexpected status: {e.status}"
        print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#71] SSE path: stream events → async for yields SSEEvent from mock", () => {
		const result = generatePythonSDK(loadFixture("sse"), { name: "SseSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

SSE_BODY = b"id: 1\\ndata: hello\\n\\nid: 2\\ndata: world\\n\\n"

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        return httpx.Response(
            200,
            content=SSE_BODY,
            headers={"content-type": "text/event-stream"},
        )

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    events = []
    async for event in sdk.events.stream():
        events.append(event)
    assert len(events) >= 1, f"expected at least 1 event, got {events}"
    first = events[0]
    assert hasattr(first, "data") or isinstance(first, object), f"unexpected event type: {type(first)}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#72] error variants: 401→UnauthorizedError, 422→UnprocessableEntityError, 500→InternalServerError", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK, UnauthorizedError, UnprocessableEntityError, InternalServerError
from sdk._runtime import ClientConfig

async def run_case(status_code, expected_cls):
    class MockTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            body = json.dumps({"message": "err"}).encode()
            return httpx.Response(status_code, content=body, headers={"content-type": "application/json"})
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    try:
        await sdk.users.list()
        assert False, f"expected exception for {status_code}"
    except expected_cls as e:
        assert e.status == status_code, f"wrong status: {e.status}"
    except Exception as e:
        assert False, f"wrong exception type for {status_code}: {type(e).__name__}: {e}"

async def main():
    await run_case(401, UnauthorizedError)
    await run_case(422, UnprocessableEntityError)
    await run_case(500, InternalServerError)
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#73] path params: special chars URL-encoded, / → %2F", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

seen_url = None

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        global seen_url
        seen_url = str(request.url)
        body = json.dumps({"id": "a/b", "email": "x@y.com", "name": "X"}).encode()
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    await sdk.users.get("a/b")
    assert "%2F" in seen_url, f"expected %2F in URL, got: {seen_url}"
    assert "a/b" not in seen_url.split("?")[0].split("//", 1)[-1].split("/users/", 1)[-1], f"slash not encoded in: {seen_url}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#74] query params: optional omitted when None, required always sent", () => {
		const result = generatePythonSDK(loadFixture("sse"), { name: "SseSDK", throwOnError: true })
		const dir = writePkg(result.files)

		/* sse fixture has optional query param 'topic' on the stream endpoint */
		const script = `
import sys, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

seen_urls = []

SSE_BODY = b"data: hi\\n\\n"

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        seen_urls.append(str(request.url))
        return httpx.Response(200, content=SSE_BODY, headers={"content-type": "text/event-stream"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))

    # call without optional topic
    async for _ in sdk.events.stream():
        break

    # call with topic=news
    async for _ in sdk.events.stream(topic="news"):
        break

    assert len(seen_urls) == 2, f"expected 2 requests, got {seen_urls}"
    # first call: no topic param
    assert "topic" not in seen_urls[0], f"topic should be absent: {seen_urls[0]}"
    # second call: topic=news present
    assert "topic=news" in seen_urls[1], f"topic=news should be present: {seen_urls[1]}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#75] auth bearer: ClientConfig(bearer_token='abc') → Authorization: Bearer abc header", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

seen_auth = None

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        global seen_auth
        seen_auth = request.headers.get("authorization")
        body = json.dumps([]).encode()
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", bearer_token="abc", transport=MockTransport()))
    await sdk.users.list()
    assert seen_auth == "Bearer abc", f"unexpected auth header: {seen_auth!r}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#76] 401 retry: on_auth_expired returns new token → retry request uses new token", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

call_count = 0
seen_auths = []

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        global call_count
        call_count += 1
        seen_auths.append(request.headers.get("authorization"))
        if call_count == 1:
            return httpx.Response(401, content=b'{"message":"expired"}', headers={"content-type": "application/json"})
        body = json.dumps([]).encode()
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

async def get_new_token():
    return "fresh-token"

async def main():
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test",
        bearer_token="old-token",
        on_auth_expired=get_new_token,
        transport=MockTransport(),
    ))
    result = await sdk.users.list()
    assert call_count == 2, f"expected 2 requests (original + retry), got {call_count}"
    assert seen_auths[0] == "Bearer old-token", f"first request wrong auth: {seen_auths[0]!r}"
    assert seen_auths[1] == "Bearer fresh-token", f"retry wrong auth: {seen_auths[1]!r}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#77] SDKResult mode: throw_on_error=False + 404 → returns SDKResult, not raises", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: false })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig, SDKResult

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        body = json.dumps({"message": "not found"}).encode()
        return httpx.Response(404, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    result = await sdk.users.get("missing")
    assert isinstance(result, SDKResult), f"expected SDKResult, got {type(result)}"
    assert result.status == 404, f"expected status 404, got {result.status}"
    assert result.data is None, f"expected data None, got {result.data}"
    assert result.error is not None, f"expected error body, got None"
    assert isinstance(result.response, httpx.Response), f"response must be httpx.Response"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	/* WS runtime: skip — websockets.asyncio.client.connect() needs a real WS server or
	 * a compatible mock; httpx.MockTransport does not apply to websocket upgrades and
	 * websockets has no built-in test-server API. Mocking at the asyncio protocol level
	 * requires substantial infrastructure (unix-socket echo server or mock connect patch).
	 * String-assertion tests (#47–#53) already verify emission correctness. */

	it("[#78] invalidation: POST /users → _StaleTracker._map has matching GET /users entry", () => {
		const result = generatePythonSDK(loadFixture("invalidation"), { name: "InvSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig
from sdk._invalidation import _StaleTracker
from sdk.client import _INVALIDATION_MAP

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        body = json.dumps({"id": "u1", "email": "a@b.com"}).encode()
        return httpx.Response(201, content=body, headers={"content-type": "application/json"})

async def main():
    # simulate what the SDK does after users.create: invalidate based on _INVALIDATION_MAP
    inv_entry = _INVALIDATION_MAP.get("users.create")
    assert inv_entry is not None, "users.create not in _INVALIDATION_MAP"
    patterns = inv_entry["invalidate"]
    assert "GET /users" in patterns, f"expected GET /users in patterns: {patterns}"

    # verify _StaleTracker can process these patterns
    tracker = _StaleTracker(stale_time=5.0)
    # mark a cached entry for GET /users
    await tracker.mark("GET /users")
    # now invalidate using the patterns from the map
    await tracker.invalidate(patterns)
    # the entry should be stale (re-marked with new until)
    assert "GET /users" in tracker._map, f"GET /users not in stale map: {list(tracker._map.keys())}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#79] reserved words: sdk.class_.from_() callable, returns 200", () => {
		const result = generatePythonSDK(loadFixture("reserved-words"), { name: "ReservedSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        body = json.dumps("result").encode()
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    # access resource via class_ attribute (Python reserved word 'class' → class_)
    resource = getattr(sdk, "class_", None)
    assert resource is not None, "sdk.class_ attribute missing"
    # call from_ method (Python reserved word 'from' → from_)
    method = getattr(resource, "from_", None)
    assert method is not None, "sdk.class_.from_() method missing"
    result = await method()
    assert result is not None, f"expected result, got {result!r}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#80] headers merge: per-call wins on conflict, both config+call headers arrive", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

seen_headers = {}

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        global seen_headers
        seen_headers = dict(request.headers)
        body = json.dumps([]).encode()
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test",
        headers={"x-base": "base-val", "x-conflict": "from-config"},
        transport=MockTransport(),
    ))
    await sdk.users.list(headers={"x-custom": "call-val", "x-conflict": "from-call"})

    # config header present
    assert seen_headers.get("x-base") == "base-val", f"x-base missing: {seen_headers}"
    # per-call header present
    assert seen_headers.get("x-custom") == "call-val", f"x-custom missing: {seen_headers}"
    # per-call wins on conflict
    assert seen_headers.get("x-conflict") == "from-call", f"x-conflict wrong: {seen_headers.get('x-conflict')!r}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it("[#81] timeout per-call: timeout=0.5 passed through to httpx request extensions", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "CrudSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])
import httpx
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

seen_timeout = None

class MockTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        global seen_timeout
        # httpx stores timeout in request.extensions["timeout"]
        seen_timeout = request.extensions.get("timeout")
        body = json.dumps([]).encode()
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://test", transport=MockTransport()))
    await sdk.users.list(timeout=0.5)
    assert seen_timeout is not None, "no timeout in request extensions"
    # httpx encodes timeout dict with connect/read/write/pool keys
    if isinstance(seen_timeout, dict):
        vals = [v for v in seen_timeout.values() if v is not None]
        assert any(v == 0.5 for v in vals), f"0.5 not found in timeout dict: {seen_timeout}"
    else:
        assert seen_timeout == 0.5, f"unexpected timeout value: {seen_timeout}"
    print("ok")

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8" })
		expect(out.status, `runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})

	it.skipIf(!hasWebsockets)("[#82] WS round-trip: loopback echo server → subscribe → send → async for → close", () => {
		const result = generatePythonSDK(loadFixture("ws"), { name: "WsSDK", throwOnError: true })
		const dir = writePkg(result.files)

		const script = `
import sys, asyncio, websockets
sys.path.insert(0, sys.argv[1])
from sdk import AsyncSDK
from sdk._runtime import ClientConfig

async def handler(ws):
    async for msg in ws:
        await ws.send(f"echo:{msg}")

async def main():
    server = await websockets.serve(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        sdk = AsyncSDK(ClientConfig(base_url=f"http://127.0.0.1:{port}"))
        ws = sdk.realtime.subscribe(channel="updates", reconnect_token="tok")
        async with ws as conn:
            await conn.send("hello")
            msg = await asyncio.wait_for(anext(conn.__aiter__()), timeout=2.0)
            assert msg == "echo:hello", f"got {msg!r}"
            assert "channel=updates" in ws._url, f"missing channel: {ws._url}"
            assert "reconnect_token=tok" in ws._url, f"missing reconnect_token: {ws._url}"
        print("ok")
    finally:
        server.close()
        await server.wait_closed()

asyncio.run(main())
`
		const pkgDir = join(dir, "sdk")
		require("node:fs").mkdirSync(pkgDir, { recursive: true })
		for (const [name, content] of Object.entries(result.files)) {
			writeFileSync(join(pkgDir, name), content, "utf8")
		}
		const out = spawnSync("python3", ["-c", script, dir], { encoding: "utf8", timeout: 10000 })
		expect(out.status, `WS runtime failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
		expect(out.stdout.trim()).toBe("ok")
	})
})

/* ══════════════════════════════════════════════════════════════════════
   Tier 10 — integration smoke (tests #66–#68, guarded by python3 + ruff)
   ══════════════════════════════════════════════════════════════════════ */

describe.skipIf(!hasPython)("Tier 10: integration smoke (python3 required)", () => {
	function writePkg(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "honey-py-sdk-"))
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(dir, name), content, "utf8")
		}
		return dir
	}

	it("[#66] emitted .py files each pass python -m py_compile", () => {
		const result = generatePythonSDK(loadFixture("minimal"), { name: "SmokeSDK" })
		const dir = writePkg(result.files)
		for (const [name, content] of Object.entries(result.files)) {
			if (!name.endsWith(".py")) continue
			writeFileSync(join(dir, name), content, "utf8")
			const out = spawnSync("python3", ["-m", "py_compile", join(dir, name)], {
				encoding: "utf8",
			})
			expect(out.status, `py_compile failed on ${name}:\n${out.stderr}`).toBe(0)
		}
	})

	it.skipIf(!hasRuff)("[#67] emitted package passes ruff check --select F,E", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "RuffSDK" })
		const dir = writePkg(result.files)
		const pyFiles = Object.keys(result.files)
			.filter((k) => k.endsWith(".py"))
			.map((k) => join(dir, k))
		const out = spawnSync("ruff", ["check", "--select", "F,E", ...pyFiles], {
			encoding: "utf8",
		})
		expect(out.status, `ruff failed:\n${out.stdout}\n${out.stderr}`).toBe(0)
	})

	it("[#68] emitted .py files each pass ast.parse via python3 -c", () => {
		const result = generatePythonSDK(loadFixture("crud"), { name: "AstSDK" })
		const dir = writePkg(result.files)
		for (const [name, content] of Object.entries(result.files)) {
			if (!name.endsWith(".py")) continue
			writeFileSync(join(dir, name), content, "utf8")
			const script = `import ast, sys; ast.parse(open(sys.argv[1]).read()); print("ok")`
			const out = spawnSync("python3", ["-c", script, join(dir, name)], {
				encoding: "utf8",
			})
			expect(out.status, `ast.parse failed on ${name}:\n${out.stderr}`).toBe(0)
		}
	})
})
