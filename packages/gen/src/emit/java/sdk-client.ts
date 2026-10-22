/**
 * The Java SDK's call surface (bit 16 phase c1, C3): the client with its builder, one `<Resource>` class per namespace of
 * `IR.tree` (`row.list` is `client.row().list(…)`), and an operation with no resource on the client itself. Every method
 * is an overload pair over its `<Op>Params` record and goes through the runtime's `Exchange`. Each operation's plan is
 * written here, with the names the classes use, so the driver walks these and nothing else.
 */
import type { IR, IRNamespace, IROperation } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { javaString } from "../shared/escape.ts"
import { javaIdentifier, javaTypeName, NameScope } from "../shared/lang.ts"
import { docOf } from "./sdk-decl.ts"
import { sourceOf } from "./sdk-models.ts"
import { type JavaOp, javaOp, type OpEnv } from "./sdk-op.ts"
import type { JavaCallPlan } from "./sdk-plan.ts"

/** What the surface is built from: the operations by id, the client's class, the marker and the package. */
export type SurfaceEnv = OpEnv & {
	readonly ops: ReadonlyMap<string, SdkOp>
	readonly client: string
	readonly marker: string
	readonly packageName: string
}

/** A namespace of the tree: its path, its children by segment, its operations by segment. */
type Node = {
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

/** The resource class of `path`: its words in PascalCase, then `Resource`. */
export const resourceName = (path: readonly string[]) => `${javaTypeName(path.join("."))}Resource`

function nodeOf(ns: IRNamespace, path: readonly string[]): Node {
	return {
		children: namespacesOf(ns).map(([segment, child]) => ({ node: nodeOf(child, [...path, segment]), segment })),
		methods: methodsOf(ns).map(([segment, op]) => ({ op, segment })),
		path,
	}
}

/** A node's members, claimed in one scope: each child's accessor name, each operation's method name. */
function membersOf(node: Node, env: SurfaceEnv) {
	const scope = new NameScope(RESERVED)
	const children = node.children.map(({ node: child, segment }) => ({
		child,
		name: scope.claim(javaIdentifier(segment)),
	}))
	const ops = node.methods.map(({ op, segment }) => {
		const name = scope.claim(javaIdentifier(segment))
		return { name, op: javaOp(env.ops.get(op.id) as SdkOp, name, env) }
	})
	return { children, ops }
}

/** A list of blocks, each set apart by one blank line; a block's own trailing blank lines are dropped. */
const blocks = (parts: readonly (readonly string[])[]): string[] =>
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

/** A resource class's text: its constants, its exchange and child fields, its constructor, accessors and methods. */
function resourceLines(node: Node, env: SurfaceEnv): string[] {
	const { children, ops } = membersOf(node, env)
	const own = (child: string) => resourceName([...node.path, child])
	const constants = ops.map(({ op }) => op.constantLines)
	return blocks([
		[docOf(`The ${node.path.join(".")} operations.`, ""), `public final class ${resourceName(node.path)} {`],
		constants.flat(),
		["  private final Exchange exchange;", ...children.map(({ name }) => `  private final ${own(name)} ${name};`)],
		[
			`  ${resourceName(node.path)}(Exchange exchange) {`,
			"    this.exchange = exchange;",
			...children.map(({ name }) => `    this.${name} = new ${own(name)}(exchange);`),
			"  }",
		],
		...children.map(({ name }) => [`  public ${own(name)} ${name}() {`, `    return ${name};`, "  }"]),
		...opBlocks(ops),
	]).concat("}")
}

/** A resource class's type name for the accessor `child`. */
const own = (child: string) => resourceName([child])

/** One builder setter: its doc, its signature, and the config call it makes. */
const setter = (name: string, type: string, call: string) => [
	`    /** Sets the ${name}. */`,
	`    public Builder ${name}(${type} ${name}) {`,
	`      config.${call}(${name});`,
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
]

/** The client: its constructor, its root resources, its ungrouped operations, and its builder. */
function clientLines(ir: IR, root: Node, env: SurfaceEnv): string[] {
	const { children, ops } = membersOf(root, env)
	const server = ir.servers[0]
	const defaults = [
		server === undefined ? "null" : javaString(server),
		javaString(ir.auth.headerName),
		javaString(ir.auth.prefix),
	]
	return blocks([
		[docOf("The client for the API. Build one with {@link #builder()}.", ""), `public final class ${env.client} {`],
		["  private final Exchange exchange;", ...children.map(({ name }) => `  private final ${own(name)} ${name};`)],
		ops.flatMap(({ op }) => op.constantLines),
		[
			`  private ${env.client}(ClientConfig config) {`,
			"    this.exchange = new Exchange(config);",
			...children.map(({ name }) => `    this.${name} = new ${own(name)}(exchange);`),
			"  }",
		],
		[
			"  /** A builder for a client; the base URL is required unless the API declares a server. */",
			"  public static Builder builder() {",
			"    return new Builder();",
			"  }",
		],
		...children.map(({ name }) => [`  public ${own(name)} ${name}() {`, `    return ${name};`, "  }"]),
		...opBlocks(ops),
		[
			`  /** Builds an {@link ${env.client}}. */`,
			"  public static final class Builder {",
			"    private final ClientConfig.Builder config;",
			"",
			"    private Builder() {",
			`      this.config = ClientConfig.builder(${defaults.join(", ")});`,
			"    }",
			"",
			...SETTERS.flatMap(([name, type]) => [...setter(name, type, name), ""]),
			`    /** Builds the client. */`,
			`    public ${env.client} build() {`,
			`      return new ${env.client}(config.build());`,
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
		out.files[`${op.plan.params}.java`] = recordSource(op.params, env)
		if (op.body !== null) out.files[`${op.plan.params.replace(/Params$/, "Body")}.java`] = recordSource(op.body, env)
	}
	for (const { child, name } of children) visit(child, [...accessors, name], env, out)
}

/** A file's text: the marker, the package, the imports its code spells, then its lines. */
function recordSource(lines: readonly string[], env: SurfaceEnv): string {
	return sourceOf(env.marker, env.packageName, trimmed(lines).join("\n"))
}

/** Every file of the call surface, and every operation's call plan, for `ir`. */
export function surfaceOf(ir: IR, env: SurfaceEnv): { files: Record<string, string>; plans: JavaCallPlan[] } {
	const root = nodeOf(ir.tree, [])
	const out: { files: Record<string, string>; plans: JavaCallPlan[] } = { files: {}, plans: [] }
	visit(root, [], env, out)
	const walk = (node: Node) => {
		if (node.path.length > 0) out.files[`${resourceName(node.path)}.java`] = recordSource(resourceLines(node, env), env)
		for (const child of node.children) walk(child.node)
	}
	walk(root)
	out.files[`${env.client}.java`] = recordSource(clientLines(ir, root, env), env)
	return out
}
