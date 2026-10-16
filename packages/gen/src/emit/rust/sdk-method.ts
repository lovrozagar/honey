/**
 * One operation as a Rust method (G1, Fb1): `(&self, <path params as &str in path order>, <body>?, opts:
 * &<Op>Opts) -> Call<T[, <Op>Headers]>`. The method copies everything into the runtime's `RequestSpec` up
 * front (the body encoded at once) and hands it to `Call` with the run that reads its answer: JSON as its
 * type, none as `()`, text as `String`, binary as `Vec<u8>` (in safe mode each inside `SdkResult`), an SSE
 * stream as `EventStream<E>`, a WebSocket as `TypedWebSocket`, realtime as `Realtime<E>`. Spec text reaches
 * the source only through the shared escape layer.
 */
import type { IRBody, IRParam, IRSchema } from "../../ir/model.ts"
import { mediaEssence, type SdkBody, type SdkOp } from "../../ir/sdk-model.ts"
import { lineComment, rustString } from "../shared/escape.ts"
import { NameScope, rustTypeIdent, rustValueIdent } from "../shared/lang.ts"
import type { RustCallPlan } from "./sdk-plan.ts"
import {
	type OptsField,
	optsDecl,
	optsFields,
	optsLines,
	responseHeaders,
	type StreamOpts,
	takesIdempotencyKey,
} from "./sdk-opts.ts"
import { unboxed } from "./types-struct.ts"
import { type RustTypeContext, rustTypeOf } from "./types.ts"

/** One operation's method, its client.rs declarations by name (`<Op>Opts`, `<Op>Headers`), and its call plan less the accessors. */
export type RustMethod = {
	readonly plan: Omit<RustCallPlan, "accessors">
	readonly decls: readonly (readonly [string, string])[]
	readonly lines: readonly string[]
}

/** What every method of one SDK shares: the type context it hoists into, and the error mode. */
export type MethodEnv = { readonly at: RustTypeContext; readonly throwOnError: boolean }

/** How a method answers: the `Call`'s answer type, the run expression it is sent with, and its stream's fields. */
type Answer = { readonly type: string; readonly run: string; readonly stream: StreamOpts | null }

/* the method's own locals: a path param never shadows one (it is claimed as `…2`) */
const METHOD_LOCALS = ["body", "client", "opts", "spec"]

const isLastEventIdHeader = (param: string, where: OptsField["in"]) =>
	where === "header" && param.toLowerCase() === "last-event-id"
const isReconnectToken = (param: string, where: OptsField["in"]) => where === "query" && param === "reconnect_token"

const LAST_EVENT_ID = { ident: "last_event_id", type: "Option<String>" }
const RECONNECT_TOKEN = { ident: "reconnect_token", type: "Option<String>" }
const PROTOCOLS = { doc: "The subprotocols the dial offers.", ident: "protocols", type: "Vec<String>" }

/* Last-Event-ID, sent only when set: an empty header would still name a position */
const SSE: StreamOpts = {
	carries: isLastEventIdHeader,
	fields: [LAST_EVENT_ID],
	sends: ['spec.header("Last-Event-ID", &opts.last_event_id);'],
}

const WS: StreamOpts = {
	carries: isReconnectToken,
	fields: [RECONNECT_TOKEN, PROTOCOLS],
	sends: ['spec.query("reconnect_token", &opts.reconnect_token);'],
}

/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
const REALTIME: StreamOpts = {
	carries: (param, where) =>
		isReconnectToken(param, where) ||
		(where === "query" && param === "last_event_id") ||
		isLastEventIdHeader(param, where),
	fields: [
		LAST_EVENT_ID,
		RECONNECT_TOKEN,
		PROTOCOLS,
		{ doc: "Reconnects after a drop; 5 when None.", ident: "max_reconnect_attempts", type: "Option<u32>" },
		{
			doc: "The first backoff delay in milliseconds; 1000 when None.",
			ident: "reconnect_delay_ms",
			type: "Option<u64>",
		},
	],
	sends: [],
}

/* the realtime Opts' own fields, each the TransportOpts field of its name */
const TRANSPORT_OPTS =
	"TransportOpts { last_event_id: opts.last_event_id.clone(), reconnect_token: opts.reconnect_token.clone(), protocols: opts.protocols.clone(), max_reconnect_attempts: opts.max_reconnect_attempts, reconnect_delay_ms: opts.reconnect_delay_ms }"

/** `schema`'s Rust type at `<op><field>`, a component reference unboxed. */
const typeAt = (schema: IRSchema, op: SdkOp, field: string, at: RustTypeContext) =>
	unboxed(schema, rustTypeOf(schema, { ...at, fieldName: field, parentName: op.id }))

/** A streamed event's type: the operation's declared event schema, else `fallback`. */
const eventType = (op: SdkOp, at: RustTypeContext, fallback: string) =>
	op.events === undefined ? fallback : typeAt(op.events, op, "Event", at)

/** How a stream operation answers, in either error mode. */
function streamAnswer(op: SdkOp, at: RustTypeContext): Answer {
	if (op.stream === "sse") {
		const events = eventType(op, at, "String")
		const run = op.events === undefined ? "crate::events::text" : `crate::events::json::<${events}>`
		return { run, stream: SSE, type: `EventStream<${events}>` }
	}
	if (op.stream === "ws") return { run: "crate::ws::dial(opts.protocols.clone())", stream: WS, type: "TypedWebSocket" }
	const events = eventType(op, at, "serde_json::Value")
	const run = `crate::realtime_loop::connect::<${events}>(${TRANSPORT_OPTS})`
	return { run, stream: REALTIME, type: `Realtime<${events}>` }
}

/** How a method answers: a stream's way, else its answer's kind read in the SDK's error mode. */
function answerOf(op: SdkOp, env: MethodEnv): Answer {
	if (op.stream !== null) return streamAnswer(op, env.at)
	const { kind, schema } = op.success
	const [type, decoder] =
		kind === "text"
			? ["String", "text"]
			: kind === "binary"
				? ["Vec<u8>", "binary"]
				: schema === undefined
					? ["()", "none"]
					: [typeAt(schema, op, "Response", env.at), "json"]
	const generic = decoder === "json" ? `::<${type}>` : ""
	if (env.throwOnError) return { run: `crate::answer::${decoder}${generic}`, stream: null, type }
	return { run: `crate::answer::safe_${decoder}${generic}`, stream: null, type: `SdkResult<${type}>` }
}

/** The body parameter's type, and the statement encoding it into the spec. */
function bodyOf(op: SdkOp, body: SdkBody, at: RustTypeContext): { readonly type: string; readonly send: string } {
	const media = rustString(body.contentType)
	if (body.kind === "text") return { send: `spec.text(body, ${media});`, type: "&str" }
	if (body.kind === "binary") return { send: `spec.binary(body, ${media});`, type: "Body" }
	if (body.kind === "multipart") {
		const { schema } = op.ir.body as Extract<IRBody, { schema: IRSchema }>
		return { send: "spec.multipart(body);", type: `&${typeAt(schema, op, "Body", at)}` }
	}
	return { send: `spec.${body.kind}(body, ${media});`, type: `&${typeAt(body.schema, op, "Body", at)}` }
}

/** The operation's path params in the order the path holds them, whatever order they were declared in. */
function pathParamsOf(op: SdkOp): IRParam[] {
	const order = op.pathSegments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
	return [...op.pathParams].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
}

/** The method's rustdoc: its route, then the operation's summary and description. */
function methodDoc(op: SdkOp): string[] {
	const text = [`Sends \`${op.method} ${op.path}\`.`, op.summary, op.description].filter((part) => part !== "")
	return lineComment(text.join("\n\n"), "///", "    ")
}

/** The spec statements after the path: the asked media type, the Opts, the body, the targets a 2xx stales. */
function specLines(op: SdkOp, fields: readonly OptsField[], answer: Answer, body: string | undefined): string[] {
	const { contentType, kind } = op.success
	const accept = op.stream === null && (kind === "binary" || kind === "text")
	return [
		...(accept ? [`spec.accept(${rustString(mediaEssence(contentType as string))});`] : []),
		...optsLines(op, fields, answer.stream),
		...(body === undefined ? [] : [body]),
		...(op.invalidates.length > 0 ? [`spec.invalidates(&[${op.invalidates.map(rustString).join(", ")}]);`] : []),
	]
}

/** A method's parts once its names are claimed: its Opts type and fields, its path locals, its response headers. */
type Parts = {
	readonly op: SdkOp
	readonly name: string
	readonly opts: string
	readonly path: readonly (readonly [IRParam, string])[]
	readonly fields: readonly OptsField[]
	readonly headers: ReturnType<typeof responseHeaders>
}

/** The method's lines: its signature over `client`, the spec it fills, the `Call` it returns. */
function methodLines(parts: Parts, client: string, answer: Answer, body: ReturnType<typeof bodyOf> | undefined) {
	const { fields, headers, op, opts, path } = parts
	const empty = fields.length === 0 && answer.stream === null && !takesIdempotencyKey(op)
	const params = [
		"&self",
		...path.map(([, local]) => `${local}: &str`),
		...(body ? [`body: ${body.type}`] : []),
		`${empty ? "_opts" : "opts"}: &${opts}`,
	]
	const bound = path.map(([param, local]) => `(${rustString(param.name)}, ${local})`).join(", ")
	const statements = specLines(op, fields, answer, body?.send)
	const returns = headers ? `Call<${answer.type}, ${headers.plan.type}>` : `Call<${answer.type}>`
	return [
		...(params.length > 7 ? ["    #[allow(clippy::too_many_arguments)]"] : []),
		...methodDoc(op),
		`    pub fn ${parts.name}(${params.join(", ")}) -> ${returns} {`,
		`        let ${statements.length > 0 ? "mut " : ""}spec = crate::request::RequestSpec::new(${rustString(op.method)}, ${rustString(op.path)}, &[${bound}]);`,
		...statements.map((statement) => `        ${statement}`),
		`        Call::new(${client}, spec, ${answer.run})`,
		"    }",
	]
}

/** How the driver reaches the method, by the names this emitter gave it. */
function planOf({ fields, headers, name, op, opts, path }: Parts): RustMethod["plan"] {
	const by = (where: OptsField["in"]) =>
		Object.fromEntries(fields.filter((field) => field.in === where).map((field) => [field.param, field.ident]))
	return {
		body: op.body?.kind ?? null,
		headers: by("header"),
		idempotencyKey: takesIdempotencyKey(op) ? "idempotency_key" : null,
		method: name,
		operation: op.id,
		opts,
		pathParams: path.map(([param]) => param.name),
		query: by("query"),
		required: fields.filter((field) => field.bare).map((field) => field.ident),
		response: op.success.kind,
		responseHeaders: headers?.plan ?? null,
		stream: op.stream,
	}
}

/** The method of `op` named `name`, its client reached as `client` (`self`, `self.client`), and its `<Op>Opts` and `<Op>Headers`. */
export function rustMethod(op: SdkOp, name: string, client: string, env: MethodEnv): RustMethod {
	const opts = env.at.names.claim(`${rustTypeIdent(op.id)}Opts`)
	const locals = new NameScope(METHOD_LOCALS)
	const path = pathParamsOf(op).map((param) => [param, locals.claim(rustValueIdent(param.name))] as const)
	const body = op.body && bodyOf(op, op.body, env.at)
	const answer = answerOf(op, env)
	const fields = optsFields(op, opts, env.at, answer.stream)
	const parts = { fields, headers: responseHeaders(op, env.at), name, op, opts, path }
	const decls: [string, string][] = [[opts, optsDecl(op, opts, fields, answer.stream)]]
	if (parts.headers) decls.push([parts.headers.plan.type, parts.headers.decl])
	return { decls, lines: methodLines(parts, client, answer, body), plan: planOf(parts) }
}
