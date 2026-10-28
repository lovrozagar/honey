/**
 * One operation's Java text (bit 16 phase c1, C1, C3): its `Operation` constant, its two method overloads
 * `op(Params)` and `op(Params, RequestOptions)`, its call through the runtime's `Exchange`, and its plan. A throwing SDK
 * answers the type; a safe one (`throwOnError: false`) answers `Result<T>`. A body is sent by its declared media type:
 * JSON as the mapper writes it, a form urlencoded, text as its raw bytes, binary as sized bytes or a one-shot stream,
 * multipart as hand-built parts under a `honey-<uuid>` boundary.
 */
import type { IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { javaString } from "../shared/escape.ts"
import { snakeWords } from "../shared/lang.ts"
import { type JavaTypeContext, javaTypeOf } from "./models.ts"
import { assigned, docParagraphs, layout } from "./sdk-decl.ts"
import { type JavaHeaders, javaResponseHeaders } from "./sdk-headers.ts"
import { MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY, realtimeMethodLines } from "./realtime.ts"
import { CURSOR, sseMethodLines } from "./sse.ts"
import { PROTOCOLS, TOKEN, wsMethodLines } from "./ws.ts"
import { multipartRecordLines, paramsRecord } from "./sdk-record.ts"
import type { JavaCallPlan } from "./sdk-plan.ts"
import { type Field, fieldsOf, multipartRecord, paramsName } from "./sdk-params.ts"

/** What an operation's text needs: the type context its types hoist into, the array test, and the error mode. */
export type OpEnv = {
	readonly ctx: JavaTypeContext
	readonly isArray: (schema: IRSchema) => boolean
	readonly throwOnError: boolean
}

/** One operation's text and plan, before its accessors are known. */
export type JavaOp = {
	readonly plan: Omit<JavaCallPlan, "accessors">
	/** the `Operation` constant's name, in the class that calls it */
	readonly constant: string
	readonly constantLines: string[]
	/** the method's lines, both overloads */
	readonly lines: string[]
	/** the `<Op>Params` record's lines */
	readonly params: string[]
	/** the `<Op>Body` record's name and lines, for a multipart body; null otherwise */
	readonly body: { readonly name: string; readonly lines: string[] } | null
	/** the multipart helper's lines, for a multipart body; empty otherwise */
	readonly helper: string[]
	/** the `<Op>Headers` holder, for an operation whose 2xx responses declare headers; null otherwise */
	readonly headers: JavaHeaders | null
}

const UNKNOWN: IRSchema = { kind: "unknown" }

/** A method's javadoc paragraphs: the operation's id, then its summary and description, as the other SDKs carry them. */
const paragraphsOf = (op: SdkOp): string[] => [op.id, op.summary, op.description].filter((text) => text !== "")

/** The constant's name for a method: its words upper-cased, `_OPERATION` after them. */
export const constantOf = (method: string) => `${snakeWords(method).toUpperCase()}_OPERATION`

/** The answer's Java type, its reader and its safe reader, for each response kind. */
function answerOf(op: SdkOp, env: OpEnv) {
	const kind = op.success.kind
	if (kind === "json") {
		const schema = op.success.schema ?? UNKNOWN
		const type = javaTypeOf(schema, { ...env.ctx, fieldName: "Response", parentName: op.id })
		return {
			reader: `json(new TypeReference<${type}>() {})`,
			safe: `jsonResult(new TypeReference<${type}>() {})`,
			type,
		}
	}
	if (kind === "text") return { reader: "text()", safe: "textResult()", type: "String" }
	if (kind === "binary") return { reader: "bytes()", safe: "bytesResult()", type: "byte[]" }
	return { reader: "none()", safe: "noneResult()", type: "void" }
}

/** The `Accept` an operation asks for: a text or binary answer's media type. */
function acceptOf(op: SdkOp): string | undefined {
	if (op.stream === "sse") return "text/event-stream"
	const kind = op.success.kind
	return kind === "binary" || kind === "text" ? op.success.contentType : undefined
}

/** One body's expression over the params record's `body` component. */
function bodyExpr(op: SdkOp): string {
	const body = op.body
	if (body === undefined) return "null"
	if (body.kind === "json") return `Body.json(params.body(), ${javaString(body.contentType)})`
	if (body.kind === "form") return "Body.form(params.body())"
	if (body.kind === "text") return `Body.text(params.body(), ${javaString(body.contentType)})`
	if (body.kind === "binary") return `Body.binary(params.body(), ${javaString(body.contentType)})`
	return `multipart(params.body())`
}

/** The `multipart` helper of a multipart body: null without a body, else the parts, one per component, in order. */
function multipartHelper(op: SdkOp, env: OpEnv): string[] {
	const body = op.body
	if (body === undefined || body.kind !== "multipart") return []
	const { components, name } = multipartRecord(op, body.parts, env.ctx, env.isArray)
	const parts = components.map(({ field, name: part, type }) => {
		const value = `body.${field}()`
		if (type === "FilePart") return `Body.Part.file(${javaString(part)}, ${value})`
		if (type === "List<FilePart>") return `Body.Part.files(${javaString(part)}, ${value})`
		return `Body.Part.text(${javaString(part)}, ${value})`
	})
	return [
		`  private static Body multipart(${name} body) {`,
		"    if (body == null) {",
		"      return null;",
		"    }",
		...assigned("    ", "List<Body.Part> parts", { items: parts, prefix: "List.of(", suffix: ");" }),
		"    return Body.multipart(parts);",
		"  }",
		"",
	]
}

/** One query or header param's `Call.Arg`; the cursor's sends nothing when it is unset or empty. */
const arg = (f: Field) =>
	`Call.Arg.${f.where === "cursor" || f.where === "token" ? "cursor" : "of"}(${javaString(f.name)}, params.${f.field}())`

/** One `List<Call.Arg>` local of `items`, as its own statement. */
const list = (name: string, items: readonly string[]) =>
	assigned("    ", `List<Call.Arg> ${name}`, { items, prefix: "List.of(", suffix: ");" })

/** The lines that build the `Call`: its path array, its query and header lists, its body, each as its own statement. */
function callLines(fields: readonly Field[], op: SdkOp): string[] {
	const path = fields.filter((f) => f.where === "path").map((f) => `params.${f.field}()`)
	const query = fields.filter((f) => f.where === "query" || f.where === "token").map(arg)
	const headers = fields.filter((f) => f.where === "header" || f.where === "key" || f.where === "cursor").map(arg)
	return [
		`    String[] path = {${path.join(", ")}};`,
		...list("query", query),
		...list("headers", headers),
		...assigned("    ", "Body body", { items: [], prefix: bodyExpr(op), suffix: ";" }),
		...assigned("    ", "Call call", {
			items: ["path", "query", "headers", "body"],
			prefix: "new Call(",
			suffix: ");",
		}),
	]
}

/** One method's name, its fields, and the holder of its response headers when it declares any. */
type MethodSite = { readonly name: string; readonly fields: readonly Field[]; readonly headers: JavaHeaders | null }

/** A stream operation's method lines (SSE, WebSocket or realtime), each kind's own emitter; null for a plain call. */
function streamMethodLines(op: SdkOp, site: MethodSite, env: OpEnv): string[] | null {
	if (op.stream === null) return null
	const { fields, headers, name } = site
	const constant = constantOf(name)
	const params = paramsName(op, env.ctx)
	const call = callLines(fields, op)
	if (op.stream === "sse") return sseMethodLines(op, { call, constant, headers, name, params }, env.ctx)
	if (op.stream === "ws") return wsMethodLines(op, { call, constant, name, params })
	return realtimeMethodLines(op, { call, constant, name, params }, env.ctx)
}

/**
 * The method's lines: `op(params)` and `op(params, options)` for every operation. An operation with response headers
 * adds `op(params, headersInto, options)`, which fills `headersInto` from a 2xx before it reads the answer (null: none);
 * its two shorter overloads delegate to it.
 */
function methodLines(op: SdkOp, site: MethodSite, env: OpEnv): string[] {
	const streamed = streamMethodLines(op, site, env)
	if (streamed !== null) return streamed
	const { fields, headers, name } = site
	const constant = constantOf(name)
	const answer = answerOf(op, env)
	const safe = !env.throwOnError
	const isVoid = answer.type === "void" && !safe
	const returns = safe ? `Result<${answer.type === "void" ? "Void" : answer.type}>` : answer.type
	const params = paramsName(op, env.ctx)
	const reader = safe ? answer.safe : answer.reader
	const ret = isVoid ? "" : "return "
	const via = headers === null ? "" : ", null"
	const fill =
		headers === null
			? []
			: [
					"    if (headersInto != null && answer.error() == null) {",
					"      headersInto.read(answer.raw().headers());",
					"    }",
				]
	const body = [
		...callLines(fields, op),
		...assigned("    ", "Answer answer", {
			items: [constant, "call", "options"],
			prefix: "exchange.run(",
			suffix: ");",
		}),
		...fill,
		`    ${ret}answer.${reader};`,
	]
	const shorter = headers === null ? body : [`    ${ret}${name}(params, null, options);`]
	/* an overload's signature, broken as google-java-format breaks one past 100 columns */
	const signature = (args: readonly string[]) => layout(`public ${returns} ${name}(`, args, ") {", "  ")
	return [
		docParagraphs(paragraphsOf(op)),
		...signature([`${params} params`]),
		`    ${ret}${name}(params, null${via});`,
		"  }",
		"",
		docParagraphs(paragraphsOf(op)),
		...signature([`${params} params`, "RequestOptions options"]),
		...shorter,
		"  }",
		"",
		...(headers === null
			? []
			: [
					docParagraphs(paragraphsOf(op)),
					...signature([`${params} params`, `${headers.type} headersInto`, "RequestOptions options"]),
					...body,
					"  }",
					"",
				]),
	]
}

/** The `Operation` constant: the method, the path template, the path params in path order, accept and idempotence. */
function constantLines(op: SdkOp, constant: string): string[] {
	const names = op.pathSegments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
	const accept = acceptOf(op)
	const items = [
		javaString(op.method),
		javaString(op.path),
		`new String[] {${names.map((n) => javaString(n)).join(", ")}}`,
		accept === undefined ? "null" : javaString(accept),
		op.idempotent ? "true" : "false",
		...(op.invalidates.length === 0
			? []
			: [`new String[] {${op.invalidates.map((target) => javaString(target)).join(", ")}}`]),
	]
	return assigned("  ", `private static final Operation ${constant}`, { items, prefix: "new Operation(", suffix: ");" })
}

/**
 * A stream's own fields as the plan names them: SSE's cursor, a socket's protocols and token, a realtime op's five;
 * null where absent.
 */
const streamPlan = (fields: readonly Field[]) => {
	const field = (where: Field["where"]) => fields.find((f) => f.where === where)?.field ?? null
	const own = (name: string) => fields.find((f) => f.where === "realtime" && f.name === name)?.field ?? null
	return {
		lastEventId: field("cursor") ?? own(CURSOR),
		maxReconnectAttempts: own(MAX_RECONNECT_ATTEMPTS),
		protocols: field("protocols") ?? own(PROTOCOLS),
		reconnectDelay: own(RECONNECT_DELAY),
		reconnectToken: field("token") ?? own(TOKEN),
	}
}

/** One operation's text and plan, with its accessors left to the resource tree. */
export function javaOp(op: SdkOp, name: string, env: OpEnv): JavaOp {
	const fields = fieldsOf(op, env.ctx)
	const headers = javaResponseHeaders(op, env)
	const constant = constantOf(name)
	const multipart = op.body?.kind === "multipart" ? multipartRecord(op, op.body.parts, env.ctx, env.isArray) : null
	const plan: Omit<JavaCallPlan, "accessors"> = {
		body: op.body === undefined ? null : { kind: op.body.kind, param: "body" },
		headers: Object.fromEntries(fields.filter((f) => f.where === "header").map((f) => [f.name, f.field])),
		idempotencyKey: fields.find((f) => f.where === "key")?.field ?? null,
		...streamPlan(fields),
		method: name,
		operation: op.id,
		options: true,
		params: paramsName(op, env.ctx),
		path: fields.filter((f) => f.where === "path").map((f) => ({ name: f.name, param: f.field })),
		query: Object.fromEntries(fields.filter((f) => f.where === "query").map((f) => [f.name, f.field])),
		required: fields.filter((f) => f.required).map((f) => f.field),
		response: op.success.kind,
		responseHeaders: headers === null ? null : { fields: headers.fields, type: headers.type },
		stream: op.stream ?? null,
		throws: env.throwOnError,
	}
	return {
		body:
			multipart === null
				? null
				: { lines: multipartRecordLines(multipart.name, op.id, multipart.components), name: multipart.name },
		headers,
		helper: multipartHelper(op, env),
		constant,
		constantLines: constantLines(op, constant),
		lines: methodLines(op, { fields, headers, name }, env),
		params: paramsRecord(paramsName(op, env.ctx), op.id, fields),
		plan,
	}
}
