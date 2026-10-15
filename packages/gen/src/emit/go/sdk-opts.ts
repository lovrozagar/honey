/**
 * A Go method's option structs: `<Op>Opts`, its query and header params by the nilable rule (H4)
 * plus `IdempotencyKey` on an idempotent operation (G1), and `<Op>Headers`, the response headers its
 * 2xx responses declare, which `WithHeadersInto` fills (G5). Spec text reaches the source only
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

/** A method's typed response headers, as a caller names them. */
export type GoResponseHeaders = { readonly type: string; readonly fields: Readonly<Record<string, string>> }

/* the Opts field an idempotent operation's caller sets its Idempotency-Key through */
const IDEMPOTENCY_KEY = "IdempotencyKey"

/** A value's Go type when it may be absent: as is where nil already means unset (H4), else a pointer. */
const optional = (type: string, required: boolean) => (required || isNilable(type) ? type : `*${type}`)

/** Whether `op`'s Opts carry `IdempotencyKey`: an idempotent operation that answers once. */
export const takesIdempotencyKey = (op: SdkOp) => op.idempotent && op.stream === null

/** `<Op>Opts`'s param fields: each query param, then each header param, sent unless unset. */
export function optsFields(op: SdkOp, opts: string, at: GoTypeContext): OptsField[] {
	const scope = new NameScope(takesIdempotencyKey(op) ? [IDEMPOTENCY_KEY] : [])
	const field = (param: IRParam, where: OptsField["in"], send: (name: string) => string): OptsField => {
		const name = scope.claim(goExported(param.name))
		const type = goTypeOf(param.schema, { ...at, fieldName: name, parentName: opts })
		return { in: where, name, param: param.name, set: send(name), type: optional(type, param.required === true) }
	}
	return [
		...op.query.map((param) => field(param, "query", (name) => `c.query.set(${goString(param.name)}, opts.${name})`)),
		...op.headers.map((param) =>
			field(param, "header", (name) => `setHeaderValue(c.headers, ${goString(param.name)}, opts.${name})`),
		),
	]
}

/** `<Op>Opts`: the operation's optional inputs, documented. */
export function optsDecl(op: SdkOp, opts: string, fields: readonly OptsField[]): string {
	return [
		...lineComment(`${opts} holds the optional parameters of ${op.id}.`, "//"),
		`type ${opts} struct {`,
		...fields.map((field) => `\t${field.name} ${field.type}`),
		...(takesIdempotencyKey(op) ? [`\t${IDEMPOTENCY_KEY} string`] : []),
		"}",
	].join("\n")
}

/**
 * The statements applying `opts` to `c`: each set field, then the Idempotency-Key (a header already
 * set wins, then `IdempotencyKey`, then a fresh UUID, the same on an auth retry).
 */
export function optsLines(op: SdkOp, fields: readonly OptsField[]): string[] {
	const keyed = takesIdempotencyKey(op)
	const sets = [...(keyed ? [`key = opts.${IDEMPOTENCY_KEY}`] : []), ...fields.map((field) => field.set)]
	return [
		...(keyed ? ["\tvar key string"] : []),
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

/** `<Op>Headers` and its `setFrom` (named `type`), and its plan; null when `op` declares no response header. */
export function responseHeaders(
	op: SdkOp,
	at: GoTypeContext,
): { readonly plan: GoResponseHeaders; readonly decl: string } | null {
	const headers = declaredHeaders(op)
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
