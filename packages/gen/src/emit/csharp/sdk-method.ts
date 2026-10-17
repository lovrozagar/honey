/**
 * One operation (§4.4, §4.8): its private `Operation` field, its method, the types the JSON context must list for
 * it, and its call plan. A method takes its path params as `string` in path order, then a required body, the
 * required query and header params, an optional body, the optional ones, `idempotencyKey` on an idempotent op,
 * `options` and `cancellationToken` (C#4). It answers `Task<T>`, `Task` or `Task<string>`, or `SdkResult` in safe
 * mode (C#2); its body is one call into the transport, the signature on one line and the call on the next (Fb8).
 * A param named like one of the method's own locals is `…2`, a keyword `@`-escaped (H52).
 */
import type { IRParam, IRSchema } from "../../ir/model.ts"
import type { SdkBody, SdkOp } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csIdentifier, NameScope } from "../shared/lang.ts"
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
export const METHOD_LOCALS = ["body", "cancellationToken", "idempotencyKey", "options"]

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
	/** the body's C# type; null without a body */
	readonly body: string | null
	/** the JSON answer's C# type; null for any other answer */
	readonly answer: string | null
	readonly throwOnError: boolean
}

const UNKNOWN: IRSchema = { kind: "unknown" }

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

/** How an answer is typed and which transport method reads it, by its kind (`json?` a nullable one) and mode. */
const ANSWERS: Readonly<Record<string, Readonly<Record<"safe" | "thrown", (type: string) => [string, string]>>>> = {
	json: { safe: (t) => [`Task<SdkResult<${t}>>`, "ResultAsync"], thrown: (t) => [`Task<${t}>`, "CallAsync"] },
	"json?": {
		safe: (t) => [`Task<SdkResult<${t}>>`, "NullableResultAsync"],
		thrown: (t) => [`Task<${t}>`, "NullableAsync"],
	},
	none: { safe: () => ["Task<SdkResult>", "ResultAsync"], thrown: () => ["Task", "CallAsync"] },
	text: { safe: () => ["Task<SdkResult<string>>", "TextResultAsync"], thrown: () => ["Task<string>", "TextAsync"] },
}

/** A signature's spelling of `type`: its runtime type, keeping a nullable reference's `?` at the top. */
const signatureType = (type: string, spell: Spelling) =>
	`${spell.runtime(type).replace(/\?$/, "")}${type.endsWith("?") ? "?" : ""}`

/** The return type and the transport method: `T` typed as the signature spells it when thrown, as its runtime type in an SdkResult. */
function answered({ answer, op, throwOnError }: Parts, spell: Spelling): [string, string] {
	const kind = answer === null ? op.success.kind : `json${answer.endsWith("?") ? "?" : ""}`
	const mode = throwOnError ? "thrown" : "safe"
	const type = answer === null ? "" : throwOnError ? signatureType(answer, spell) : spell.runtime(answer)
	return (ANSWERS[kind] as (typeof ANSWERS)[string])[mode](type)
}

/** The parameter list, in C#4's order. */
function signature({ body, op, params, path }: Parts, spell: Spelling): string[] {
	const required = op.body?.required === true
	return [
		...path.map(({ ident }) => `string ${ident}`),
		...(body !== null && required ? [`${signatureType(body, spell)} body`] : []),
		...params.filter((p) => p.param.required === true).map((p) => `${signatureType(p.type, spell)} ${p.ident}`),
		...(body !== null && !required ? [`${unset(signatureType(body, spell))} body = null`] : []),
		...params.filter((p) => p.param.required !== true).map((p) => `${signatureType(p.type, spell)} ${p.ident} = null`),
		...(op.idempotent ? ["string? idempotencyKey = null"] : []),
		"RequestOptions? options = null",
		"CancellationToken cancellationToken = default",
	]
}

/** The `Call` the method builds: path values, query and header args, the body, the idempotency key, the options. */
function call({ body, op, params, path }: Parts, spell: Spelling): string {
	const args = (where: Param["where"]) =>
		`[${params
			.filter((p) => p.where === where)
			.map(({ ident, param, type }) => `Arg.Of(${csString(param.name)}, ${ident}, ${spell.info(type)})`)
			.join(", ")}]`
	return [
		`[${path.map(({ ident }) => ident).join(", ")}]`,
		args("query"),
		args("header"),
		body === null ? "null" : `Body.Json(body, ${spell.info(body)})`,
		op.idempotent ? "idempotencyKey" : "null",
		"options",
	].join(", ")
}

/** The method's lines: its docs, its signature, the one call into the transport. */
function methodLines(parts: Parts, spell: Spelling): string[] {
	const [returns, run] = answered(parts, spell)
	const read = parts.answer === null ? [] : [spell.info(parts.answer)]
	return [
		...methodDoc(parts.op, parts.throwOnError),
		`    public ${returns} ${parts.name}(${signature(parts, spell).join(", ")}) =>`,
		`        _t.${run}(${parts.field}, new(${call(parts, spell)}), ${[...read, "cancellationToken"].join(", ")});`,
	]
}

/** The plan the reflection driver walks: every name as reflection sees it (Fb10). */
function planOf({ body, name, op, params, path, throwOnError }: Parts): Omit<CSharpCallPlan, "accessors"> {
	const by = (where: Param["where"]) =>
		Object.fromEntries(params.filter((p) => p.where === where).map(({ ident, param }) => [param.name, bare(ident)]))
	const required = [
		...path.map(({ ident }) => ident),
		...(body !== null && op.body?.required === true ? ["body"] : []),
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
		stream: op.stream,
		throws: throwOnError,
	}
}

/** The method of the JSON-bodied, non-stream `op` named `name`, its `Operation` in the private field `field`. */
export function csMethod(op: SdkOp, name: string, field: string, env: MethodEnv): CsMethod {
	const typeAt = (schema: IRSchema, fieldName: string) => csTypeOf(schema, { ...env.at, fieldName, parentName: op.id })
	const scope = new NameScope(METHOD_LOCALS, bare)
	const path = pathParamsOf(op).map((param) => ({ ident: scope.claim(csIdentifier(param.name)), param }))
	const params = paramsOf(op, scope, env.at)
	const json = op.body as Extract<SdkBody, { kind: "json" }> | undefined
	const body = json === undefined ? null : typeAt(json.schema, "Body")
	const answer = op.success.kind === "json" ? typeAt(op.success.schema ?? UNKNOWN, "Response") : null
	const parts: Parts = { answer, body, field, name, op, params, path, throwOnError: env.throwOnError }
	const operation = `    private static readonly Operation ${field} = new(${csString(op.method)}, ${csString(op.path)}, [${path.map(({ param }) => csString(param.name)).join(", ")}], Idempotent: ${op.idempotent});`
	return {
		field: operation,
		lines: (spell) => methodLines(parts, spell),
		plan: planOf(parts),
		types: [...params.map(({ type }) => type), ...(body === null ? [] : [body]), ...(answer === null ? [] : [answer])],
	}
}
