/**
 * A Rust method's option structs (contract 18 §5.2): `<Op>Opts`, its query then header params (a required
 * one bare when its type has a `Default`, else an `Option` documented as required), then its stream's own
 * fields (a declared param on a resume channel the stream sends folded into them, Fd3), then
 * `idempotency_key` on an idempotent operation; and `<Op>Headers`, the response headers its 2xx responses
 * declare, read through `FromHeaders` by `.with_headers()` (G5). Spec text reaches the source only through
 * the shared escape layer.
 */
import type { IRParam, IRResponse, IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { lineComment, rustString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, rustTypeIdent, rustValueIdent } from "../shared/lang.ts"
import { unboxed } from "./types-struct.ts"
import { type RustTypeContext, rustTypeOf } from "./types.ts"

/**
 * One declared param's `<Op>Opts` field: its ident and type, the param it carries, whether the API requires
 * it, and whether it is a bare `T` (set without `Some`).
 */
export type OptsField = {
	readonly ident: string
	readonly type: string
	readonly param: string
	readonly in: "header" | "query"
	readonly required: boolean
	readonly bare: boolean
}

/** A stream's own `<Op>Opts` field, after the declared ones. */
export type StreamField = { readonly ident: string; readonly type: string; readonly doc?: string }

/**
 * What a stream adds to its `<Op>Opts`: its fields (claimed first, so a declared param that collides gets
 * `…2`), whether a declared param is a channel a field carries (then it has no field of its own), and the
 * statements sending its fields after the declared params.
 */
export type StreamOpts = {
	readonly fields: readonly StreamField[]
	readonly carries: (param: string, where: OptsField["in"]) => boolean
	readonly sends: readonly string[]
}

/** A method's typed response headers, as a caller names them. */
export type RustResponseHeaders = { readonly type: string; readonly fields: Readonly<Record<string, string>> }

/* the Opts field an idempotent operation's caller sets its Idempotency-Key through */
const IDEMPOTENCY_KEY = "idempotency_key"

type Resolve = (schema: IRSchema) => IRSchema

const isStringConst = (s: IRSchema) => s.kind === "const" && typeof s.value === "string"

/** Whether the type `schema` declares as a component has a `Default`: a struct, a newtype and a payload enum do not. */
function declaredDefault(schema: IRSchema, resolve: Resolve): boolean {
	if (schema.kind === "const" || schema.kind === "allOf") return false
	if (schema.kind === "object") return schema.fields.length === 0 && schema.additional !== false
	if (schema.kind === "union" && schema.variants.length > 0)
		return schema.discriminator === undefined && schema.variants.every(isStringConst)
	return hasDefault(schema, resolve)
}

/** Whether the Rust type of `schema` in use position has a `Default`: only a hoisted struct or a component without one lacks it. */
function hasDefault(schema: IRSchema, resolve: Resolve): boolean {
	if (schema.kind === "ref") return declaredDefault(resolve(schema), resolve)
	if (schema.kind === "object") return schema.fields.length === 0
	if (schema.kind !== "allOf") return true
	const { parts } = schema
	const part = parts.length === 1 ? parts[0] : parts.find((p) => p.kind === "ref")
	return part === undefined || hasDefault(part, resolve)
}

/** `type` as a field that may be unset: as it is when it is an `Option` already. */
const optional = (type: string) => (type.startsWith("Option<") ? type : `Option<${type}>`)

/** Whether `op`'s Opts carry `idempotency_key`: an idempotent operation that answers once. */
export const takesIdempotencyKey = (op: SdkOp) => op.idempotent && op.stream === null

/** `<Op>Opts`'s param fields: each query param, then each header param; a param `stream` carries has none. */
export function optsFields(op: SdkOp, opts: string, at: RustTypeContext, stream: StreamOpts | null): OptsField[] {
	const own = stream?.fields.map((field) => field.ident) ?? []
	const scope = new NameScope([...(takesIdempotencyKey(op) ? [IDEMPOTENCY_KEY] : []), ...own])
	const field = (param: IRParam, where: OptsField["in"]): OptsField => {
		const ident = scope.claim(rustValueIdent(param.name))
		const type = unboxed(param.schema, rustTypeOf(param.schema, { ...at, fieldName: param.name, parentName: opts }))
		const required = param.required === true
		const bare = required && hasDefault(param.schema, at.names.resolve)
		return { bare, ident, in: where, param: param.name, required, type: bare ? type : optional(type) }
	}
	const declared = (params: readonly IRParam[], where: OptsField["in"]) =>
		params.filter((param) => stream?.carries(param.name, where) !== true).map((param) => field(param, where))
	return [...declared(op.query, "query"), ...declared(op.headers, "header")]
}

/** `<Op>Opts`: the operation's inputs beyond its path and body, documented, then `stream`'s own fields. */
export function optsDecl(op: SdkOp, opts: string, fields: readonly OptsField[], stream: StreamOpts | null): string {
	const declared = fields.flatMap((field) => [
		...(field.required && !field.bare ? ["    /// Required by the API."] : []),
		`    pub ${field.ident}: ${field.type},`,
	])
	const own = (stream?.fields ?? []).flatMap((field) => [
		...(field.doc === undefined ? [] : lineComment(field.doc, "///", "    ")),
		`    pub ${field.ident}: ${field.type},`,
	])
	const keyed = takesIdempotencyKey(op) ? [`    pub ${IDEMPOTENCY_KEY}: Option<String>,`] : []
	const body = [...declared, ...own, ...keyed]
	return [
		...lineComment(`The parameters of ${op.id} beyond its path and body.`, "///"),
		"#[derive(Debug, Clone, Default)]",
		body.length === 0 ? `pub struct ${opts} {}` : [`pub struct ${opts} {`, ...body, "}"].join("\n"),
	].join("\n")
}

/** The statements sending `opts`: each declared field, then `stream`'s, then the Idempotency-Key. */
export function optsLines(op: SdkOp, fields: readonly OptsField[], stream: StreamOpts | null): string[] {
	return [
		...fields.map((field) => `spec.${field.in}(${rustString(field.param)}, &opts.${field.ident});`),
		...(stream?.sends ?? []),
		...(takesIdempotencyKey(op) ? [`spec.idempotency_key(&opts.${IDEMPOTENCY_KEY});`] : []),
	]
}

type Header = NonNullable<IRResponse["headers"]>[number]

/** The headers `op`'s 2xx responses declare, statuses ascending, a name's first spelling (any casing) kept; by name. */
function declaredHeaders(op: SdkOp): Header[] {
	const all = Object.keys(op.ir.responses)
		.filter((status) => /^2(?:\d\d|XX)$/i.test(status))
		.sort(compareCodeUnits)
		.flatMap((status) => (op.ir.responses[status] as IRResponse).headers ?? [])
	/* reversed, so the first spelling of a name is the one its key ends on */
	const first = new Map(all.toReversed().map((header) => [header.name.toLowerCase(), header]))
	return [...first.values()].sort((a, b) => compareCodeUnits(a.name, b.name))
}

/**
 * `<Op>Headers` and its `FromHeaders` impl, and its plan; null when `op` declares no response header, or is a
 * WebSocket or realtime operation, whose 2xx response no caller receives.
 */
export function responseHeaders(
	op: SdkOp,
	at: RustTypeContext,
): { readonly plan: RustResponseHeaders; readonly decl: string } | null {
	const headers = op.stream === "ws" || op.stream === "realtime" ? [] : declaredHeaders(op)
	if (headers.length === 0) return null
	const type = at.names.claim(`${rustTypeIdent(op.id)}Headers`)
	const scope = new NameScope()
	const fields = headers.map((header) => {
		const ident = scope.claim(rustValueIdent(header.name))
		const use = unboxed(header.schema, rustTypeOf(header.schema, { ...at, fieldName: header.name, parentName: type }))
		const read = header.required ? "required_header" : "header"
		return { header: header.name, ident, read, type: header.required ? use : optional(use) }
	})
	const decl = [
		...lineComment(`The response headers of ${op.id}, read by \`.with_headers()\`.`, "///"),
		"#[derive(Debug, Clone)]",
		`pub struct ${type} {`,
		...fields.map((field) => `    pub ${field.ident}: ${field.type},`),
		"}",
		"",
		`impl FromHeaders for ${type} {`,
		"    fn from_headers(headers: &reqwest::header::HeaderMap) -> Result<Self, Error> {",
		`        Ok(${type} {`,
		...fields.map(
			(field) => `            ${field.ident}: crate::answer::${field.read}(headers, ${rustString(field.header)})?,`,
		),
		"        })",
		"    }",
		"}",
	].join("\n")
	const plan = { fields: Object.fromEntries(fields.map((field) => [field.header, field.ident])), type }
	return { decl, plan }
}
