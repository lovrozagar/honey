/**
 * client.go's body (G1): `Client` with one field per top-level namespace of `IR.tree`, a
 * `<Path>Resource` struct per nested namespace, every operation a method on the struct of its
 * namespace, `NewClient` wiring them, and each method's `<Op>Opts` and `<Op>Headers` after them in
 * name order. `Client.Safe()` (bit 21 i3) is the safe mirror (sdk-mirror.ts): `SafeClient` and a
 * `Safe<Path>Resource` per struct, claimed after every normal name so none moves, wired in NewClient. A root
 * member spelled `Safe` is emitted as `Safe_`, and noticed.
 */
import type { IR, IRAuth, IRNamespace } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { compareCodeUnits, goExported, NameScope } from "../shared/lang.ts"
import { MIRROR, mirrorNotice } from "../shared/mirror.ts"
import { type GoMethod, type GoMethodCall, goMethod, type MethodEnv } from "./sdk-method.ts"
import { twinLines, twinLiteral, type TwinType, twinTypeLines, twinTypes } from "./sdk-mirror.ts"

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

/** The method env, the operations by id, and the notices the generation reports (a root member renamed for the mirror). */
export type ClientEnv = MethodEnv & { readonly ops: ReadonlyMap<string, SdkOp>; readonly notices: string[] }

/* the mirror as Go spells it, Client's method: goExported(MIRROR) */
const SAFE = "Safe"

/**
 * A member's name in `members`, `segment` exported; at the root (`path` empty) one spelled like the mirror is
 * `Safe_` instead (shared/mirror.ts), and noticed.
 */
function memberName(segment: string, path: readonly string[], members: NameScope, env: ClientEnv): string {
	const name = goExported(segment)
	if (path.length > 0 || name !== SAFE) return members.claim(name)
	const renamed = members.claim(`${SAFE}_`)
	env.notices.push(mirrorNotice("go", SAFE, name, renamed) as string)
	return renamed
}

/** `ns` at `path` as the struct `struct`: its child namespaces first, so a method never takes a field's name. */
function resourceOf(ns: IRNamespace, path: readonly string[], struct: string, env: ClientEnv): Resource {
	const members = new NameScope(path.length === 0 ? [SAFE] : [])
	const receiver = { client: path.length === 0 ? "r" : "r.client", type: struct }
	const fields = namespacesOf(ns).map(([segment, child]) => {
		const name = memberName(segment, path, members, env)
		const childPath = [...path, segment]
		const childStruct = env.at.names.claimConst(`${childPath.map(goExported).join("")}Resource`)
		return { name, node: resourceOf(child, childPath, childStruct, env) }
	})
	const methods = methodsOf(ns).map(([segment, op]) =>
		goMethod(env.ops.get(op.id) as SdkOp, memberName(segment, path, members, env), receiver, env),
	)
	return { fields, methods, path, struct }
}

/** `type <struct> struct { … }` with its own unexported fields, then a field per child namespace (of `struct`). */
function structDecl(node: Resource, own: readonly string[], struct = (n: Resource) => n.struct): string[] {
	return [
		`type ${struct(node)} struct {`,
		...own.map((field) => `\t${field}`),
		...node.fields.map(({ name, node: child }) => `\t${name} *${struct(child)}`),
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

/** Each struct's safe twin by its struct: `SafeClient` for the client, `Safe<Struct>` claimed for the rest. */
function twinNames(node: Resource, env: ClientEnv, names = new Map<Resource, string>()): Map<Resource, string> {
	names.set(node, node.path.length === 0 ? `${SAFE}Client` : env.at.names.claimConst(`${SAFE}${node.struct}`))
	for (const { node: child } of node.fields) twinNames(child, env, names)
	return names
}

/** How `wiring` writes one tree: the field holding its root, and each node's literal by its normal chain. */
type Wired = { readonly at: string; readonly literal: (node: Resource, chain: string) => string }

/** `r.<at><chain><Field> = <literal>` for every namespace below `node`, parents first. */
function wiring(node: Resource, chain: string, wired: Wired): string[] {
	return node.fields.flatMap(({ name, node: child }) => [
		`\tr.${wired.at}${chain}${name} = ${wired.literal(child, `${chain}${name}.`)}`,
		...wiring(child, `${chain}${name}.`, wired),
	])
}

/**
 * The auth header pair (F2): an unset name takes the scheme's, and its prefix too unless the caller
 * set one; a set name keeps the caller's prefix, empty meaning none.
 */
function authDefaults(auth: IRAuth): string[] {
	const prefix =
		auth.prefix === ""
			? []
			: ['\t\tif cfg.AuthHeaderPrefix == "" {', `\t\t\tcfg.AuthHeaderPrefix = ${goString(auth.prefix)}`, "\t\t}"]
	return ['\tif cfg.AuthHeaderName == "" {', `\t\tcfg.AuthHeaderName = ${goString(auth.headerName)}`, ...prefix, "\t}"]
}

/** NewClient: the BaseURL default (the document's first server; without one an empty BaseURL panics), auth, wiring. */
function newClient(
	root: Resource,
	ir: IR,
	twins: ReadonlyMap<Resource, string>,
	types: ReadonlyMap<string, TwinType>,
): string[] {
	const twin = (n: Resource) => twins.get(n) as string
	const safe = (n: Resource, chain: string) => twinLiteral(n, `r.${chain}`, twin(n), types)
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
		...authDefaults(ir.auth),
		"\tcfg = prepareConfig(cfg)",
		"\tr := &Client{cfg: cfg, stale: NewStaleTracker(cfg.Invalidation)}",
		...wiring(root, "", { at: "", literal: (n) => `&${n.struct}{client: r}` }),
		`\tr.${MIRROR} = ${safe(root, "")}`,
		...wiring(root, "", { at: `${MIRROR}.`, literal: safe }),
		"\treturn r",
		"}",
		"",
		...lineComment(
			`${SAFE} is the client's safe mirror: the same resources and methods, each answering a Result, so an answer (an error status, an undecodable body) is a value and only a failure with no answer is an error.`,
			"//",
		),
		`func (r *Client) ${SAFE}() *${twin(root)} { return r.${MIRROR} }`,
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

/**
 * client.go's declarations for `ir` (the client, its resources and methods, then every `<Op>Opts`
 * and `<Op>Headers` in name order), and every method's call plan.
 */
export function clientDecls(ir: IR, env: ClientEnv): { readonly decls: string; readonly plans: GoCallPlan[] } {
	const root = resourceOf(ir.tree, [], "Client", env)
	const twins = twinNames(root, env)
	const types = twinTypes(methodsIn(root), (base) => env.at.names.claimConst(base))
	const opts = methodsIn(root)
		.flatMap((method) => method.decls)
		.sort(([a], [b]) => compareCodeUnits(a, b))
		.map(([, decl]) => decl)
	const decls = [
		"// Client is the API's client: a field per resource namespace, a method per operation at the root.",
		...structDecl(root, ["cfg Config", "stale *StaleTracker", `${MIRROR} *${twins.get(root) as string}`]),
		"",
		...newClient(root, ir, twins, types),
		...root.methods.flatMap((method) => ["", ...method.lines]),
		...root.fields.flatMap(({ node }) => ["", ...resourceLines(node)]),
		"",
		...twinLines(root, twins, types),
		...twinTypeLines(types),
		...opts.flatMap((decl) => ["", decl]),
	].join("\n")
	return { decls, plans: plansIn(root, []) }
}
