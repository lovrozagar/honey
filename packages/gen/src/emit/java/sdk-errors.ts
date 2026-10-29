/**
 * The Java SDK's error classes and error keys (bit 16 phase c1, C4): one `ApiException` subclass per common status, an
 * `UnexpectedStatusException` for the rest, and the transport and decode errors, each a class of its own, all written
 * here so the runtime holds only the bases. `ErrorKey` declares a constant per key the API names (in an operation's
 * `x-honey-errors` or as an error response's envelope keys, in code-unit order of the key), and a key whose body is an
 * inline object gets a `<Key>Data` record, the type `decodeBody(Class)` reads its body into.
 */
import type { IRResponse, IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, isJsonMedia, type SdkModel } from "../../ir/sdk-model.ts"
import { javaString } from "../shared/escape.ts"
import { compareCodeUnits, javaTypeName, NameScope } from "../shared/lang.ts"
import type { JavaTypeContext } from "./models.ts"
import { declares, javaTopLevel } from "./models.ts"
import { docOf } from "./sdk-decl.ts"
import { sourceOf } from "./sdk-models.ts"

/** The classes one per common status, their statuses in ascending order. */
const STATUSES: readonly [number, string][] = [
	[400, "BadRequestException"],
	[401, "UnauthorizedException"],
	[403, "ForbiddenException"],
	[404, "NotFoundException"],
	[409, "ConflictException"],
	[422, "UnprocessableEntityException"],
	[429, "RateLimitException"],
	[500, "InternalServerException"],
	[502, "BadGatewayException"],
	[503, "ServiceUnavailableException"],
	[504, "GatewayTimeoutException"],
]

/** The non-status errors: their base class, and their constructor's parameters after the message. */
const OTHER: readonly { name: string; base: string; cause: boolean; doc: string }[] = [
	{ base: "HoneyException", cause: true, doc: "The call ran past its timeout.", name: "ApiTimeoutException" },
	{
		base: "HoneyException",
		cause: true,
		doc: "No answer: the connection failed or broke.",
		name: "ApiConnectionException",
	},
	{
		base: "HoneyException",
		cause: false,
		doc: "A path param that is empty, `.` or `..`: nothing is sent.",
		name: "PathParamException",
	},
	{
		base: "HoneyException",
		cause: false,
		doc: "A client or call configured in a way it cannot send.",
		name: "ConfigException",
	},
	{
		base: "SdkException",
		cause: true,
		doc: "An answer that does not decode as the declared type, or a 2xx past maxResponseBytes.",
		name: "DecodeException",
	},
	{
		base: "HoneyException",
		cause: true,
		doc: "A hook or the auth refresh threw; its error is the cause.",
		name: "HookException",
	},
]

/** One error class's lines: its doc, its class, its serial version, its package-private constructor and super call. */
/** One error class's shape: its name, doc and base, whether it takes a cause, and whether it takes a `Failure` or a message. */
type ClassShape = {
	readonly name: string
	readonly doc: string
	readonly base: string
	readonly cause: boolean
	readonly param: string
}

function classLines({ name, doc, base, cause, param }: ClassShape): string[] {
	const message = cause ? "message, cause" : "message, null"
	const args = param === "failure" ? "failure" : message
	return [
		docOf(doc, ""),
		`public final class ${name} extends ${base} {`,
		"  private static final long serialVersionUID = 1L;",
		"",
		`  ${name}(${param === "failure" ? "Failure failure" : "String message" + (cause ? ", Throwable cause" : "")}) {`,
		`    super(${args});`,
		"  }",
		"}",
	]
}

/** Every error class's file, by path, under `dir` in `packageName`, each behind `marker`. */
export function errorClassFiles(dir: string, packageName: string, marker: string): Record<string, string> {
	const statuses = STATUSES.map(
		([status, name]) =>
			[
				name,
				classLines({ base: "ApiException", cause: false, doc: `HTTP ${status}.`, name, param: "failure" }),
			] as const,
	)
	const unexpected = classLines({
		base: "ApiException",
		cause: false,
		doc: "Any other status outside 2xx, a redirect the call did not follow included.",
		name: "UnexpectedStatusException",
		param: "failure",
	})
	const others = OTHER.map(
		({ name, base, cause, doc }) => [name, classLines({ base, cause, doc, name, param: "message" })] as const,
	)
	return Object.fromEntries(
		[...statuses, ["UnexpectedStatusException", unexpected] as const, ...others].map(([name, lines]) => [
			`${dir}/${name}.java`,
			sourceOf(marker, packageName, lines.join("\n")),
		]),
	)
}

type Declared = [string, IRSchema | undefined]

/** Every key an error response's envelope names, over each operation's JSON error statuses. */
function envelopeKeys(model: SdkModel): string[] {
	return model.ops.flatMap((op) =>
		op.errorStatuses.flatMap((status) => {
			const { contentType, schema } = op.ir.responses[String(status)] as IRResponse
			if (schema === undefined || !isJsonMedia(contentType as string)) return []
			return irErrorEnvelope(schema, model.resolve)?.keys ?? []
		}),
	)
}

/** Every declared key in code-unit order, its schema if an operation gives one (the first spelling wins). */
function declaredKeys(model: SdkModel): Declared[] {
	const byId = [...model.ops].sort((a, b) => compareCodeUnits(a.id, b.id))
	const declared = byId.flatMap((op) => Object.entries(op.ir.extensions.errors ?? {}))
	const keys = new Map<string, IRSchema | undefined>([
		...envelopeKeys(model).map((key) => [key, undefined] as const),
		...declared.toReversed().map(([key, { schema }]) => [key, schema] as const),
	])
	return [...keys].sort(([a], [b]) => compareCodeUnits(a, b))
}

/** The `<Key>Data` record for a key's inline schema, declared into `ctx.decls`; undefined when the key has none to name. */
function dataType(
	key: string,
	schema: IRSchema | undefined,
	model: SdkModel,
	ctx: JavaTypeContext,
): string | undefined {
	if (schema === undefined || schema.kind === "ref") return undefined
	if (!declares(schema) || irErrorEnvelope(schema, model.resolve) !== null) return undefined
	const name = ctx.names.hoist(`error:${key}`, `${javaTypeName(key)}Data`)
	ctx.decls.set(name, "")
	ctx.decls.set(name, javaTopLevel(name, schema, ctx))
	return name
}

/**
 * The `ErrorKey` file for `model`, every `<Key>Data` hoisted into `ctx.decls`; an empty map when no key is declared.
 * Each constant is the key's PascalCase name, numbered on a collision, its value the key as the server spells it.
 */
export function errorKeyFiles(
	model: SdkModel,
	ctx: JavaTypeContext,
	target: { readonly dir: string; readonly packageName: string; readonly marker: string },
): Record<string, string> {
	const { dir, packageName, marker } = target
	const declared = declaredKeys(model)
	if (declared.length === 0) return {}
	const members = new NameScope([])
	const constants = declared.map(([wire, schema]) => {
		dataType(wire, schema, model, ctx)
		return { member: members.claim(javaTypeName(wire)), wire }
	})
	const lines = [
		docOf("The error keys the API declares: ApiException.key() is one of these, else the server's own string.", ""),
		"public final class ErrorKey {",
		...constants.map(({ member, wire }) => `  public static final String ${member} = ${javaString(wire)};`),
		"",
		"  private ErrorKey() {}",
		"}",
	]
	return { [`${dir}/ErrorKey.java`]: sourceOf(marker, packageName, lines.join("\n")) }
}
