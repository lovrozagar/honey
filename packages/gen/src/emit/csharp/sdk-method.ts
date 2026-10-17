/**
 * One operation (§4.4, §4.8; contract 47 §2): its private `Operation` field (`Accept` for a text or binary answer,
 * `Invalidates` for its `x-invalidate` targets), its method, the types the JSON context must list for it, and its
 * call plan. A method takes its path params as `string` in path order, then a required body, the required query
 * and header params, an optional body, the optional ones, `idempotencyKey` on an idempotent op, `headersInto` where
 * the op declares response headers (Fc7), `options` and `cancellationToken` (C#4). Its body by kind is
 * sdk-body.ts's, its answer sdk-answer.ts's, `SdkResult` in safe mode (C#2); its body is one call into the
 * transport, the signature on one line and the call on the next (Fb8). A param named like one of the method's own
 * locals is `…2`, a keyword `@`-escaped (H52).
 */
import type { IRParam } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csIdentifier, NameScope } from "../shared/lang.ts"
import { type CsAnswer, type CsHeadersPlan, csAnswer, csResponseHeaders, signatureType } from "./sdk-answer.ts"
import { type CsBody, csBody } from "./sdk-body.ts"
import { methodDoc } from "./sdk-doc.ts"
import type { CSharpCallPlan } from "./sdk-plan.ts"
import { type CsTypeContext, csTypeOf } from "./types.ts"

/** What every method of one SDK shares: the type context and the error mode. */
export type MethodEnv = { readonly at: CsTypeContext; readonly throwOnError: boolean }

/** How a rendered method spells a type the context lists: its runtime type, and its `<Context>.Default.<Name>`. */
export type Spelling = { readonly runtime: (type: string) => string; readonly info: (type: string) => string }

/** One operation's method, once its names are claimed: its field, its lines, the types it needs listed, its plan. */
export type CsMethod = {
	readonly field: string
	readonly lines: (spell: Spelling) => string[]
	readonly types: readonly string[]
	readonly plan: Omit<CSharpCallPlan, "accessors">
}

/* the method's own parameters: a spec param that takes one of these names is claimed as `…2` */
export const METHOD_LOCALS = ["body", "cancellationToken", "headersInto", "idempotencyKey", "options"]

/** A declared query or header param: its identifier and its C# type (nullable when optional). */
type Param = {
	readonly param: IRParam
	readonly where: "header" | "query"
	readonly ident: string
	readonly type: string
}

/** A method's parts once its names are claimed and its types computed. */
type Parts = {
	readonly op: SdkOp
	readonly name: string
	readonly field: string
	readonly path: readonly { readonly param: IRParam; readonly ident: string }[]
	readonly params: readonly Param[]
	readonly body: CsBody
	readonly answer: CsAnswer
	/** the `<Op>Headers` holder; null when the op declares no response header */
	readonly headers: CsHeadersPlan | null
	readonly throwOnError: boolean
}

/** An identifier's metadata name: what reflection and named arguments see, `@` dropped. */
const bare = (ident: string) => ident.replace(/^@/, "")

/** `type` as a param left unset: nullable, once. */
const unset = (type: string) => `${type.replace(/\?$/, "")}?`

/** The path params in path order, whatever order they were declared in. */
function pathParamsOf(op: SdkOp): IRParam[] {
	const order = op.pathSegments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
	return [...op.pathParams].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
}

/** The query then header params, each in code-unit order and claimed in `scope`, each typed at the op. */
function paramsOf(op: SdkOp, scope: NameScope, at: CsTypeContext): Param[] {
	const headers = [...op.headers].sort((a, b) => compareCodeUnits(a.name, b.name))
	return [
		...op.query.map((param) => ({ param, where: "query" as const })),
		...headers.map((param) => ({ param, where: "header" as const })),
	].map(({ param, where }) => {
		const ident = scope.claim(csIdentifier(param.name))
		const type = csTypeOf(param.schema, { ...at, fieldName: param.name, parentName: op.id })
		return { ident, param, type: param.required === true ? type : unset(type), where }
	})
}

/** The parameter list, in C#4's order, the response-header holder after the idempotency key. */
function signature({ body, headers, op, params, path }: Parts, spell: Spelling): string[] {
	const required = op.body?.required === true
	const type = body.type
	return [
		...path.map(({ ident }) => `string ${ident}`),
		...(type !== null && required ? [`${signatureType(type, spell)} body`] : []),
		...params.filter((p) => p.param.required === true).map((p) => `${signatureType(p.type, spell)} ${p.ident}`),
		...(type !== null && !required ? [`${unset(signatureType(type, spell))} body = null`] : []),
		...params.filter((p) => p.param.required !== true).map((p) => `${signatureType(p.type, spell)} ${p.ident} = null`),
		...(op.idempotent ? ["string? idempotencyKey = null"] : []),
		...(headers === null ? [] : [`${headers.type}? headersInto = null`]),
		"RequestOptions? options = null",
		"CancellationToken cancellationToken = default",
	]
}

/**
 * The `Call` the method builds: path values, query and header args, the body, the idempotency key, the options,
 * and the holder's `Read` where the op declares response headers.
 */
function call({ body, headers, op, params, path }: Parts, spell: Spelling): string {
	const args = (where: Param["where"]) =>
		`[${params
			.filter((p) => p.where === where)
			.map(({ ident, param, type }) => `Arg.Of(${csString(param.name)}, ${ident}, ${spell.info(type)})`)
			.join(", ")}]`
	return [
		`[${path.map(({ ident }) => ident).join(", ")}]`,
		args("query"),
		args("header"),
		body.expr(spell),
		op.idempotent ? "idempotencyKey" : "null",
		"options",
		...(headers === null ? [] : ["headersInto is null ? null : headersInto.Read"]),
	].join(", ")
}

/** The method's lines: its docs, its signature, the one call into the transport. */
function methodLines(parts: Parts, spell: Spelling): string[] {
	const [returns, run] = parts.answer.render(spell)
	const read = parts.answer.type === null ? [] : [spell.info(parts.answer.type)]
	return [
		...methodDoc(parts.op, parts.throwOnError),
		`    public ${returns} ${parts.name}(${signature(parts, spell).join(", ")}) =>`,
		`        _t.${run}(${parts.field}, new(${call(parts, spell)}), ${[...read, "cancellationToken"].join(", ")});`,
	]
}

/** The plan the reflection driver walks: every name as reflection sees it (Fb10). */
function planOf({ body, headers, name, op, params, path, throwOnError }: Parts): Omit<CSharpCallPlan, "accessors"> {
	const by = (where: Param["where"]) =>
		Object.fromEntries(params.filter((p) => p.where === where).map(({ ident, param }) => [param.name, bare(ident)]))
	const required = [
		...path.map(({ ident }) => ident),
		...(body.type !== null && op.body?.required === true ? ["body"] : []),
		...params.filter((p) => p.param.required === true).map(({ ident }) => ident),
	]
	return {
		body: op.body === undefined ? null : { kind: op.body.kind, param: "body" },
		headers: by("header"),
		idempotencyKey: op.idempotent ? "idempotencyKey" : null,
		method: name,
		operation: op.id,
		path: path.map(({ ident, param }) => ({ name: param.name, param: bare(ident) })),
		query: by("query"),
		required: required.map(bare),
		response: op.success.kind,
		responseHeaders: headers,
		stream: op.stream,
		throws: throwOnError,
	}
}

/** The `Operation` field: method, path, path params, `Idempotent`, then `Accept` and `Invalidates` when they apply. */
function operationField(op: SdkOp, field: string, path: Parts["path"]): string {
	const accept = op.success.kind === "binary" || op.success.kind === "text" ? op.success.contentType : undefined
	const named = [
		`Idempotent: ${op.idempotent}`,
		...(accept === undefined ? [] : [`Accept: ${csString(accept)}`]),
		...(op.invalidates.length === 0 ? [] : [`Invalidates: [${op.invalidates.map(csString).join(", ")}]`]),
	]
	const params = path.map(({ param }) => csString(param.name)).join(", ")
	return `    private static readonly Operation ${field} = new(${csString(op.method)}, ${csString(op.path)}, [${params}], ${named.join(", ")});`
}

/** The method of the non-stream `op` named `name`, its `Operation` in the private field `field`. */
export function csMethod(op: SdkOp, name: string, field: string, env: MethodEnv): CsMethod {
	const scope = new NameScope(METHOD_LOCALS, bare)
	const path = pathParamsOf(op).map((param) => ({ ident: scope.claim(csIdentifier(param.name)), param }))
	const params = paramsOf(op, scope, env.at)
	const body = csBody(op, env)
	const answer = csAnswer(op, env)
	const headers = csResponseHeaders(op, env)?.plan ?? null
	const parts: Parts = { answer, body, field, headers, name, op, params, path, throwOnError: env.throwOnError }
	return {
		field: operationField(op, field, path),
		lines: (spell) => methodLines(parts, spell),
		plan: planOf(parts),
		types: [...params.map(({ type }) => type), ...body.types, ...(answer.type === null ? [] : [answer.type])],
	}
}
