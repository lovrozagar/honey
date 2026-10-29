/**
 * client.rs's body (G1): `Client::new` (the API's first server as the default `base_url`, its auth scheme as
 * the default header), an accessor per top-level namespace of `IR.tree`, a `<Path>Resource<'a, S>` per nested
 * namespace borrowing the client, every operation a method on the type of its namespace, and each method's
 * `<Op>Opts` and `<Op>Headers` after them in name order. Every accessor and method is the client's style's
 * (bit 21 i4): `Client<S>` and each resource take `S`, so `client.safe()` (the runtime's `Client<Safe>`) holds
 * the very same tree, nothing emitted twice. A root member spelled `safe` is `safe_` (shared/mirror.ts), noticed.
 */
import type { IR, IRNamespace } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { lineComment, rustString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, rustTypeIdent, rustValueIdent } from "../shared/lang.ts"
import { MIRROR, mirrorNotice } from "../shared/mirror.ts"
import type { RustCallPlan } from "./sdk-plan.ts"
import { type MethodEnv, type RustMethod, rustMethod } from "./sdk-method.ts"
import { STYLE } from "./types-names.ts"

/** A namespace as Rust: its type, its child namespaces by accessor, its methods. */
type Resource = {
	readonly type: string
	readonly path: readonly string[]
	readonly children: readonly { readonly accessor: string; readonly node: Resource }[]
	readonly methods: readonly RustMethod[]
}

/** The method env, the operations by id, and the notices the generation reports (a root member renamed for the mirror). */
export type ClientEnv = MethodEnv & { readonly ops: ReadonlyMap<string, SdkOp>; readonly notices: string[] }

/* the runtime's own associated functions on `Client`, the mirror among them: no operation takes their name */
const CLIENT_FNS = ["build", "new", MIRROR]

/** A member's name in `scope`; at the root (`path` empty) one spelled like the mirror is `safe_` instead, and noticed. */
function memberName(segment: string, path: readonly string[], scope: NameScope, env: ClientEnv): string {
	const name = rustValueIdent(segment)
	if (path.length > 0 || name !== MIRROR) return scope.claim(name)
	const renamed = scope.claim(`${MIRROR}_`)
	env.notices.push(mirrorNotice("rust", MIRROR, name, renamed) as string)
	return renamed
}

/** `ns` at `path` as the type `type`: its child namespaces first, so a method never takes an accessor's name. */
function resourceOf(ns: IRNamespace, path: readonly string[], type: string, env: ClientEnv): Resource {
	const scope = new NameScope(path.length === 0 ? CLIENT_FNS : [])
	const client = path.length === 0 ? "self" : "self.client"
	const children = namespacesOf(ns).map(([segment, child]) => {
		const accessor = memberName(segment, path, scope, env)
		const childPath = [...path, segment]
		/* the type rule over the whole name: a leading digit gets its guard, and `self` stays `SelfResource` */
		const childType = env.at.names.claim(rustTypeIdent([...childPath, "Resource"].join(".")))
		return { accessor, node: resourceOf(child, childPath, childType, env) }
	})
	const methods = methodsOf(ns).map(([segment, op]) =>
		rustMethod(env.ops.get(op.id) as SdkOp, memberName(segment, path, scope, env), client, env),
	)
	return { children, methods, path, type }
}

/** Each accessor of `node`, reaching its child from `client` (`self` at the root, the borrowed client below it). */
function accessorBlocks(node: Resource, lifetime: string, client: string): string[][] {
	return node.children.map(({ accessor, node: child }) => [
		...lineComment(`The ${child.path.join(".")} operations.`, "///", "    "),
		`    pub fn ${accessor}(&self) -> ${child.type}<${lifetime}, ${STYLE}> {`,
		`        ${child.type} { client: ${client} }`,
		"    }",
	])
}

/** An impl block's members, a blank line apart. */
const members = (blocks: readonly (readonly string[])[]) => blocks.map((lines) => lines.join("\n")).join("\n\n")

/** Each namespace below the client: its type, its accessors and methods, then its children's. */
function resourceLines(node: Resource): string[] {
	/* the lifetime is named only where an accessor hands it on */
	const head =
		node.children.length > 0
			? `impl<'a, ${STYLE}: Style> ${node.type}<'a, ${STYLE}> {`
			: `impl<${STYLE}: Style> ${node.type}<'_, ${STYLE}> {`
	const own = [...accessorBlocks(node, "'a", "self.client"), ...node.methods.map((method) => method.lines)]
	return [
		...lineComment(`The ${node.path.join(".")} operations.`, "///"),
		`pub struct ${node.type}<'a, ${STYLE} = Throw> {`,
		`    client: &'a Client<${STYLE}>,`,
		"}",
		"",
		head,
		members(own),
		"}",
		...node.children.flatMap(({ node: child }) => ["", ...resourceLines(child)]),
	]
}

/** `Client::new`: the `base_url` default (the document's first server; without one an empty `base_url` is an error) and the auth scheme. */
function newClient(ir: IR): string[] {
	const server = ir.servers[0]
	const doc =
		server === undefined
			? "The client for `config`. Its `base_url` is required: the API declares no server."
			: `The client for \`config\`. An empty \`base_url\` is the API's first server, ${server}.`
	const base = server === undefined ? "None" : `Some(${rustString(server)})`
	const defaults = `base_url: ${base}, auth_header: ${rustString(ir.auth.headerName)}, auth_prefix: ${rustString(ir.auth.prefix)}`
	return [
		...lineComment(doc, "///", "    "),
		"    pub fn new(config: ClientConfig) -> Result<Client, Error> {",
		`        Client::build(config, crate::config::Defaults { ${defaults} })`,
		"    }",
	]
}

/** Every method in the tree, depth first. */
const methodsIn = (node: Resource): RustMethod[] => [
	...node.methods,
	...node.children.flatMap(({ node: child }) => methodsIn(child)),
]

/** Every method's call plan below `node`, reached through `accessors`, depth first. */
const plansIn = (node: Resource, accessors: readonly string[]): RustCallPlan[] => [
	...node.methods.map((method) => ({ ...method.plan, accessors })),
	...node.children.flatMap(({ accessor, node: child }) => plansIn(child, [...accessors, accessor])),
]

/**
 * client.rs's declarations for `ir` (the client's constructor, accessors and methods, every resource, then
 * every `<Op>Opts` and `<Op>Headers` in name order), and every method's call plan.
 */
export function clientDecls(ir: IR, env: ClientEnv): { readonly decls: string; readonly plans: RustCallPlan[] } {
	const root = resourceOf(ir.tree, [], "Client", env)
	const opts = methodsIn(root)
		.flatMap((method) => method.decls)
		.sort(([a], [b]) => compareCodeUnits(a, b))
		.map(([, decl]) => decl)
	const own = [...accessorBlocks(root, "'_", "self"), ...root.methods.map((method) => method.lines)]
	const styled = own.length === 0 ? [] : ["", `impl<${STYLE}: Style> Client<${STYLE}> {`, members(own), "}"]
	const decls = [
		"impl Client {",
		members([newClient(ir)]),
		"}",
		...styled,
		...root.children.flatMap(({ node }) => ["", ...resourceLines(node)]),
		...opts.flatMap((decl) => ["", decl]),
	].join("\n")
	return { decls, plans: plansIn(root, []) }
}
