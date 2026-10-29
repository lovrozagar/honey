/**
 * The Java SDK's safe mirror (bit 21 i6): `client.safe()` is a `Safe<Client>`, with a `Safe<Resource>` per resource
 * class, the same members as the class it mirrors; each method a twin restating every overload of the normal one. A
 * connection's twin is the very method, as every SDK's is; every other answers `Result<T>` (`Result<Void>` for none)
 * through `Answer.safe`, which runs the very method, so a twin never builds a call. Its class names are claimed once
 * every normal name is, so none moves.
 */
import type { IR } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { messageTypeOf } from "./realtime.ts"
import {
	accessor,
	assign,
	call,
	classHeader,
	type Declaration,
	exprStmt,
	finalField,
	lambda,
	methodHeader,
	newOf,
	param,
	returnStmt,
	statement,
} from "./layout.ts"
import { docOf, docParagraphs } from "./sdk-decl.ts"
import type { JavaHeaders } from "./sdk-headers.ts"
import { putFile } from "./sdk-models.ts"
import { answerOf, type OpEnv, paragraphsOf } from "./sdk-op.ts"
import { paramsName } from "./sdk-params.ts"
import {
	blocks,
	clientLines,
	membersOf,
	type Node,
	nodeOf,
	recordSource,
	resourceName,
	type SurfaceEnv,
} from "./sdk-client.ts"
import { eventTypeOf } from "./sse.ts"

/** The type the normal method answers: a stream's, a connection's, or the answer's (`void` for none). */
function returnsOf(op: SdkOp, env: OpEnv): string {
	if (op.stream === "sse") return `EventStream<${eventTypeOf(op, env.ctx)}>`
	if (op.stream === "ws") return "TypedWebSocket"
	if (op.stream === "realtime") return `ResumableConnection<${messageTypeOf(op, env.ctx)}>`
	return answerOf(op, env).type
}

/**
 * The widest twin's body: `Answer.<helper>(options, o -> _n.<name>(<args>, o))` returned, the normal method run on
 * the options with a raw box.
 */
const safeCall = (helper: string, name: string, args: readonly string[]): string[] =>
	statement(4, returnStmt(call("Answer", helper, ["options", lambda(["o"], call("_n", name, [...args, "o"]))])))

/**
 * The twin's lines on the safe mirror (bit 21 i6): each overload of the normal method restated. A connection's twin
 * is the very method (`return _n.<name>(…)`), as every SDK's is; every other answers `Result<T>` (`Result<Void>` for
 * none): its shorter overloads delegate as the normal ones do, its widest runs the normal method through
 * `Answer.safe` (`Answer.safeNone` for none), so the twin never builds a call of its own.
 */
function twinLines(op: SdkOp, name: string, headers: JavaHeaders | null, env: OpEnv): string[] {
	const params = paramsName(op, env.ctx)
	const returns = returnsOf(op, env)
	const doc = docParagraphs(paragraphsOf(op))
	const connection = op.stream === "ws" || op.stream === "realtime"
	const type = connection ? returns : `Result<${returns === "void" ? "Void" : returns}>`
	const signature = (args: readonly Declaration[]) =>
		methodHeader(2, { end: "{", modifiers: ["public"], name, params: args, returns: type })
	const method = (args: readonly Declaration[], body: readonly string[]) => [
		doc,
		...signature(args),
		...body,
		"  }",
		"",
	]
	const delegate = (of: string | null, args: readonly string[]) => statement(4, returnStmt(call(of, name, args)))
	const one = [param(params, "params")]
	const two = [...one, param("RequestOptions", "options")]
	if (connection)
		return [...method(one, delegate("_n", ["params"])), ...method(two, delegate("_n", ["params", "options"]))]
	const run = safeCall(
		returns === "void" ? "safeNone" : "safe",
		name,
		headers === null ? ["params"] : ["params", "headersInto"],
	)
	return [
		...method(one, delegate(null, headers === null ? ["params", "null"] : ["params", "null", "null"])),
		...method(two, headers === null ? run : delegate(null, ["params", "null", "options"])),
		...(headers === null
			? []
			: method([...one, param(headers.type, "headersInto"), param("RequestOptions", "options")], run)),
	]
}

/** The mirror class of a resource's `path`: `Safe<Resource>`, claimed once every normal name is (C#'s order). */
const mirrorName = (path: readonly string[], env: SurfaceEnv) =>
	env.ctx.names.hoist(`safe:${JSON.stringify(path)}`, `Safe${resourceName(path, env.ctx)}`)

/**
 * A mirror class's text: its doc naming the class it mirrors, the normal instance `_n` (`javaIdentifier` puts a `_`
 * first only before a digit, so no member is `_n`) when it has operations, its children's mirrors built from the
 * normal children, their accessors, and each operation's twin.
 */
function mirrorLines(node: Node, own: string, normal: string, env: SurfaceEnv): string[] {
	const { children, ops } = membersOf(node, env)
	const held = ops.length > 0
	return blocks([
		[
			docOf(
				`{@link ${normal}}'s safe mirror: each method answers a {@link Result}, an error status or an answer that does not decode its Err; no answer still throws.`,
				"",
			),
			...classHeader(own),
		],
		[
			...(held ? finalField(normal, "_n") : []),
			...children.flatMap(({ child, name }) => finalField(mirrorName(child.path, env), name)),
		],
		[
			...methodHeader(2, { end: "{", name: own, params: [param(normal, "_n")] }),
			...(held ? ["    this._n = _n;"] : []),
			...children.flatMap(({ child, name }) =>
				statement(4, exprStmt(assign(`this.${name}`, newOf(mirrorName(child.path, env), [call("_n", name)])))),
			),
			"  }",
		],
		...children.map(({ child, name }) => accessor(mirrorName(child.path, env), name)),
		...ops.map(({ name, op }) => twinLines(env.ops.get(op.plan.operation) as SdkOp, name, op.headers, env)),
	]).concat("}")
}

/**
 * The client and its safe mirror's files for `ir`, run once every normal name is claimed (the error keys' records
 * included), so a mirror class never takes a name a normal one would have had.
 */
export function mirrorOf(ir: IR, env: SurfaceEnv): Record<string, string> {
	const root = nodeOf(ir.tree, [])
	const files: Record<string, string> = {}
	const client = env.ctx.names.hoist("safe:client", `Safe${env.client}`)
	const walk = (node: Node) => {
		if (node.path.length > 0) {
			const own = mirrorName(node.path, env)
			putFile(files, `${own}.java`, recordSource(mirrorLines(node, own, resourceName(node.path, env.ctx), env), env))
		}
		for (const child of node.children) walk(child.node)
	}
	putFile(files, `${client}.java`, recordSource(mirrorLines(root, client, env.client, env), env))
	walk(root)
	putFile(files, `${env.client}.java`, recordSource(clientLines(ir, root, env, client), env))
	return files
}
