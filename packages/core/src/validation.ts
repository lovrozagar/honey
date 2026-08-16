import { HoneyError } from "./error.ts"
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

export function selectParser(contentType: string | null): "form" | "json" | null {
	if (contentType === null) return null
	if (contentType.startsWith("application/json")) return "json"
	if (contentType.startsWith("multipart/form-data")) return "form"
	if (contentType.startsWith("application/x-www-form-urlencoded")) return "form"
	return null
}

/* Content-Type vs declared json/form — no body read */
export function assertRequestContentType(iv: InputSchemasDef, req: Request): void {
	const hasBody = req.method !== "DELETE" && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"
	if (hasBody && (iv.json || iv.form)) {
		const parser = selectParser(req.headers.get("content-type"))
		const ok = (iv.json && parser === "json") || (iv.form && parser === "form")
		if (!ok) {
			throw new HoneyError({
				errorKey: EK.unsupported_media_type,
				status: SK.unsupported_media_type,
			})
		}
	}
}

function tryDecodeCookieValue(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

export function parseCookies(header: string): Record<string, string> {
	const result: Record<string, string> = {}
	if (header.length === 0) return result
	for (const pair of header.split(";")) {
		const trimmed = pair.trim()
		const eqIdx = trimmed.indexOf("=")
		if (eqIdx === -1) continue
		const name = trimmed.slice(0, eqIdx)
		if (DANGEROUS_KEYS.has(name)) continue
		let value = trimmed.slice(eqIdx + 1)
		if (value.indexOf("%") !== -1) value = tryDecodeCookieValue(value)
		/* RFC 6265: strip surrounding double quotes */
		if (value.length >= 2 && value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34) {
			value = value.slice(1, -1)
		}
		result[name] = value
	}
	return result
}

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
	const fields: Record<string, FieldError[]> = {}
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

async function runSchema(schema: StandardSchemaLike, data: unknown, prefix: string): Promise<unknown> {
	const result = await schema["~standard"].validate(data)
	if (result.issues) {
		const normalized = normalizeIssues(result.issues, schema["~standard"].vendor)
		const fields = issuesToFieldErrors(normalized, prefix)
		throw new HoneyError({
			errorKey: EK.validation_failed,
			fields,
			status: SK.bad_request,
		})
	}
	return result.value
}

function parseSearchParams(url: string): Record<string, string | string[]> {
	const searchParams = new URL(url).searchParams
	const result: Record<string, string | string[]> = {}
	for (const [key, value] of searchParams) {
		const existing = result[key]
		if (existing === undefined) {
			result[key] = value
		} else if (Array.isArray(existing)) {
			existing.push(value)
		} else {
			result[key] = [existing, value]
		}
	}
	return result
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {}
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

function formDataToRecord(formData: FormData): Record<string, unknown> {
	const record: Record<string, unknown> = {}
	formData.forEach((value, key) => {
		if (DANGEROUS_KEYS.has(key)) return
		record[key] = value
	})
	return record
}

function urlEncodedToRecord(body: string): Record<string, string> {
	const params = new URLSearchParams(body)
	const record: Record<string, string> = {}
	params.forEach((value, key) => {
		if (DANGEROUS_KEYS.has(key)) return
		record[key] = value
	})
	return record
}

export async function validateInput(
	schemas: InputSchemasDef,
	req: Request,
	params: Record<string, string>,
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
		const parsed = parseSearchParams(req.url)
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

	/* body-based: json or form — skip for methods without a request body */
	assertRequestContentType(schemas, req)
	const hasBody = req.method !== "DELETE" && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"
	if (hasBody && (schemas.json || schemas.form)) {
		const contentType = req.headers.get("content-type")
		const parser = selectParser(contentType)

		if (schemas.json && parser === "json") {
			const { mode, schema } = resolveSchema(schemas.json)
			if (mode === "readableStream") {
				/* body untouched — handler reads ctx.req.body directly */
			} else {
				const body: unknown = await req.json()
				result.json = await runSchema(schema, body, "json")
			}
		} else if (schemas.form && parser === "form") {
			const { mode, schema } = resolveSchema(schemas.form)
			if (mode === "readableStream") {
				/* body untouched — handler reads ctx.req.body directly */
			} else if (contentType?.startsWith("multipart/form-data")) {
				result.form = await runSchema(schema, formDataToRecord(await req.formData()), "form")
			} else {
				result.form = await runSchema(schema, urlEncodedToRecord(await req.text()), "form")
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
