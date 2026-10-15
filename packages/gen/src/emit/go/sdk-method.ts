/**
 * One operation as a Go method (G1): `(ctx, <path params in path order>, <body>?, opts *<Op>Opts,
 * reqOpts ...RequestOption)`, filling the runtime's `call` and handing it to `doRequest` (or
 * `dialWebSocket`). The query and header params ride on `<Op>Opts`, sent only when set. Spec text
 * reaches the source only through the shared escape layer.
 */
import type { IRParam } from "../../ir/model.ts"
import { mediaEssence, type SdkBody, type SdkOp, type SdkResponseKind, type SdkStream } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { goExported, goLocal, NameScope } from "../shared/lang.ts"
import { shapeOf } from "./sdk-answer.ts"
import { type GoBody, goBody } from "./sdk-body.ts"
import { type GoResponseHeaders, type OptsField, optsDecl, optsFields, optsLines, responseHeaders } from "./sdk-opts.ts"
import { type GoTypeContext, goTypeOf } from "./types.ts"

/**
 * How a caller reaches a method, by the names this emitter gave it: the test driver's call plan
 * (G8.4), so a driver invokes the method by reflection without re-deriving a name.
 */
export type GoMethodCall = {
	readonly operation: string
	readonly method: string
	/** the path params by spec name, in signature order */
	readonly pathParams: readonly string[]
	/** the kind of the body parameter that follows them (`goBody`, which also emits it); null without one */
	readonly body: SdkBody["kind"] | null
	/** each query param by spec name, to its `<Op>Opts` field */
	readonly query: Readonly<Record<string, string>>
	/** each header param by spec name, to its `<Op>Opts` field */
	readonly headers: Readonly<Record<string, string>>
	readonly response: SdkResponseKind
	/**
	 * the `<Op>Headers` struct `WithHeadersInto` fills: its type name and each declared response
	 * header (as the spec spells it) to its field; null for a method that has none
	 */
	readonly responseHeaders: GoResponseHeaders | null
	readonly stream: SdkStream
}

/** One operation's method, its client.go declarations by name (`<Op>Opts`, `<Op>Headers`), and how a caller reaches it. */
export type GoMethod = {
	readonly call: GoMethodCall
	readonly decls: readonly (readonly [string, string])[]
	readonly lines: readonly string[]
}

/** What every method of one SDK shares: the type context it hoists into, and the error mode. */
export type MethodEnv = { readonly at: GoTypeContext; readonly throwOnError: boolean }

/** Where a method lives: its receiver's type, and the expression reaching the `*Client` from it. */
export type Receiver = { readonly type: string; readonly client: string }

/* the receiver, the method's own locals and the unexported runtime names its body calls: a path param never shadows one */
const METHOD_LOCALS = [
	"c",
	"call",
	"ctx",
	"data",
	"decodeJSON",
	"dialWebSocket",
	"doRequest",
	"err",
	"expandPath",
	"fields",
	"fileField",
	"formBody",
	"jsonBody",
	"key",
	"mp",
	"multipartBody",
	"multipartField",
	"opts",
	"params",
	"path",
	"r",
	"rawBody",
	"readerBody",
	"reqOpts",
	"result",
	"safeResult",
	"setHeaderValue",
	"setIdempotencyKey",
	"textField",
	"v",
]

/** The operation's path params in the order the path holds them, whatever order they were declared in. */
function pathParamsOf(op: SdkOp): IRParam[] {
	const order = op.pathSegments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
	return [...op.pathParams].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
}

/** How a caller reaches the method `name` of `op`: its path params, body and Opts fields by spec name. */
function callOf(op: SdkOp, name: string, path: readonly [IRParam, string][], fields: readonly OptsField[]) {
	const by = (at: OptsField["in"]) =>
		Object.fromEntries(fields.filter((field) => field.in === at).map((field) => [field.param, field.name]))
	return {
		body: op.body?.kind ?? null,
		headers: by("header"),
		method: name,
		operation: op.id,
		pathParams: path.map(([param]) => param.name),
		query: by("query"),
		response: op.success.kind,
		stream: op.stream,
	}
}

/** The method's godoc: its name and route, then the operation's summary and description. */
function methodDoc(op: SdkOp, name: string): string[] {
	const text = [`${name} calls ${op.method} ${op.path}.`, op.summary, op.description].filter((part) => part !== "")
	return lineComment(text.join("\n\n"), "//")
}

/** The statements expanding the path, and the expression the call sends as its path. */
type PathLines = { readonly lines: readonly string[]; readonly path: string }

/** The statements before `c`: the path expanded from its params, or the template as it is. */
function pathLines(op: SdkOp, locals: readonly [IRParam, string][], fail: string): PathLines {
	if (locals.length === 0) return { lines: [], path: goString(op.path) }
	const params = locals.map(([param, local]) => `${goString(param.name)}: ${local}`).join(", ")
	return {
		lines: [
			`\tparams := map[string]string{${params}}`,
			`\tpath, err := expandPath(${goString(op.path)}, params)`,
			"\tif err != nil {",
			`\t\treturn ${fail}`,
			"\t}",
		],
		path: "path",
	}
}

/** The operation's own headers: Accept for a binary or text answer (a per-call header still wins, G4). */
function acceptOf(op: SdkOp): string {
	const { contentType, kind } = op.success
	if (kind !== "binary" && kind !== "text") return "map[string]string{}"
	return `map[string]string{"Accept": ${goString(mediaEssence(contentType as string))}}`
}

/** The `call` literal's members: the route, the operation's headers, the body, and the targets a success stales. */
function callMembers(op: SdkOp, path: PathLines, body: GoBody | undefined, client: string): string[] {
	return [
		`method: ${goString(op.method)}`,
		`path: ${path.path}`,
		`operation: ${goString(`${op.method} ${op.path}`)}`,
		`headers: ${acceptOf(op)}`,
		...(body ? [`body: ${body.send}`] : []),
		...(op.invalidates.length > 0 ? [`invalidates: []string{${op.invalidates.map(goString).join(", ")}}`] : []),
		`stale: ${client}.stale`,
		...(path.lines.length > 0 ? ["params: params"] : []),
	]
}

/** The method of `op` named `name` on `receiver`, and its `<Op>Opts` and `<Op>Headers`. */
export function goMethod(op: SdkOp, name: string, receiver: Receiver, env: MethodEnv): GoMethod {
	const opts = env.at.names.claimConst(`${goExported(op.id)}Opts`)
	const locals = new NameScope(METHOD_LOCALS)
	const bodyLocal = op.body && locals.claim("body")
	const body = op.body && goBody(op, op.body, { at: env.at, local: bodyLocal as string })
	const pathLocals = pathParamsOf(op).map((param): [IRParam, string] => [param, locals.claim(goLocal(param.name))])
	const schema = op.success.schema
	const result = schema && goTypeOf(schema, { ...env.at, fieldName: "Response", parentName: op.id }).replace(/^\*/, "")
	const shape = shapeOf({ kind: op.success.kind, result, throwOnError: env.throwOnError, ws: op.stream === "ws" })
	const fields = optsFields(op, opts, env.at)
	const path = pathLines(op, pathLocals, shape.fail)
	const headers = responseHeaders(op, env.at)
	const params = [
		"ctx context.Context",
		...pathLocals.map(([, local]) => `${local} string`),
		...(body ? [`${bodyLocal} ${body.type}`] : []),
		`opts *${opts}`,
		"reqOpts ...RequestOption",
	]
	const lines = [
		...methodDoc(op, name),
		`func (r *${receiver.type}) ${name}(${params.join(", ")}) ${shape.returns} {`,
		...path.lines,
		...(body ? body.lines(shape.fail) : []),
		`\tc := &call{${callMembers(op, path, body, receiver.client).join(", ")}}`,
		...optsLines(op, fields),
		...shape.tail(`ctx, ${receiver.client}.cfg, c, reqOpts`),
		"}",
	]
	const decls: [string, string][] = [[opts, optsDecl(op, opts, fields)]]
	if (headers) decls.push([headers.plan.type, headers.decl])
	const call = { ...callOf(op, name, pathLocals, fields), responseHeaders: headers?.plan ?? null }
	return { call, decls, lines }
}
