/**
 * A Go method's option structs: `<Op>Opts`, its query and header params by the nilable rule (H4)
 * plus `IdempotencyKey` on an idempotent operation (G1) or a stream's own fields (a declared param on
 * a resume channel the stream sends folded into them, Fd3), and `<Op>Headers`, the response headers
 * its 2xx responses declare, which `WithHeadersInto` fills (G5). Spec text reaches the source only
 * through the shared escape layer.
 */
import type { IRParam, IRResponse } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { compareCodeUnits, goExported, NameScope } from "../shared/lang.ts"
import { isNilable } from "./types-codec.ts"
import { type GoTypeContext, goTypeOf } from "./types.ts"

/** One `<Op>Opts` field: its Go name and type, the statement sending it, and the param it carries. */
export type OptsField = {
	readonly name: string
	readonly type: string
	readonly set: string
	readonly param: string
	readonly in: "header" | "query"
}

/** A stream's own `<Op>Opts` field, after the declared ones; `doc` is its godoc. */
export type StreamField = { readonly name: string; readonly type: string; readonly doc?: string }

/**
 * What a stream adds to its `<Op>Opts`: its fields (claimed first, so a declared param that
 * collides gets `…2`), whether a declared param is a channel a field carries (then it has no field
 * of its own), the statements before the opts block, and those in it after the declared params.
 */
export type StreamOpts = {
	readonly fields: readonly StreamField[]
	readonly carries: (param: string, where: OptsField["in"]) => boolean
	readonly before: readonly string[]
	readonly sets: readonly string[]
}

/** A method's typed response headers, as a caller names them. */
export type GoResponseHeaders = { readonly type: string; readonly fields: Readonly<Record<string, string>> }

/* the Opts field an idempotent operation's caller sets its Idempotency-Key through */
const IDEMPOTENCY_KEY = "IdempotencyKey"

/** A value's Go type when it may be absent: as is where nil already means unset (H4), else a pointer. */
const optional = (type: string, required: boolean) => (required || isNilable(type) ? type : `*${type}`)

/** Whether `op`'s Opts carry `IdempotencyKey`: an idempotent operation that answers once. */
export const takesIdempotencyKey = (op: SdkOp) => op.idempotent && op.stream === null

/**
 * `<Op>Opts`'s param fields: each query param, then each header param, sent unless unset; a param
 * `stream` carries has none.
 */
export function optsFields(op: SdkOp, opts: string, at: GoTypeContext, stream: StreamOpts | null): OptsField[] {
	const own = stream?.fields.map((field) => field.name) ?? []
	const scope = new NameScope([...(takesIdempotencyKey(op) ? [IDEMPOTENCY_KEY] : []), ...own])
	const field = (param: IRParam, where: OptsField["in"], send: (name: string) => string): OptsField => {
		const name = scope.claim(goExported(param.name))
		const type = goTypeOf(param.schema, { ...at, fieldName: name, parentName: opts })
		return { in: where, name, param: param.name, set: send(name), type: optional(type, param.required === true) }
	}
	const declared = (params: readonly IRParam[], where: OptsField["in"]) =>
		params.filter((param) => stream?.carries(param.name, where) !== true)
	return [
		...declared(op.query, "query").map((param) =>
			field(param, "query", (name) => `c.query.set(${goString(param.name)}, opts.${name})`),
		),
		...declared(op.headers, "header").map((param) =>
			field(param, "header", (name) => `setHeaderValue(c.headers, ${goString(param.name)}, opts.${name})`),
		),
	]
}

/** `<Op>Opts`: the operation's optional inputs, documented, then `stream`'s own fields. */
export function optsDecl(op: SdkOp, opts: string, fields: readonly OptsField[], stream: StreamOpts | null): string {
	const own = (stream?.fields ?? []).flatMap((field) => [
		...(field.doc === undefined ? [] : lineComment(field.doc, "//", "\t")),
		`\t${field.name} ${field.type}`,
	])
	return [
		...lineComment(`${opts} holds the optional parameters of ${op.id}.`, "//"),
		`type ${opts} struct {`,
		...fields.map((field) => `\t${field.name} ${field.type}`),
		...own,
		...(takesIdempotencyKey(op) ? [`\t${IDEMPOTENCY_KEY} string`] : []),
		"}",
	].join("\n")
}

/**
 * The statements applying `opts` to `c`: each set field, then `stream`'s, then the Idempotency-Key
 * (a header already set wins, then `IdempotencyKey`, then a fresh UUID, the same on an auth retry).
 */
export function optsLines(op: SdkOp, fields: readonly OptsField[], stream: StreamOpts | null): string[] {
	const keyed = takesIdempotencyKey(op)
	const sets = [
		...(keyed ? [`key = opts.${IDEMPOTENCY_KEY}`] : []),
		...fields.map((field) => field.set),
		...(stream?.sets ?? []),
	]
	return [
		...(keyed ? ["\tvar key string"] : []),
		...(stream?.before ?? []).map((line) => `\t${line}`),
		...(sets.length > 0 ? ["\tif opts != nil {", ...sets.map((set) => `\t\t${set}`), "\t}"] : []),
		...(keyed ? ["\tsetIdempotencyKey(c.headers, key)"] : []),
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
 * `<Op>Headers` and its `setFrom` (named `type`), and its plan; null when `op` declares no response
 * header, or is a WebSocket or realtime operation, whose 2xx response no caller ever receives (a
 * handshake answers 101, and a realtime connection hands back no response).
 */
export function responseHeaders(
	op: SdkOp,
	at: GoTypeContext,
): { readonly plan: GoResponseHeaders; readonly decl: string } | null {
	const headers = op.stream === "ws" || op.stream === "realtime" ? [] : declaredHeaders(op)
	if (headers.length === 0) return null
	const type = at.names.claimConst(`${goExported(op.id)}Headers`)
	const scope = new NameScope()
	const fields = headers.map((header) => {
		const name = scope.claim(goExported(header.name))
		const use = goTypeOf(header.schema, { ...at, fieldName: name, parentName: type })
		return { header: header.name, name, type: optional(use, header.required) }
	})
	const decl = [
		...lineComment(
			`${type} holds the response headers of ${op.id}; WithHeadersInto fills it from a 2xx response.`,
			"//",
		),
		`type ${type} struct {`,
		...fields.map((field) => `\t${field.name} ${field.type}`),
		"}",
		"",
		`func (h *${type}) setFrom(hd http.Header) {`,
		...fields.map((field) => `\tsetHeaderField(hd, ${goString(field.header)}, &h.${field.name})`),
		"}",
	].join("\n")
	const plan = { fields: Object.fromEntries(fields.map((field) => [field.header, field.name])), type }
	return { decl, plan }
}
