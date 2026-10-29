/**
 * The Java SDK's call surface (bit 16 phase c1, C3): the client with its builder, one `<Resource>` class per namespace of
 * `IR.tree` (`row.list` is `client.row().list(…)`), and an operation with no resource on the client itself. Every method
 * is an overload pair over its `<Op>Params` record and goes through the runtime's `Exchange`. Each operation's plan is
 * written here, with the names the classes use, so the driver walks these and nothing else. The client's `safe()`
 * mirror (bit 21 i6) is sdk-mirror.ts's; at the root a member spelled `safe` is `safe_`, noticed.
 */
import type { IR, IRNamespace, IROperation } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { javaString } from "../shared/escape.ts"
import { javaIdentifier, javaTypeName, NameScope } from "../shared/lang.ts"
import { MIRROR, mirrorNotice } from "../shared/mirror.ts"
import type { JavaTypeContext } from "./models.ts"
import {
	accessor,
	assign,
	call,
	classHeader,
	exprStmt,
	finalField,
	methodHeader,
	newOf,
	returnStmt,
	statement,
} from "./layout.ts"
import { docOf } from "./sdk-decl.ts"
import { putFile, sourceOf } from "./sdk-models.ts"
import { type JavaOp, javaOp, type OpEnv } from "./sdk-op.ts"
import type { JavaCallPlan } from "./sdk-plan.ts"

/**
 * What the surface is built from: the operations by id, the client's class, the marker and the package, and the
 * notices the generation reports (a root member renamed for the mirror).
 */
export type SurfaceEnv = OpEnv & {
	readonly ops: ReadonlyMap<string, SdkOp>
	readonly client: string
	readonly marker: string
	readonly packageName: string
	readonly notices: string[]
}

/** A namespace of the tree: its path, its children by segment, its operations by segment. */
export type Node = {
	readonly path: readonly string[]
	readonly children: readonly { readonly segment: string; readonly node: Node }[]
	readonly methods: readonly { readonly segment: string; readonly op: IROperation }[]
}

/** The names a class inherits from Object or the builder, which an accessor or an operation may not take. */
const RESERVED = [
	"builder",
	"clone",
	"equals",
	"finalize",
	"getClass",
	"hashCode",
	"notify",
	"notifyAll",
	"toString",
	"wait",
]

/**
 * The resource class of `path`: its words in PascalCase, then `Resource`, claimed from the model scope after the
 * components (C#'s order), so a component spelled the same keeps its name and this one is `…2`; one path, one name.
 */
export const resourceName = (path: readonly string[], ctx: JavaTypeContext) =>
	ctx.names.hoist(`resource:${JSON.stringify(path)}`, `${javaTypeName(path.join("."))}Resource`)

export function nodeOf(ns: IRNamespace, path: readonly string[]): Node {
	return {
		children: namespacesOf(ns).map(([segment, child]) => ({ node: nodeOf(child, [...path, segment]), segment })),
		methods: methodsOf(ns).map(([segment, op]) => ({ op, segment })),
		path,
	}
}

/**
 * A node's members, claimed in one scope: each child's accessor name, each operation's method name. At the root the
 * mirror's `safe` is held, so a member spelled `safe` is `safe_` instead, and noticed (shared/mirror.ts's one rule).
 */
export function membersOf(node: Node, env: SurfaceEnv) {
	const root = node.path.length === 0
	const scope = new NameScope(root ? [...RESERVED, MIRROR] : RESERVED)
	const claim = (segment: string) => {
		const name = javaIdentifier(segment)
		if (!root || name !== MIRROR) return scope.claim(name)
		const renamed = scope.claim(`${MIRROR}_`)
		env.notices.push(mirrorNotice("java", MIRROR, name, renamed) as string)
		return renamed
	}
	const children = node.children.map(({ node: child, segment }) => ({ child, name: claim(segment) }))
	const ops = node.methods.map(({ op, segment }) => {
		const name = claim(segment)
		return { name, op: javaOp(env.ops.get(op.id) as SdkOp, name, env) }
	})
	return { children, ops }
}

/** A list of blocks, each set apart by one blank line; a block's own trailing blank lines are dropped. */
export const blocks = (parts: readonly (readonly string[])[]): string[] =>
	parts
		.map(trimmed)
		.filter((part) => part.length > 0)
		.flatMap((part, i) => (i === 0 ? part : ["", ...part]))

/** The lines without their leading and trailing blank lines. */
function trimmed(lines: readonly string[]): string[] {
	const text = lines.join("\n").replace(/^(?:\n)+|(?:\n)+$/g, "")
	return text === "" ? [] : text.split("\n")
}

/** The operations' constants and methods of a class, each block set apart. */
const opBlocks = (ops: readonly { readonly op: JavaOp }[]): string[][] =>
	ops.map(({ op }) => [...op.lines, ...op.helper])

/** A child node's resource class name, by its path: the name its own file declares. */
const own = (child: Node, env: SurfaceEnv) => resourceName(child.path, env.ctx)

/** `this.name = new Type(args);` in a constructor. */
const constructed = (name: string, type: string, args: readonly string[]) =>
	statement(4, exprStmt(assign(`this.${name}`, newOf(type, args))))

/** A resource class's text: its constants, its exchange and child fields, its constructor, accessors and methods. */
function resourceLines(node: Node, env: SurfaceEnv): string[] {
	const { children, ops } = membersOf(node, env)
	const constants = ops.map(({ op }) => op.constantLines)
	return blocks([
		[docOf(`The ${node.path.join(".")} operations.`, ""), ...classHeader(resourceName(node.path, env.ctx))],
		constants.flat(),
		["  private final Exchange exchange;", ...children.flatMap(({ child, name }) => finalField(own(child, env), name))],
		[
			...methodHeader(2, {
				end: "{",
				name: resourceName(node.path, env.ctx),
				params: [{ name: "exchange", type: "Exchange" }],
			}),
			"    this.exchange = exchange;",
			...children.flatMap(({ child, name }) => constructed(name, own(child, env), ["exchange"])),
			"  }",
		],
		...children.map(({ child, name }) => accessor(own(child, env), name)),
		...opBlocks(ops),
	]).concat("}")
}

/** One builder setter: its doc, its signature, and the config call it makes. */
const setter = (name: string, type: string, method: string) => [
	`    /** Sets the ${name}. */`,
	`    public Builder ${name}(${type} ${name}) {`,
	`      config.${method}(${name});`,
	"      return this;",
	"    }",
]

/** The builder's setters, by name, type and the config call each makes. */
const SETTERS: readonly (readonly [string, string])[] = [
	["baseUrl", "String"],
	["bearerToken", "String"],
	["apiKey", "String"],
	["authHeaderName", "String"],
	["authHeaderPrefix", "String"],
	["headers", "Map<String, String>"],
	["timeout", "Duration"],
	["onRequest", "RequestHook"],
	["onResponse", "ResponseHook"],
	["onAuthExpired", "Supplier<String>"],
	["onLog", "Consumer<LogEntry>"],
	["redirect", "RedirectPolicy"],
	["maxResponseBytes", "long"],
	["invalidation", "InvalidationConfig"],
]

/** The client: its constructor, its root resources, its safe mirror, its ungrouped operations, and its builder. */
export function clientLines(ir: IR, root: Node, env: SurfaceEnv, mirror: string): string[] {
	const { children, ops } = membersOf(root, env)
	const server = ir.servers[0]
	const defaults = [
		server === undefined ? "null" : javaString(server),
		javaString(ir.auth.headerName),
		javaString(ir.auth.prefix),
	]
	return blocks([
		[docOf("The client for the API. Build one with {@link #builder()}.", ""), ...classHeader(env.client)],
		[
			"  private final Exchange exchange;",
			...children.flatMap(({ child, name }) => finalField(own(child, env), name)),
			...finalField(mirror, "safe"),
		],
		ops.flatMap(({ op }) => op.constantLines),
		[
			...methodHeader(2, {
				end: "{",
				modifiers: ["private"],
				name: env.client,
				params: [{ name: "config", type: "ClientConfig" }],
			}),
			"    this.exchange = new Exchange(config);",
			...children.flatMap(({ child, name }) => constructed(name, own(child, env), ["exchange"])),
			...constructed("safe", mirror, ["this"]),
			"  }",
		],
		[
			"  /** A builder for a client; the base URL is required unless the API declares a server. */",
			"  public static Builder builder() {",
			"    return new Builder();",
			"  }",
		],
		...children.map(({ child, name }) => accessor(own(child, env), name)),
		[
			"  /** The safe mirror: the same calls, each answering a {@link Result}; no answer still throws. */",
			...accessor(mirror, "safe"),
		],
		...opBlocks(ops),
		[
			`  /** Builds an {@link ${env.client}}. */`,
			"  public static final class Builder {",
			"    private final ClientConfig.Builder config;",
			"",
			"    private Builder() {",
			...statement(6, exprStmt(assign("this.config", call("ClientConfig", "builder", defaults)))),
			"    }",
			"",
			...SETTERS.flatMap(([name, type]) => [...setter(name, type, name), ""]),
			`    /** Builds the client. */`,
			...methodHeader(4, { end: "{", modifiers: ["public"], name: "build", params: [], returns: env.client }),
			...statement(6, returnStmt(newOf(env.client, [call("config", "build")]))),
			"    }",
			"  }",
		],
	]).concat("}")
}

/** The root's operations' plans, and their record files, reached through `accessors`, depth first. */
function visit(
	node: Node,
	accessors: readonly string[],
	env: SurfaceEnv,
	out: { files: Record<string, string>; plans: JavaCallPlan[] },
) {
	const { children, ops } = membersOf(node, env)
	for (const { name, op } of ops) {
		out.plans.push({ ...op.plan, accessors, method: name })
		putFile(out.files, `${op.plan.params}.java`, recordSource(op.params, env))
		if (op.headers !== null) putFile(out.files, `${op.headers.type}.java`, recordSource(op.headers.lines, env))
		if (op.body !== null) putFile(out.files, `${op.body.name}.java`, recordSource(op.body.lines, env))
	}
	for (const { child, name } of children) visit(child, [...accessors, name], env, out)
}

/** A file's text: the marker, the package, the imports its code spells, then its lines. */
export function recordSource(lines: readonly string[], env: SurfaceEnv): string {
	return sourceOf(env.marker, env.packageName, trimmed(lines).join("\n"))
}

/** Every resource and record file of the call surface, and every operation's call plan, for `ir`. */
export function surfaceOf(ir: IR, env: SurfaceEnv): { files: Record<string, string>; plans: JavaCallPlan[] } {
	const root = nodeOf(ir.tree, [])
	const out: { files: Record<string, string>; plans: JavaCallPlan[] } = { files: {}, plans: [] }
	visit(root, [], env, out)
	const walk = (node: Node) => {
		if (node.path.length > 0)
			putFile(out.files, `${resourceName(node.path, env.ctx)}.java`, recordSource(resourceLines(node, env), env))
		for (const child of node.children) walk(child.node)
	}
	walk(root)
	return out
}
