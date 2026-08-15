/**
 * Generates per-language API reference Markdown from an OpenAPI spec via the
 * shared codegen IR. One file per language, committed as a parity artifact.
 *
 * Usage:
 *   bun run public/honey/core/scripts/gen-api-ref.ts
 *   bun run public/honey/core/scripts/gen-api-ref.ts --spec path/to/spec.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { IR, IROperation, IRParam, IRSchema } from "../src/codegen-ir.ts"
import { toIR } from "../src/codegen-ir.ts"
import type { OpenApiSpecInput } from "../src/codegen.ts"

export type Lang = "typescript" | "python" | "go" | "rust"

const LANGS: Lang[] = ["typescript", "python", "go", "rust"]

/* ---------- name conventions ---------- */

/** Inlined from emitters so the script stays self-contained. */
function toSnake(s: string): string {
	return s
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[-.\s]+/g, "_")
		.toLowerCase()
}

function toPascal(s: string): string {
	return s
		.replace(/[-_.\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
		.replace(/^(.)/, (m) => m.toUpperCase())
}

function methodName(lang: Lang, operationId: string): string {
	/* operationIds like "users.getById" split on dot in emitters, but the mock
	 * spec uses flat ids like "listUsers". We render the whole id so the doc
	 * reflects the emitted public API symbol. */
	switch (lang) {
		case "typescript":
			return operationId
		case "python":
			return toSnake(operationId)
		case "go":
			return toPascal(operationId)
		case "rust":
			return toSnake(operationId)
	}
}

/* ---------- schema → compact per-lang type string ---------- */

function renderSchema(schema: IRSchema, lang: Lang): string {
	switch (schema.kind) {
		case "scalar":
			return scalarFor(schema.type, schema.format, lang)
		case "const":
			return JSON.stringify(schema.value)
		case "array":
			return arrayFor(renderSchema(schema.items, lang), lang)
		case "tuple":
			return `[${schema.items.map((i) => renderSchema(i, lang)).join(", ")}]`
		case "nullable":
			return nullableFor(renderSchema(schema.inner, lang), lang)
		case "union":
			return schema.variants.map((v) => renderSchema(v, lang)).join(" | ")
		case "allOf":
			return schema.parts.map((p) => renderSchema(p, lang)).join(" & ")
		case "ref":
			return schema.name
		case "binary":
			return binaryFor(lang)
		case "object":
			if (schema.fields.length === 0 && !schema.additional) return objectAnyFor(lang)
			return inlineObjectFor(schema, lang)
		case "unknown":
			return unknownFor(lang)
	}
}

function scalarFor(t: string, format: string | undefined, lang: Lang): string {
	switch (lang) {
		case "typescript":
			if (t === "integer" || t === "number") return "number"
			if (t === "boolean") return "boolean"
			if (t === "null") return "null"
			return "string"
		case "python":
			if (t === "integer") return "int"
			if (t === "number") return "float"
			if (t === "boolean") return "bool"
			if (t === "null") return "None"
			return "str"
		case "go":
			if (t === "integer") return format === "int64" ? "int64" : "int"
			if (t === "number") return "float64"
			if (t === "boolean") return "bool"
			if (t === "null") return "any"
			return "string"
		case "rust":
			if (t === "integer") return "i64"
			if (t === "number") return "f64"
			if (t === "boolean") return "bool"
			if (t === "null") return "()"
			return "String"
	}
}

function arrayFor(inner: string, lang: Lang): string {
	switch (lang) {
		case "typescript":
			return `${inner}[]`
		case "python":
			return `List[${inner}]`
		case "go":
			return `[]${inner}`
		case "rust":
			return `Vec<${inner}>`
	}
}

function nullableFor(inner: string, lang: Lang): string {
	switch (lang) {
		case "typescript":
			return `${inner} | null`
		case "python":
			return `Optional[${inner}]`
		case "go":
			return `*${inner}`
		case "rust":
			return `Option<${inner}>`
	}
}

function binaryFor(lang: Lang): string {
	switch (lang) {
		case "typescript":
			return "ReadableStream | Blob"
		case "python":
			return "AsyncIterator[bytes]"
		case "go":
			return "io.Reader"
		case "rust":
			return "impl Stream<Item = Bytes>"
	}
}

function objectAnyFor(lang: Lang): string {
	switch (lang) {
		case "typescript":
			return "Record<string, unknown>"
		case "python":
			return "Dict[str, Any]"
		case "go":
			return "map[string]any"
		case "rust":
			return "serde_json::Map<String, Value>"
	}
}

function unknownFor(lang: Lang): string {
	switch (lang) {
		case "typescript":
			return "unknown"
		case "python":
			return "Any"
		case "go":
			return "any"
		case "rust":
			return "serde_json::Value"
	}
}

function inlineObjectFor(
	schema: Extract<IRSchema, { kind: "object" }>,
	lang: Lang,
): string {
	const fields = schema.fields.map((f) => {
		const t = renderSchema(f.schema, lang)
		const opt = !f.required
		switch (lang) {
			case "typescript":
				return `${f.name}${opt ? "?" : ""}: ${t}`
			case "python":
				return `${f.name}: ${opt ? `Optional[${t}]` : t}`
			case "go":
				return `${toPascal(f.name)} ${opt ? `*${t}` : t}`
			case "rust":
				return `${toSnake(f.name)}: ${opt ? `Option<${t}>` : t}`
		}
	})
	switch (lang) {
		case "typescript":
			return `{ ${fields.join("; ")} }`
		case "python":
			return `{ ${fields.join(", ")} }`
		case "go":
			return `struct { ${fields.join("; ")} }`
		case "rust":
			return `struct { ${fields.join(", ")} }`
	}
}

/* ---------- body / response helpers ---------- */

function renderBody(op: IROperation, lang: Lang): string[] {
	const body = op.body
	if (!body) return []
	const lines: string[] = ["**Request body**", ""]
	lines.push(`- Content-type: \`${body.contentType}\``)
	lines.push(`- Required: ${body.required ? "yes" : "no"}`)
	if (body.kind === "raw") {
		lines.push(`- Type: \`${renderSchema(body.schema, lang)}\``)
	} else if (body.kind === "stream") {
		lines.push(`- Type: \`${binaryFor(lang)}\``)
	} else {
		lines.push("- Parts:")
		for (const part of body.parts) {
			const t = part.schema ? renderSchema(part.schema, lang) : "unknown"
			lines.push(`  - \`${part.name}\` (${part.type}): \`${t}\``)
		}
	}
	lines.push("")
	return lines
}

function renderParamTable(title: string, params: IRParam[], lang: Lang): string[] {
	if (params.length === 0) return []
	const lines: string[] = [`**${title}**`, "", "| Name | Type |", "| ---- | ---- |"]
	for (const p of params) {
		lines.push(`| \`${p.name}\` | \`${renderSchema(p.schema, lang)}\` |`)
	}
	lines.push("")
	return lines
}

function renderResponses(op: IROperation, lang: Lang): string[] {
	const statuses = Object.keys(op.responses)
	if (statuses.length === 0) return []
	const lines: string[] = [
		"**Responses**",
		"",
		"| Status | Content-type | Type |",
		"| ------ | ------------ | ---- |",
	]
	for (const status of statuses) {
		const r = op.responses[status]
		if (!r) continue
		const ct = r.contentType ?? "—"
		const t = r.schema ? `\`${renderSchema(r.schema, lang)}\`` : "—"
		lines.push(`| \`${status}\` | \`${ct}\` | ${t} |`)
	}
	lines.push("")
	return lines
}

function renderExtensions(op: IROperation): string[] {
	const ext = op.extensions
	const out: string[] = []
	if (ext.websocket) out.push("- `x-websocket`: yes")
	if (ext.realtime) out.push("- `x-realtime`: yes")
	if (ext.sse) out.push("- SSE response detected (`text/event-stream`)")
	if (ext.deprecated) out.push("- `x-deprecated`: yes")
	if (ext.idempotencyKey) out.push("- `x-idempotency-key`: yes — auto-sent if omitted")
	if (ext.invalidates && ext.invalidates.length > 0) {
		out.push(`- \`x-invalidate\`: ${ext.invalidates.map((v) => `\`${v}\``).join(", ")}`)
	}
	if (out.length === 0) return []
	return ["**Extensions**", "", ...out, ""]
}

/* ---------- per-lang signature ---------- */

function renderSignature(op: IROperation, lang: Lang): string {
	const name = methodName(lang, op.id)
	const success = pickSuccessResponse(op)
	const successType = success?.schema ? renderSchema(success.schema, lang) : voidFor(lang)

	const ws = op.extensions.websocket
	const realtime = op.extensions.realtime
	const sse = op.extensions.sse

	const returnType = specialReturn(lang, successType, { realtime, sse, ws })

	const args = collectArgs(op, lang)

	switch (lang) {
		case "typescript":
			return `${name}(${args.join(", ")}): ${returnType}`
		case "python":
			return `async def ${name}(self${args.length ? ", " : ""}${args.join(", ")}) -> ${returnType}`
		case "go":
			return `func (c *Client) ${name}(ctx context.Context${args.length ? ", " : ""}${args.join(", ")}) (${returnType}, error)`
		case "rust":
			return `pub async fn ${name}(&self${args.length ? ", " : ""}${args.join(", ")}) -> Result<${returnType}, Error>`
	}
}

function pickSuccessResponse(op: IROperation) {
	for (const status of Object.keys(op.responses)) {
		if (status.startsWith("2")) return op.responses[status]
	}
	return undefined
}

function voidFor(lang: Lang): string {
	switch (lang) {
		case "typescript":
			return "void"
		case "python":
			return "None"
		case "go":
			return "struct{}"
		case "rust":
			return "()"
	}
}

function specialReturn(
	lang: Lang,
	baseType: string,
	ext: { ws?: true; realtime?: true; sse?: true },
): string {
	if (ext.realtime || ext.ws) {
		switch (lang) {
			case "typescript":
				return "ResumableConnection"
			case "python":
				return "ResumableConnection"
			case "go":
				return "*ResumableConnection"
			case "rust":
				return "ResumableConnection"
		}
	}
	if (ext.sse) {
		switch (lang) {
			case "typescript":
				return `AsyncIterable<${baseType}>`
			case "python":
				return `AsyncIterator[${baseType}]`
			case "go":
				return `<-chan ${baseType}`
			case "rust":
				return `impl Stream<Item = ${baseType}>`
		}
	}
	switch (lang) {
		case "typescript":
			return `Promise<${baseType}>`
		case "python":
			return baseType
		case "go":
			return baseType
		case "rust":
			return baseType
	}
}

function collectArgs(op: IROperation, lang: Lang): string[] {
	const out: string[] = []
	const allParams = [...op.params.path, ...op.params.query, ...op.params.header]
	for (const p of allParams) {
		const t = renderSchema(p.schema, lang)
		switch (lang) {
			case "typescript":
				out.push(`${p.name}: ${t}`)
				break
			case "python":
				out.push(`${toSnake(p.name)}: ${t}`)
				break
			case "go":
				out.push(`${toPascal(p.name)} ${t}`)
				break
			case "rust":
				out.push(`${toSnake(p.name)}: ${t}`)
				break
		}
	}
	if (op.body) {
		let t: string
		if (op.body.kind === "raw") {
			t = renderSchema(op.body.schema, lang)
		} else if (op.body.kind === "stream") {
			t = binaryFor(lang)
		} else {
			t = objectAnyFor(lang)
		}
		switch (lang) {
			case "typescript":
				out.push(`body: ${t}`)
				break
			case "python":
				out.push(`body: ${t}`)
				break
			case "go":
				out.push(`body ${t}`)
				break
			case "rust":
				out.push(`body: ${t}`)
				break
		}
	}
	return out
}

/* ---------- typed-errors section ---------- */

type ErrorRow = { name: string; status: string; note: string }

const ERROR_ROWS: ErrorRow[] = [
	{ name: "BadRequest", note: "invalid request payload", status: "400" },
	{ name: "Unauthorized", note: "missing/invalid auth; triggers onAuthExpired + 1 retry", status: "401" },
	{ name: "Forbidden", note: "authenticated but not permitted", status: "403" },
	{ name: "NotFound", note: "resource does not exist", status: "404" },
	{ name: "Conflict", note: "state conflict / unique violation", status: "409" },
	{ name: "UnprocessableEntity", note: "schema-valid but semantically rejected", status: "422" },
	{ name: "TooManyRequests", note: "rate-limited; consumer handles backoff via hooks", status: "429" },
	{ name: "InternalServerError", note: "server crash", status: "500" },
	{ name: "BadGateway", note: "upstream failure", status: "502" },
	{ name: "ServiceUnavailable", note: "server temporarily unavailable", status: "503" },
	{ name: "GatewayTimeout", note: "upstream timeout", status: "504" },
	{ name: "StatusError", note: "fallback for undeclared/other statuses", status: "*" },
]

function renderErrorClassName(name: string, lang: Lang): string {
	switch (lang) {
		case "typescript":
			return name /* class NotFoundError — we show canonical taxonomy name */
		case "python":
			return name
		case "go":
			return `Err${name}` /* sentinel style */
		case "rust":
			return `Error::${name}` /* enum variant */
	}
}

function renderTypedErrors(lang: Lang): string[] {
	const lines: string[] = [
		"## Typed Errors",
		"",
		"Every operation's error channel surfaces one of:",
		"",
		"| Canonical | Status | Lang symbol | Notes |",
		"| --------- | ------ | ----------- | ----- |",
	]
	for (const row of ERROR_ROWS) {
		lines.push(
			`| \`${row.name}\` | ${row.status} | \`${renderErrorClassName(row.name, lang)}\` | ${row.note} |`,
		)
	}
	lines.push("")
	lines.push(
		"Operations with declared `responses: { 4xx: { schema } }` parse the response body into the error's typed `data` field.",
	)
	lines.push("")
	return lines
}

/* ---------- top-level renderer ---------- */

function renderOperation(op: IROperation, lang: Lang): string[] {
	const name = methodName(lang, op.id)
	const lines: string[] = [
		`### ${name}`,
		"",
		`\`${op.method} ${op.path}\``,
		"",
	]
	if (op.description) {
		lines.push(op.description, "")
	}
	lines.push("**Signature**", "", "```", renderSignature(op, lang), "```", "")
	lines.push(...renderParamTable("Path params", op.params.path, lang))
	lines.push(...renderParamTable("Query params", op.params.query, lang))
	lines.push(...renderParamTable("Header params", op.params.header, lang))
	lines.push(...renderBody(op, lang))
	lines.push(...renderResponses(op, lang))
	lines.push(...renderExtensions(op))
	lines.push("---", "")
	return lines
}

const LANG_LABEL: Record<Lang, string> = {
	go: "Go",
	python: "Python",
	rust: "Rust",
	typescript: "TypeScript",
}

function renderFile(ir: IR, lang: Lang): string {
	const lines: string[] = [
		`# ${LANG_LABEL[lang]} API Reference`,
		"",
		"Generated from OpenAPI via the shared codegen IR. Do not edit by hand —",
		"run `bun run public/honey/core/scripts/gen-api-ref.ts` to regenerate.",
		"",
	]
	lines.push(...renderTypedErrors(lang))
	lines.push("## Operations", "")
	/* stable ordering: path then method */
	const sorted = [...ir.operations].sort((a, b) => {
		if (a.path !== b.path) return a.path.localeCompare(b.path)
		return a.method.localeCompare(b.method)
	})
	for (const op of sorted) {
		lines.push(...renderOperation(op, lang))
	}
	return lines.join("\n")
}

export function generateApiRef(spec: OpenApiSpecInput): Record<Lang, string> {
	const ir = toIR(spec)
	const out = {} as Record<Lang, string>
	for (const lang of LANGS) {
		out[lang] = renderFile(ir, lang)
	}
	return out
}

/* ---------- script entry ---------- */

function scriptMain(): void {
	const args = process.argv.slice(2)
	const scriptDir = dirname(fileURLToPath(import.meta.url))
	const coreRoot = resolve(scriptDir, "..")
	let specPath = resolve(coreRoot, "tests/mock-server/spec.json")
	for (let i = 0; i < args.length; i++) {
		const next = args[i + 1]
		if (args[i] === "--spec" && next) {
			specPath = resolve(process.cwd(), next)
			i++
		}
	}

	const raw = readFileSync(specPath, "utf8")
	const spec = JSON.parse(raw) as OpenApiSpecInput
	const out = generateApiRef(spec)
	const outDir = resolve(coreRoot, "docs/api-ref")
	mkdirSync(outDir, { recursive: true })
	for (const lang of LANGS) {
		const file = join(outDir, `${lang}.md`)
		writeFileSync(file, out[lang])
		/* eslint-disable-next-line no-console */
		console.log(`wrote ${file}`)
	}
}

/* Only run when executed directly, not when imported by the test. */
const thisFile = fileURLToPath(import.meta.url)
if (process.argv[1] === thisFile) {
	scriptMain()
}
