import { HoneyError } from "./error.ts"
import { parseCookieHeader } from "./cookie.ts"
import { dict } from "./dict.ts"
import { bodyParserFor, type BodyParser } from "./media-type.ts"
import type {
	FieldError,
	InputSchemaEntry,
	InputSchemasDef,
	NormalizedIssue,
	StandardSchemaIssue,
	StandardSchemaLike,
} from "./types.ts"
import { EK, SK } from "./types.ts"

type ValidatedInput = {
	cookies?: unknown
	form?: unknown
	headers?: unknown
	json?: unknown
	params?: unknown
	search?: unknown
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"])

const CODE_MAP: Record<string, string> = {
	invalid_format: "field_invalid_format",
	invalid_value: "field_invalid_enum",
	not_multiple: "field_not_multiple_of",
	required: "field_required",
	too_big: "field_too_big",
	too_long: "field_too_long",
	too_short: "field_too_short",
	too_small: "field_too_small",
	unrecognized: "field_unrecognized_keys",
}

export function mapNormalizedCode(code: string): string {
	return CODE_MAP[code] ?? "field_invalid"
}

/** `bodyParserFor` with both form encodings folded into `"form"`. */
export function selectParser(contentType: string | null): "form" | "json" | null {
	const parser = bodyParserFor(contentType)
	return parser === null ? null : parser === "json" ? "json" : "form"
}

/**
 * Throws when a route for `method` declares a `json` or `form` schema it can never receive:
 * GET and HEAD requests cannot carry a body (Fetch forbids one). Every other method, DELETE and
 * OPTIONS included, has its declared body validated on every request.
 */
export function assertBodySchemaAllowed(iv: InputSchemasDef | null, method: string, path: string): void {
	if (iv === null || (iv.json === undefined && iv.form === undefined)) return
	if (method !== "GET" && method !== "HEAD") return
	const kind = iv.json !== undefined ? "json" : "form"
	throw new Error(
		`${method} ${path} declares a ${kind} body schema, but ${method} requests have no body. ` +
			`Validate query data with \`search\`, or register the route for a method that carries a body.`,
	)
}

/* Content-Type vs declared json/form — no body read. Applies to every method: a declared body
 * is required, so a GET reaching an `all()` route with a body schema is a 415 too. */
export function assertRequestContentType(iv: InputSchemasDef, req: Request): void {
	if (iv.json || iv.form) {
		const parser = bodyParserFor(req.headers.get("content-type"))
		const ok = (iv.json && parser === "json") || (iv.form && (parser === "multipart" || parser === "urlencoded"))
		if (!ok) {
			throw new HoneyError({
				errorKey: EK.unsupported_media_type,
				status: SK.unsupported_media_type,
			})
		}
	}
}

/** Cookie parsing lives with the serializer so the two round-trip; see `cookie.ts`. */
export const parseCookies: (header: string) => Record<string, string> = parseCookieHeader

function toPropertyKey(segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey {
	if (typeof segment === "object" && segment !== null && "key" in segment) {
		return segment.key
	}
	return segment
}

type VendorIssue = StandardSchemaIssue & { code?: string; type?: string }

function extractVendorCode(issue: StandardSchemaIssue, vendor: string): string {
	const vi = issue as VendorIssue
	if (vendor === "zod" || vendor === "arktype") {
		return typeof vi.code === "string" ? vi.code : "unknown"
	}
	if (vendor === "valibot") {
		return typeof vi.type === "string" ? vi.type : "unknown"
	}
	return "unknown"
}

export function normalizeIssues(issues: ReadonlyArray<StandardSchemaIssue>, vendor: string): NormalizedIssue[] {
	return issues.map((issue) => {
		const path = issue.path ? issue.path.map(toPropertyKey) : []
		return {
			code: extractVendorCode(issue, vendor),
			message: issue.message,
			meta: {
				field: path.at(-1)?.toString(),
			},
			path,
		}
	})
}

export function issuesToFieldErrors(issues: NormalizedIssue[], prefix: string): Record<string, FieldError[]> {
	/* field names come from the request (record keys): `toString` must not find a prototype method */
	const fields = dict<FieldError[]>()
	for (const issue of issues) {
		const fieldName = issue.path.at(-1)?.toString() ?? "unknown"
		const fullPath = `${prefix}.${issue.path.map(String).join(".")}`
		const error: FieldError = {
			error_key: mapNormalizedCode(issue.code),
			message: issue.message,
			path: fullPath,
		}
		if (fields[fieldName] === undefined) {
			fields[fieldName] = []
		}
		fields[fieldName].push(error)
	}
	return fields
}

function failValidation(schema: StandardSchemaLike, issues: ReadonlyArray<StandardSchemaIssue>, prefix: string): never {
	const normalized = normalizeIssues(issues, schema["~standard"].vendor)
	throw new HoneyError({
		errorKey: EK.validation_failed,
		fields: issuesToFieldErrors(normalized, prefix),
		status: SK.bad_request,
	})
}

type StandardResult = { issues?: ReadonlyArray<StandardSchemaIssue>; value?: unknown }

/* Most validators answer synchronously; only a schema that returns a promise costs an await. */
function runSchema(schema: StandardSchemaLike, data: unknown, prefix: string): unknown {
	const result = schema["~standard"].validate(data) as StandardResult | Promise<StandardResult>
	if (result instanceof Promise) {
		return result.then((r) => (r.issues ? failValidation(schema, r.issues, prefix) : r.value))
	}
	return result.issues ? failValidation(schema, result.issues, prefix) : result.value
}

/*
 * Duplicate keys in search and form data. One policy for both:
 *
 * - A property the schema types as an array always gets an array, even for a single value
 *   (`?tag=a` → `["a"]`, one uploaded file → `[File]`).
 * - A property the schema types as a scalar gets the FIRST value, like `ctx.search` and
 *   cookies (`role=user&role=admin` → `"user"`), so every layer that reads the key agrees.
 * - Anything else (a union of scalar and array, an untyped or unknown key, or a schema that
 *   cannot describe itself) gets a scalar for one value and an array for repeated values.
 *
 * Shapes come from the schema's Standard JSON Schema (`~standard.jsonSchema`, zod ≥ 4.2 and
 * arktype); validators without it (valibot, yup, effect) get the last rule for every key.
 * Cookies are always first-wins (RFC 6265 sends the most specific cookie first); headers are
 * joined with `, ` as Fetch does.
 */
type KeyShape = "array" | "natural" | "scalar"
type Shape = Map<string, KeyShape>

const shapeCache = new WeakMap<object, Shape | null>()

type JsonSchemaNode = {
	$ref?: string
	allOf?: JsonSchemaNode[]
	anyOf?: JsonSchemaNode[]
	oneOf?: JsonSchemaNode[]
	properties?: Record<string, JsonSchemaNode>
	type?: string | string[]
	$defs?: Record<string, JsonSchemaNode>
	definitions?: Record<string, JsonSchemaNode>
}

function deref(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
	const ref = node.$ref
	if (typeof ref !== "string") return node
	const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
	if (m === null) return node
	const defs = m[1] === "$defs" ? root.$defs : root.definitions
	const target = defs !== undefined && Object.hasOwn(defs, m[2]!) ? defs[m[2]!] : undefined
	return target ?? node
}

function classify(node: JsonSchemaNode, root: JsonSchemaNode, depth = 0): KeyShape {
	if (depth > 8) return "natural"
	const n = deref(node, root)
	const t = n.type
	if (typeof t === "string") return t === "array" ? "array" : "scalar"
	if (Array.isArray(t)) {
		const nonNull = t.filter((x) => x !== "null")
		if (nonNull.length === 0) return "natural"
		if (nonNull.every((x) => x === "array")) return "array"
		return nonNull.includes("array") ? "natural" : "scalar"
	}
	const branches = n.anyOf ?? n.oneOf
	if (branches !== undefined && branches.length > 0) {
		const kinds = branches.filter((b) => deref(b, root).type !== "null").map((b) => classify(b, root, depth + 1))
		if (kinds.length === 0) return "natural"
		if (kinds.every((k) => k === "array")) return "array"
		if (kinds.every((k) => k === "scalar")) return "scalar"
		return "natural"
	}
	if (n.allOf !== undefined && n.allOf.length > 0) {
		const kinds = n.allOf.map((b) => classify(b, root, depth + 1))
		if (kinds.includes("array")) return "array"
		if (kinds.includes("scalar")) return "scalar"
	}
	return "natural"
}

function collectProperties(node: JsonSchemaNode, root: JsonSchemaNode, out: Shape, depth = 0): void {
	if (depth > 8) return
	const n = deref(node, root)
	if (n.properties !== undefined) {
		for (const key of Object.keys(n.properties)) {
			if (!out.has(key)) out.set(key, classify(n.properties[key]!, root))
		}
	}
	for (const part of n.allOf ?? []) collectProperties(part, root, out, depth + 1)
}

type StandardJsonSchemaLike = {
	input?: (opts: { libraryOptions?: Record<string, unknown>; target: string }) => unknown
}

function shapeOf(schema: StandardSchemaLike): Shape | null {
	const cached = shapeCache.get(schema)
	if (cached !== undefined) return cached
	let shape: Shape | null = null
	const js = (schema["~standard"] as { jsonSchema?: StandardJsonSchemaLike }).jsonSchema
	if (js !== undefined && typeof js.input === "function") {
		try {
			const root = js.input({ libraryOptions: { unrepresentable: "any" }, target: "draft-2020-12" }) as JsonSchemaNode
			if (root !== null && typeof root === "object") {
				shape = new Map()
				collectProperties(root, root, shape)
			}
		} catch {
			/* a schema that cannot describe itself falls back to the natural shape */
			shape = null
		}
	}
	shapeCache.set(schema, shape)
	return shape
}

/** Applies the duplicate-key policy to `key → values` collected in request order. */
function shapeRecord<T>(all: Map<string, T[]>, shape: Shape | null): Record<string, T | T[]> {
	const out = dict<T | T[]>()
	for (const [key, values] of all) {
		const kind = shape?.get(key) ?? "natural"
		out[key] = kind === "array" ? values : kind === "scalar" || values.length === 1 ? values[0]! : values
	}
	return out
}

function collect<T>(entries: Iterable<[string, T]>, skipDangerous: boolean): Map<string, T[]> {
	const all = new Map<string, T[]>()
	for (const [key, value] of entries) {
		if (skipDangerous && DANGEROUS_KEYS.has(key)) continue
		const list = all.get(key)
		if (list === undefined) all.set(key, [value])
		else list.push(value)
	}
	return all
}

function searchEntries(req: Request, searchAll: Record<string, string[]> | undefined): Iterable<[string, string]> {
	if (searchAll === undefined) return new URL(req.url).searchParams
	const entries: [string, string][] = []
	for (const key of Object.keys(searchAll)) {
		for (const value of searchAll[key]!) entries.push([key, value])
	}
	return entries
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result = dict<string>()
	headers.forEach((value, key) => {
		result[key] = value
	})
	return result
}

type ResolvedSchema = {
	mode: "readableStream" | "standard"
	schema: StandardSchemaLike
}

function resolveSchema(entry: InputSchemaEntry): ResolvedSchema {
	if ("_tag" in entry) {
		return {
			mode: "readableStream",
			schema: entry.schema as StandardSchemaLike,
		}
	}
	return { mode: "standard", schema: entry }
}

/* A body the declared parser cannot read is the client's fault: 400 `malformed_body`, never a
 * 500 through `onError`. Errors from reading the stream itself (a `bodyLimit` 413, a client
 * abort) are not parse errors and pass through unchanged. */
function malformedBody(format: BodyParser, cause: unknown): HoneyError {
	return new HoneyError({ cause, errorKey: EK.malformed_body, status: SK.bad_request, vars: { format } })
}

async function readJson(req: Request): Promise<unknown> {
	const text = await req.text()
	try {
		return JSON.parse(text) as unknown
	} catch (err) {
		throw malformedBody("json", err)
	}
}

async function readForm(req: Request, parser: "multipart" | "urlencoded"): Promise<Iterable<[string, unknown]>> {
	if (parser === "urlencoded") return new URLSearchParams(await req.text())
	const bytes = await req.arrayBuffer()
	try {
		const contentType = req.headers.get("content-type") ?? ""
		return (await new Response(bytes, { headers: { "content-type": contentType } }).formData()) as unknown as Iterable<
			[string, unknown]
		>
	} catch (err) {
		throw malformedBody("multipart", err)
	}
}

/** What validation reads from the request context when it has one; `ctx.searchAll` is cached. */
type ValidationSource = { readonly searchAll?: Record<string, string[]> }

export async function validateInput(
	schemas: InputSchemasDef,
	req: Request,
	params: Record<string, string>,
	source?: ValidationSource,
): Promise<ValidatedInput> {
	const result: ValidatedInput = {}

	/* params */
	if (schemas.params) {
		const { mode, schema } = resolveSchema(schemas.params)
		result.params = mode === "readableStream" ? params : await runSchema(schema, params, "params")
	}

	/* search */
	if (schemas.search) {
		const { mode, schema } = resolveSchema(schemas.search)
		const all = collect(searchEntries(req, source?.searchAll), false)
		const parsed = shapeRecord(all, mode === "readableStream" ? null : shapeOf(schema))
		result.search = mode === "readableStream" ? parsed : await runSchema(schema, parsed, "search")
	}

	/* headers */
	if (schemas.headers) {
		const { mode, schema } = resolveSchema(schemas.headers)
		const headerRecord = headersToRecord(req.headers)
		result.headers = mode === "readableStream" ? headerRecord : await runSchema(schema, headerRecord, "headers")
	}

	/* cookies */
	if (schemas.cookies) {
		const { mode, schema } = resolveSchema(schemas.cookies)
		const cookieHeader = req.headers.get("cookie") ?? ""
		const parsed = parseCookies(cookieHeader)
		result.cookies = mode === "readableStream" ? parsed : await runSchema(schema, parsed, "cookies")
	}

	/* body: json or form, for every method that reaches here (GET/HEAD body schemas are
	 * rejected at registration) */
	if (schemas.json || schemas.form) {
		assertRequestContentType(schemas, req)
		const parser = bodyParserFor(req.headers.get("content-type"))

		if (schemas.json && parser === "json") {
			const { mode, schema } = resolveSchema(schemas.json)
			if (mode !== "readableStream") {
				result.json = await runSchema(schema, await readJson(req), "json")
			}
			/* readableStream: body untouched — the handler reads ctx.req.body directly */
		} else if (schemas.form && (parser === "multipart" || parser === "urlencoded")) {
			const { mode, schema } = resolveSchema(schemas.form)
			if (mode !== "readableStream") {
				const record = shapeRecord(collect(await readForm(req, parser), true), shapeOf(schema))
				result.form = await runSchema(schema, record, "form")
			}
		}
	}

	return result
}

export async function validateOutput(schema: StandardSchemaLike, statusKey: string, data: unknown): Promise<void> {
	const result = await schema["~standard"].validate(data)
	if (result.issues) {
		throw new HoneyError({
			errorKey: EK.output_validation_failed,
			status: SK.internal_server_error,
			vars: { statusKey },
		})
	}
}
