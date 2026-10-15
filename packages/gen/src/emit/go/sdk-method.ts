/**
 * One operation as a Go method (G1): `(ctx, <path params in path order>, <body>?, opts *<Op>Opts,
 * reqOpts ...RequestOption)`, filling the runtime's `call` and handing it to `doRequest` (or
 * `dialWebSocket`). The query and header params ride on `<Op>Opts` as pointers, sent only when set.
 * Spec text reaches the source only through the shared escape layer.
 */
import type { IRParam } from "../../ir/model.ts"
import type { SdkOp, SdkResponseKind, SdkStream } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { goExported, goLocal, NameScope } from "../shared/lang.ts"
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
	/** whether a JSON body follows them */
	readonly body: boolean
	/** each query param by spec name, to its `<Op>Opts` field */
	readonly query: Readonly<Record<string, string>>
	/** each header param by spec name, to its `<Op>Opts` field */
	readonly headers: Readonly<Record<string, string>>
	readonly response: SdkResponseKind
	readonly stream: SdkStream
}

/** One operation's method, the options struct it takes, and how a caller reaches it. */
export type GoMethod = {
	readonly call: GoMethodCall
	readonly opts: string
	readonly optsDecl: string
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
	"jsonBody",
	"opts",
	"params",
	"path",
	"r",
	"reqOpts",
	"result",
	"safeResult",
	"setHeaderValue",
]

/** How a method answers: its return types, the values it fails with, and the statements that send `c`. */
type Shape = { returns: string; fail: string; tail: (send: string) => string[] }

/* a WebSocket operation: the dialed socket */
const WS_SHAPE: Shape = {
	fail: "nil, err",
	returns: "(*TypedWebSocket, error)",
	tail: (send) => [`\treturn dialWebSocket(${send})`],
}

/* an operation answering without a body, in either error mode */
const NO_BODY_SHAPE: Shape = {
	fail: "err",
	returns: "error",
	tail: (send) => [`\tif _, err := doRequest(${send}); err != nil {`, "\t\treturn err", "\t}", "\treturn nil"],
}

/** The shape of a method returning `result` (none: the operation answers without a body). */
function shapeOf(op: SdkOp, result: string | undefined, throwOnError: boolean): Shape {
	if (op.stream === "ws") return WS_SHAPE
	if (result === undefined) return NO_BODY_SHAPE
	if (throwOnError) {
		const tail = (send: string) => [
			`\tresult, err := doRequest(${send})`,
			"\tif err != nil {",
			"\t\treturn nil, err",
			"\t}",
			`\treturn decodeJSON[${result}](result.body)`,
		]
		return { fail: "nil, err", returns: `(*${result}, error)`, tail }
	}
	const tail = (send: string) => [
		`\tresult, err := doRequest(${send})`,
		"\tif err != nil {",
		`\t\treturn safeResult[${result}](nil, nil, err)`,
		"\t}",
		`\tdata, err := decodeJSON[${result}](result.body)`,
		"\treturn safeResult(data, result, err)",
	]
	return { fail: `SDKResult[${result}]{}, err`, returns: `(SDKResult[${result}], error)`, tail }
}

/** The operation's path params in the order the path holds them, whatever order they were declared in. */
function pathParamsOf(op: SdkOp): IRParam[] {
	const order = op.pathSegments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
	return [...op.pathParams].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
}

/** The type context of a use position in the operation: `parentName` never a Go name, so its hoist keys are its own. */
const position = (env: MethodEnv, parentName: string, fieldName: string): GoTypeContext => ({
	...env.at,
	fieldName,
	parentName,
})

type OptsField = { name: string; type: string; set: string; param: string; in: "header" | "query" }

/** `<Op>Opts`'s fields: each query param, then each header param, as a pointer the method sends only when set. */
function optsFields(op: SdkOp, opts: string, env: MethodEnv): OptsField[] {
	const scope = new NameScope()
	const field = (param: IRParam, at: OptsField["in"], send: (name: string) => string): OptsField => {
		const name = scope.claim(goExported(param.name))
		const type = `*${goTypeOf(param.schema, position(env, opts, name))}`
		return { in: at, name, param: param.name, set: send(name), type }
	}
	return [
		...op.query.map((param) => field(param, "query", (name) => `c.query.set(${goString(param.name)}, opts.${name})`)),
		...op.headers.map((param) =>
			field(param, "header", (name) => `setHeaderValue(c.headers, ${goString(param.name)}, opts.${name})`),
		),
	]
}

/** `<Op>Opts`: the operation's optional inputs, documented. */
function optsDecl(op: SdkOp, opts: string, fields: readonly OptsField[]): string {
	return [
		...lineComment(`${opts} holds the optional parameters of ${op.id}.`, "//"),
		`type ${opts} struct {`,
		...fields.map((field) => `\t${field.name} ${field.type}`),
		"}",
	].join("\n")
}

/** The operation's body when it is JSON: the one kind a method takes as a typed parameter. */
const jsonBodyOf = (op: SdkOp) => (op.body?.kind === "json" ? op.body : undefined)

/** How a caller reaches the method `name` of `op`: its path params, body and Opts fields by spec name. */
function callOf(
	op: SdkOp,
	name: string,
	path: readonly [IRParam, string][],
	fields: readonly OptsField[],
): GoMethodCall {
	const by = (at: OptsField["in"]) =>
		Object.fromEntries(fields.filter((field) => field.in === at).map((field) => [field.param, field.name]))
	return {
		body: jsonBodyOf(op) !== undefined,
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

/** The statements before `c`: the path expanded from its params, or the template as it is. */
function pathLines(op: SdkOp, locals: readonly [IRParam, string][], fail: string): { lines: string[]; path: string } {
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

/** The method of `op` named `name` on `receiver`, and its `<Op>Opts`. */
export function goMethod(op: SdkOp, name: string, receiver: Receiver, env: MethodEnv): GoMethod {
	const opts = env.at.names.claimConst(`${goExported(op.id)}Opts`)
	const locals = new NameScope(METHOD_LOCALS)
	const body = jsonBodyOf(op)
	const bodyParam = body ? [`${locals.claim("body")} ${goTypeOf(body.schema, position(env, op.id, "Body"))}`] : []
	const pathLocals = pathParamsOf(op).map((param): [IRParam, string] => [param, locals.claim(goLocal(param.name))])
	const schema = op.success.schema
	const result = schema && goTypeOf(schema, position(env, op.id, "Response")).replace(/^\*/, "")
	const shape = shapeOf(op, result, env.throwOnError)
	const fields = optsFields(op, opts, env)
	const path = pathLines(op, pathLocals, shape.fail)
	const call = [
		`method: ${goString(op.method)}`,
		`path: ${path.path}`,
		`operation: ${goString(`${op.method} ${op.path}`)}`,
		"headers: map[string]string{}",
		...(body ? ["body: jsonBody(body)"] : []),
		`stale: ${receiver.client}.stale`,
		...(pathLocals.length > 0 ? ["params: params"] : []),
	]
	const params = ["ctx context.Context", ...pathLocals.map(([, local]) => `${local} string`), ...bodyParam]
	const lines = [
		...methodDoc(op, name),
		`func (r *${receiver.type}) ${name}(${[...params, `opts *${opts}`, "reqOpts ...RequestOption"].join(", ")}) ${shape.returns} {`,
		...path.lines,
		`\tc := &call{${call.join(", ")}}`,
		...(fields.length > 0 ? ["\tif opts != nil {", ...fields.map((field) => `\t\t${field.set}`), "\t}"] : []),
		...shape.tail(`ctx, ${receiver.client}.cfg, c, reqOpts`),
		"}",
	]
	return { call: callOf(op, name, pathLocals, fields), lines, opts, optsDecl: optsDecl(op, opts, fields) }
}
