/**
 * client.go's body (G1): `Client` with one field per top-level namespace of `IR.tree`, a
 * `<Path>Resource` struct per nested namespace, every operation a method on the struct of its
 * namespace, `NewClient` wiring them, and each method's `<Op>Opts` after them in name order.
 */
import type { IR, IRNamespace } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { compareCodeUnits, goExported, NameScope } from "../shared/lang.ts"
import { type GoMethod, type GoMethodCall, goMethod, type MethodEnv } from "./sdk-method.ts"

/** A namespace as Go: its struct, its child namespaces by field name, its methods. */
type Resource = {
	readonly struct: string
	readonly path: readonly string[]
	readonly fields: readonly { readonly name: string; readonly node: Resource }[]
	readonly methods: readonly GoMethod[]
}

/** A method's call plan (G8.4): how to reach it, starting from the client's resource fields. */
export type GoCallPlan = GoMethodCall & {
	/** the resource fields from the client to the method's receiver: `["Users", "Profile"]` */
	readonly members: readonly string[]
}

/** The method env, and the operations by id. */
export type ClientEnv = MethodEnv & { readonly ops: ReadonlyMap<string, SdkOp> }

/** `ns` at `path` as the struct `struct`: its child namespaces first, so a method never takes a field's name. */
function resourceOf(ns: IRNamespace, path: readonly string[], struct: string, env: ClientEnv): Resource {
	const members = new NameScope()
	const receiver = { client: path.length === 0 ? "r" : "r.client", type: struct }
	const fields = namespacesOf(ns).map(([segment, child]) => {
		const name = members.claim(goExported(segment))
		const childPath = [...path, segment]
		const childStruct = env.at.names.claimConst(`${childPath.map(goExported).join("")}Resource`)
		return { name, node: resourceOf(child, childPath, childStruct, env) }
	})
	const methods = methodsOf(ns).map(([segment, op]) =>
		goMethod(env.ops.get(op.id) as SdkOp, members.claim(goExported(segment)), receiver, env),
	)
	return { fields, methods, path, struct }
}

/** `type <struct> struct { … }` with its own unexported fields, then a field per child namespace. */
function structDecl(node: Resource, own: readonly string[]): string[] {
	return [
		`type ${node.struct} struct {`,
		...own.map((field) => `\t${field}`),
		...node.fields.map(({ name, node: child }) => `\t${name} *${child.struct}`),
		"}",
	]
}

/** Each namespace below the client: its struct, its methods, then its children's. */
function resourceLines(node: Resource): string[] {
	return [
		...lineComment(`${node.struct} groups the ${node.path.join(".")} operations.`, "//"),
		...structDecl(node, ["client *Client"]),
		...node.methods.flatMap((method) => ["", ...method.lines]),
		...node.fields.flatMap(({ node: child }) => ["", ...resourceLines(child)]),
	]
}

/** `r.<chain><Field> = &<Struct>{client: r}` for every namespace below `node`, parents first. */
function wiring(node: Resource, chain: string): string[] {
	return node.fields.flatMap(({ name, node: child }) => [
		`\tr.${chain}${name} = &${child.struct}{client: r}`,
		...wiring(child, `${chain}${name}.`),
	])
}

/** NewClient: the BaseURL default (the document's first server; without one an empty BaseURL panics), auth, wiring. */
function newClient(root: Resource, ir: IR): string[] {
	const server = ir.servers[0]
	const [doc, fallback] =
		server === undefined
			? [
					"Config.BaseURL is required: the API declares no server.",
					`panic(${goString("honey: Config.BaseURL is empty and the API declares no server")})`,
				]
			: [`An empty Config.BaseURL defaults to the API's first server, ${server}.`, `cfg.BaseURL = ${goString(server)}`]
	return [
		...lineComment(`NewClient returns a client for cfg. ${doc}`, "//"),
		"func NewClient(cfg Config) *Client {",
		'\tif cfg.BaseURL == "" {',
		`\t\t${fallback}`,
		"\t}",
		'\tif cfg.AuthHeaderName == "" {',
		`\t\tcfg.AuthHeaderName = ${goString(ir.auth.headerName)}`,
		"\t}",
		'\tif cfg.AuthHeaderPrefix == "" {',
		`\t\tcfg.AuthHeaderPrefix = ${goString(ir.auth.prefix)}`,
		"\t}",
		"\tcfg = prepareConfig(cfg)",
		"\tr := &Client{cfg: cfg, stale: NewStaleTracker(cfg.Invalidation)}",
		...wiring(root, ""),
		"\treturn r",
		"}",
	]
}

/** Every method in the tree, depth first. */
const methodsIn = (node: Resource): GoMethod[] => [
	...node.methods,
	...node.fields.flatMap(({ node: child }) => methodsIn(child)),
]

/** Every method's call plan below `node`, reached through `members`, depth first. */
const plansIn = (node: Resource, members: readonly string[]): GoCallPlan[] => [
	...node.methods.map((method) => ({ ...method.call, members })),
	...node.fields.flatMap(({ name, node: child }) => plansIn(child, [...members, name])),
]

/** client.go's declarations for `ir` (the client, its resources and methods, then every `<Op>Opts`), and every method's call plan. */
export function clientDecls(ir: IR, env: ClientEnv): { readonly decls: string; readonly plans: GoCallPlan[] } {
	const root = resourceOf(ir.tree, [], "Client", env)
	const opts = methodsIn(root)
		.sort((a, b) => compareCodeUnits(a.opts, b.opts))
		.map((method) => method.optsDecl)
	const decls = [
		"// Client is the API's client: a field per resource namespace, a method per operation at the root.",
		...structDecl(root, ["cfg Config", "stale *StaleTracker"]),
		"",
		...newClient(root, ir),
		...root.methods.flatMap((method) => ["", ...method.lines]),
		...root.fields.flatMap(({ node }) => ["", ...resourceLines(node)]),
		...opts.flatMap((decl) => ["", decl]),
	].join("\n")
	return { decls, plans: plansIn(root, []) }
}
