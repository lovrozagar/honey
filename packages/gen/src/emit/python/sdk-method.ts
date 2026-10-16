/**
 * One operation (G1, G3, G5): its `_<NAME>: Operation[T]` constant, its method on the resource classes (async
 * only for a stream), its `<Op>Headers` TypedDict, and its call plan. A method takes `self`, its path params as
 * `str` in path order, then its body, then keyword-only query and header params (a required one without a
 * default), `idempotency_key`, `headers_into`, its stream's own fields, and `options` last. The body is one
 * call into the transport, evaluating only `self` and module globals named `_<UPPER>`: no parameter can
 * shadow one (S3). Spec text reaches the source only through the shared escape layer.
 */
import type { IRParam } from "../../ir/model.ts"
import { mediaEssence, type SdkOp } from "../../ir/sdk-model.ts"
import { pyString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, pyIdentifier } from "../shared/lang.ts"
import { type Answer, answerOf, bodyType, responseHeaders, shapeOf, typeAt } from "./sdk-answer.ts"
import { methodDoc } from "./sdk-doc.ts"
import type { PythonCallPlan } from "./sdk-plan.ts"
import type { PyTypeContext } from "./types.ts"

/** What every method of one SDK shares: the client module's type context, the error mode, what it imports. */
export type MethodEnv = {
	readonly at: PyTypeContext & { readonly declTyping: Set<string> }
	readonly throwOnError: boolean
	readonly constants: NameScope
	/** the `collections.abc` and runtime names client.py imports */
	readonly imports: Set<string>
}

/**
 * One operation's constant, its methods (no sync one for a stream) written given the builtins its class's
 * earlier methods shadow, and its call plan less the accessors.
 */
export type PyMethod = {
	readonly name: string
	readonly constant: string
	readonly sync: ((shadowed: ReadonlySet<string>) => string[]) | null
	readonly async: (shadowed: ReadonlySet<string>) => string[]
	readonly plan: Omit<PythonCallPlan, "accessors">
}

/* the builtins an annotation may spell that a method may be named: a method so named shadows it below */
export const BUILTINS: readonly string[] = ["bool", "bytes", "dict", "float", "int", "list", "str", "tuple"]

/** `type` with each builtin `shadowed` names spelled `builtins.<name>`; strings inside it kept. */
function qualified(type: string, shadowed: ReadonlySet<string>, env: MethodEnv): string {
	return type.replace(/("(?:[^"\\]|\\.)*")|\b([a-z]+)\b/g, (whole, text: string | undefined, name: string) => {
		if (text !== undefined || !shadowed.has(name)) return whole
		env.imports.add("builtins")
		return `builtins.${name}`
	})
}

/* the method's own names: a parameter that takes one is claimed as `…2` */
const METHOD_LOCALS = ["self", "body", "options", "idempotency_key", "headers_into"]
const STREAM_LOCALS = ["last_event_id", "protocols", "reconnect_token"]

/* each stream's own fields, and the declared params its resume channels carry (Fd3) */
const STREAMS = {
	realtime: {
		carries: (name: string, where: string) =>
			(where === "query" && (name === "reconnect_token" || name === "last_event_id")) ||
			(where === "header" && name.toLowerCase() === "last-event-id"),
		fields: [
			"last_event_id: str | None = None",
			"reconnect_token: str | None = None",
			"protocols: Sequence[str] | None = None",
			"max_reconnect_attempts: int | None = None",
			"reconnect_delay_ms: int | None = None",
		],
	},
	sse: {
		carries: (name: string, where: string) => where === "header" && name.toLowerCase() === "last-event-id",
		fields: ["last_event_id: str | None = None"],
	},
	ws: {
		carries: (name: string, where: string) => where === "query" && name === "reconnect_token",
		fields: ["protocols: Sequence[str] | None = None", "reconnect_token: str | None = None"],
	},
} as const

/** A declared query or header param as a keyword. */
type Keyword = {
	readonly param: IRParam
	readonly where: "header" | "query"
	readonly ident: string
	readonly type: string
}

/** `type` as it may be left unset: as it is when it admits `None` already. */
const optional = (type: string) =>
	type === "Any" || type === "None" || type.endsWith(" | None") ? type : `${type} | None`

/** The path params in path order, whatever order they were declared in. */
function pathParamsOf(op: SdkOp): IRParam[] {
	const order = op.pathSegments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
	return [...op.pathParams].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
}

/** The query then header params as keywords, each claimed in `scope`; one a stream field carries has none. */
function keywordsOf(op: SdkOp, scope: NameScope, env: MethodEnv): Keyword[] {
	const headers = [...op.headers].sort((a, b) => compareCodeUnits(a.name, b.name))
	const carries = op.stream === null ? () => false : STREAMS[op.stream].carries
	return [
		...op.query.map((param) => ({ param, where: "query" as const })),
		...headers.map((param) => ({ param, where: "header" as const })),
	]
		.filter(({ param, where }) => !carries(param.name, where))
		.map(({ param, where }) => ({
			ident: scope.claim(pyIdentifier(param.name)),
			param,
			type: typeAt(op, param.name, param.schema, env),
			where,
		}))
}

/** `items` as a Python tuple. */
const tuple = (items: readonly string[]) => (items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`)

/** A method's parts once its names are claimed. */
type Parts = {
	readonly op: SdkOp
	readonly name: string
	readonly constant: string
	readonly path: readonly { readonly param: IRParam; readonly ident: string }[]
	readonly keywords: readonly Keyword[]
	readonly answer: Answer
	readonly headers: ReturnType<typeof responseHeaders>
}

/** How the runtime reads `op`'s answer: its stream's, else its success kind (`none` when it is typed `None`). */
function decodedAs(op: SdkOp, answer: Answer): string {
	if (op.stream === "sse") return op.events === undefined ? "text" : "json"
	return op.stream !== null || answer.type === "None" ? "none" : op.success.kind
}

/** The media type a call asks for: an event stream's, or a text or binary answer's. */
function acceptOf(op: SdkOp, kind: string): string | null {
	if (op.stream === "sse") return "text/event-stream"
	return kind === "text" || kind === "binary" ? mediaEssence(op.success.contentType as string) : null
}

/** The `Operation(…)` keywords that differ from its defaults, in its field order. */
function namedArgs(parts: Parts, env: MethodEnv): string[] {
	const { answer, headers, op } = parts
	const kind = decodedAs(op, answer)
	const accept = acceptOf(op, kind)
	const shape = shapeOf(op, env)
	const named: [string, string | null][] = [
		["body", op.body === undefined ? null : pyString(op.body.kind)],
		["content_type", op.body === undefined ? null : pyString(op.body.contentType)],
		["answer", kind === "json" ? null : pyString(kind)],
		["accept", accept === null ? null : pyString(accept)],
		["shape", shape === null ? null : pyString(shape)],
		["idempotent", op.idempotent && op.stream === null ? "True" : null],
		["invalidates", op.invalidates.length > 0 ? tuple(op.invalidates.map(pyString)) : null],
		["stream", op.stream === null ? null : pyString(op.stream)],
		["headers", headers === null ? null : tuple(headers.read)],
	]
	return named.flatMap(([key, value]) => (value === null ? [] : [`${key}=${value}`]))
}

/** `_<NAME>: Operation[T] = Operation(…)`, every argument but its defaults. */
function constantLine(parts: Parts, env: MethodEnv): string {
	const { op, path } = parts
	const params = path.length > 0 ? [tuple(path.map(({ param }) => pyString(param.name)))] : []
	const args = [pyString(op.method), pyString(op.path), ...params, ...namedArgs(parts, env)]
	return `${parts.constant}: Operation[${parts.answer.type}] = Operation(${args.join(", ")})`
}

/** The keywords sent `where`, as one dict argument; none without any. */
const dictArg = (keywords: readonly Keyword[], where: Keyword["where"]) => {
	const sent = keywords.filter((keyword) => keyword.where === where)
	const entries = sent.map(({ ident, param }) => `${pyString(param.name)}: ${ident}`)
	return sent.length > 0 ? [`${where === "query" ? "query" : "headers"}={${entries.join(", ")}}`] : []
}

/** The method's lines on one client: its signature, its docstring, the one call into the transport. */
function methodLines(parts: Parts, async: boolean, env: MethodEnv, shadowed: ReadonlySet<string>): string[] {
	const { answer, headers, keywords, op, path } = parts
	const body = bodyType(op, async, env)
	const required = op.body?.required === true
	const keyed = op.idempotent && op.stream === null
	const own = op.stream === null ? [] : STREAMS[op.stream].fields
	/* `name: type`, or `name: type = default`, its type qualified where an earlier method shadows a builtin */
	const param = (text: string) => {
		const [name, rest] = [text.slice(0, text.indexOf(": ")), text.slice(text.indexOf(": ") + 2)]
		const unset = rest.endsWith(" = None")
		return `${name}: ${qualified(unset ? rest.slice(0, -7) : rest, shadowed, env)}${unset ? " = None" : ""}`
	}
	const params = [
		"self",
		...[
			...path.map(({ ident }) => `${ident}: str`),
			...(body === null ? [] : [required ? `body: ${body}` : `body: ${optional(body)} = None`]),
		].map(param),
		"*",
		...[
			...keywords.map(({ ident, param: p, type }) =>
				p.required === true ? `${ident}: ${type}` : `${ident}: ${optional(type)} = None`,
			),
			...(keyed ? ["idempotency_key: str | None = None"] : []),
			...(headers === null ? [] : [`headers_into: ${headers.plan.type} | None = None`]),
			...own,
			"options: RequestOptions | None = None",
		].map(param),
	]
	const args = [
		parts.constant,
		...(path.length > 0 ? [`path=${tuple(path.map(({ ident }) => ident))}`] : []),
		...dictArg(keywords, "query"),
		...dictArg(keywords, "header"),
		...(body === null ? [] : ["body=body"]),
		...(keyed ? ["idempotency_key=idempotency_key"] : []),
		...(headers === null ? [] : ["headers_into=headers_into"]),
		...own.map((field) => field.slice(0, field.indexOf(":"))).map((field) => `${field}=${field}`),
		"options=options",
	]
	return [
		`    ${async ? "async " : ""}def ${parts.name}(${params.join(", ")}) -> ${qualified(answer.returns, shadowed, env)}:`,
		...methodDoc(op, env.throwOnError),
		`        return ${async ? "await " : ""}self._t.${answer.run}(${args.join(", ")})`,
	]
}

/** The runtime and `collections.abc` names `op`'s methods spell. */
function noteImports(op: SdkOp, answer: Answer, env: MethodEnv): void {
	const names = { realtime: "ResumableConnection", sse: "EventStream", ws: "TypedWebSocket" }
	if (op.stream !== null) env.imports.add(names[op.stream])
	if (op.stream === "ws" || op.stream === "realtime") env.imports.add("Sequence")
	if (answer.run === "result") env.imports.add("SDKResult")
}

/** The method of `op` named `name`: its constant, its sync method (none for a stream), its async one, its plan. */
export function pyMethod(op: SdkOp, name: string, env: MethodEnv): PyMethod {
	const scope = new NameScope([...METHOD_LOCALS, ...(op.stream === null ? [] : STREAM_LOCALS)])
	const path = pathParamsOf(op).map((param) => ({ ident: scope.claim(pyIdentifier(param.name)), param }))
	const keywords = keywordsOf(op, scope, env)
	const answer = answerOf(op, env)
	const constant = env.constants.claim(`_${pyIdentifier(op.id).toUpperCase()}`)
	const parts: Parts = { answer, constant, headers: responseHeaders(op, env), keywords, name, op, path }
	noteImports(op, answer, env)
	env.imports.add("Operation").add("RequestOptions")
	const by = (where: Keyword["where"]) =>
		Object.fromEntries(keywords.filter((k) => k.where === where).map(({ ident, param }) => [param.name, ident]))
	const plan = {
		body: op.body?.kind ?? null,
		headers: by("header"),
		idempotencyKey: op.idempotent && op.stream === null ? "idempotency_key" : null,
		method: name,
		operation: op.id,
		pathParams: path.map(({ param }) => param.name),
		query: by("query"),
		required: keywords.filter(({ param }) => param.required === true).map(({ ident }) => ident),
		response: op.success.kind,
		responseHeaders: parts.headers?.plan ?? null,
		stream: op.stream,
		sync: op.stream === null,
	}
	const sync = op.stream === null ? (shadowed: ReadonlySet<string>) => methodLines(parts, false, env, shadowed) : null
	const async = (shadowed: ReadonlySet<string>) => methodLines(parts, true, env, shadowed)
	return { async, constant: constantLine(parts, env), name, plan, sync }
}
