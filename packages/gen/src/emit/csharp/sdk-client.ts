/**
 * Client.cs's classes (§4.4, C#3): the client, then a `<Path>Resource` per namespace of `IR.tree` in code-unit
 * order of its path, each child namespace a read-only property built once in the constructor and each operation an
 * `…Async` method; then their `client.Safe` mirror (bit 21 i5), a `Safe<Client>` and a `Safe<Path>Resource` per
 * class with the same members, each method a twin answering a `Result` through the normal one. A class's members
 * claim names clear of the members every class has, of the names its method bodies spell in an expression and of
 * its own and its twin's name (CS0542), properties before methods; the client's root also keeps `Safe` for the
 * mirror, a root group spelled so emitted as `Safe_` and noticed (shared/mirror.ts). The client owns the transport
 * and disposes it. Nothing here reads spec text but through the escape layer.
 */
import type { IR, IRNamespace } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { csIdentifier, csTypeName, NameScope } from "../shared/lang.ts"
import { mirrorNotice } from "../shared/mirror.ts"
import { docLines } from "./sdk-doc.ts"
import { type CsMethod, csMethod, type MethodEnv, type Spelling } from "./sdk-method.ts"
import type { CSharpCallPlan } from "./sdk-plan.ts"

/** The method env, the operations by id, the client's and the JSON context's class names, and the notices. */
export type ClientEnv = MethodEnv & {
	readonly ops: ReadonlyMap<string, SdkOp>
	readonly client: string
	readonly context: string
	/** what the generation reports: a root group renamed off the mirror */
	readonly notices: string[]
}

/** A namespace: its path, its child namespaces by property, its methods. */
type Resource = {
	readonly path: readonly string[]
	readonly children: readonly { readonly property: string; readonly node: Resource }[]
	readonly methods: readonly CsMethod[]
}

/* every class's own members, and the names a method body spells in an expression (a property would shadow them) */
const CLASS_MEMBERS = [
	"Arg",
	"Body",
	"ClientConfig",
	"Dispose",
	"Equals",
	"Finalize",
	"GetHashCode",
	"GetType",
	"MemberwiseClone",
	"Part",
	"ToString",
	"Transport",
	"TransportOptions",
]

/* the client's mirror property, `client.Safe` (shared/mirror.ts's name as C# spells it) */
const SAFE = "Safe"

/** A namespace's class name before it is claimed: its path PascalCase, then `Resource`. */
const baseName = (path: readonly string[]) => `${path.map(csTypeName).join("")}Resource`

/** A child namespace's property: its segment PascalCase, a root one spelled `Safe` moved to `Safe_`, noticed. */
function propertyOf(segment: string, root: boolean, members: NameScope, env: ClientEnv): string {
	const wanted = csTypeName(segment)
	const property = members.claim(root && wanted === SAFE ? `${SAFE}_` : wanted)
	const notice = root ? mirrorNotice("csharp", SAFE, wanted, property) : null
	if (notice !== null) env.notices.push(notice)
	return property
}

/** `ns` at `path`, its own class named `own`: its children first, so a method never takes a property's name. */
function resourceOf(ns: IRNamespace, path: readonly string[], own: string, env: ClientEnv): Resource {
	const root = path.length === 0
	const members = new NameScope([...CLASS_MEMBERS, env.context, own, `${SAFE}${own}`, ...(root ? [SAFE] : [])])
	const fields = new NameScope(["_defaults", "_n", "_t"])
	const children = namespacesOf(ns).map(([segment, child]) => {
		const property = propertyOf(segment, root, members, env)
		return { node: resourceOf(child, [...path, segment], baseName([...path, segment]), env), property }
	})
	const methods = methodsOf(ns).map(([segment, op]) =>
		csMethod(
			env.ops.get(op.id) as SdkOp,
			members.claim(`${csTypeName(segment)}Async`),
			fields.claim(`_${csIdentifier(segment).replace(/^@/, "")}`),
			env,
		),
	)
	return { children, methods, path }
}

/** Every resource below `node`, in code-unit order of its path: children are sorted, so pre-order is path order. */
const below = (node: Resource): Resource[] => node.children.flatMap(({ node: child }) => [child, ...below(child)])

/** Each class's member blocks, a blank line apart. */
const members = (blocks: readonly (readonly string[])[]) =>
	blocks.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines])

/**
 * What rendering reads: each resource's claimed class name and its twin's, and how a method spells a type the
 * context lists.
 */
type Render = {
	readonly names: ReadonlyMap<Resource, string>
	readonly safe: ReadonlyMap<Resource, string>
	readonly spell: Spelling
}

/** A class's own members: its operation fields, the transport field when it has methods, its constructor's body. */
function body(node: Resource, transport: string, { names, spell }: Render) {
	const owns = node.methods.length > 0
	return {
		construct: [
			...(owns && transport === "t" ? ["        _t = t;"] : []),
			...node.children.map(
				({ node: child, property }) => `        ${property} = new ${names.get(child)}(${transport});`,
			),
		],
		fields: [...node.methods.map((method) => method.field), ...(owns ? ["    private readonly Transport _t;"] : [])],
		methods: node.methods.map((method) => method.lines(spell)),
		properties: node.children.map(({ node: child, property }) => [
			`    public ${names.get(child)} ${property} { get; }`,
		]),
	}
}

/** A resource class: its fields, its internal constructor, its properties, its methods. */
function resourceClass(node: Resource, render: Render): string[] {
	const name = render.names.get(node) as string
	const own = body(node, "t", render)
	const constructor = [`    internal ${name}(Transport t)`, "    {", ...own.construct, "    }"]
	const blocks = [...(own.fields.length > 0 ? [own.fields] : []), constructor, ...own.properties, ...own.methods]
	return [`public sealed class ${name}`, "{", ...members(blocks), "}"]
}

/**
 * `node`'s `client.Safe` twin of the class `normal`: the normal instance it calls (`_n`, when it has methods), each
 * child's twin built from the normal child, and each method's twin (CsMethod.twin).
 */
function safeClass(node: Resource, normal: string, render: Render): string[] {
	const name = render.safe.get(node) as string
	const owns = node.methods.length > 0
	const constructor = [
		`    internal ${name}(${normal} n)`,
		"    {",
		...(owns ? ["        _n = n;"] : []),
		...node.children.map(
			({ node: child, property }) => `        ${property} = new ${render.safe.get(child)}(n.${property});`,
		),
		"    }",
	]
	const blocks = [
		...(owns ? [[`    private readonly ${normal} _n;`]] : []),
		constructor,
		...node.children.map(({ node: child, property }) => [`    public ${render.safe.get(child)} ${property} { get; }`]),
		...node.methods.map((method) => method.twin(render.spell)),
	]
	return [
		`/// <summary><see cref="${normal}"/>'s safe mirror: each method answers a <c>Result</c>, an answer (an error status, a body that does not decode) its Err; no answer still throws.</summary>`,
		`public sealed class ${name}`,
		"{",
		...members(blocks),
		"}",
	]
}

/** The client class: its docs, its defaults, its fields, its constructor, its properties, its methods, `Dispose`. */
function clientClass(ir: IR, root: Resource, env: ClientEnv, render: Render) {
	const own = body(root, "_t", render)
	const mirror = render.safe.get(root) as string
	const server = ir.servers[0]
	const defaults = [
		server === undefined ? "null" : csString(server),
		csString(ir.auth.headerName),
		csString(ir.auth.prefix),
		`${env.context}.Default.Options`,
	]
	const title = ir.info.title === undefined ? "The API's client" : `The ${ir.info.title} client`
	const fields = [
		`    private static readonly Defaults _defaults = new(${defaults.join(", ")});`,
		...root.methods.map((method) => method.field),
		"    private readonly Transport _t;",
	]
	const constructor = [
		`    public ${env.client}(ClientConfig? config = null)`,
		"    {",
		"        _t = new Transport(config ?? new ClientConfig(), _defaults);",
		...own.construct,
		`        ${SAFE} = new ${mirror}(this);`,
		"    }",
	]
	const safe = [
		"    /// <summary>This client's methods answering a <c>Result</c>: an answer is its Err, never thrown; no answer still throws.</summary>",
		`    public ${mirror} ${SAFE} { get; }`,
	]
	return [
		...docLines("summary", `${title}, generated by honey.`),
		...docLines("remarks", ir.info.description),
		`public sealed class ${env.client} : IDisposable`,
		"{",
		...members([
			fields,
			constructor,
			...own.properties,
			safe,
			...own.methods,
			["    public void Dispose() => _t.Dispose();"],
		]),
		"}",
	]
}

/** Every method's call plan below `node`, reached through `accessors`, depth first. */
const plansIn = (node: Resource, accessors: readonly string[]): CSharpCallPlan[] => [
	...node.methods.map((method) => ({ ...method.plan, accessors })),
	...node.children.flatMap(({ node: child, property }) => plansIn(child, [...accessors, property])),
]

/**
 * Client.cs's classes for `ir`, once the JSON context can spell each type; the types its methods need listed; and
 * every method's call plan. Resource class names are claimed after every type the methods hoist, their twins' after
 * them.
 */
export function clientDecls(ir: IR, env: ClientEnv) {
	const root = resourceOf(ir.tree, [], env.client, env)
	const nodes = below(root)
	const names = new Map(nodes.map((node) => [node, env.at.names.claim(baseName(node.path))]))
	const all = [root, ...nodes]
	const normalOf = (node: Resource) => (node === root ? env.client : (names.get(node) as string))
	const safe = new Map(all.map((node) => [node, env.at.names.claim(`${SAFE}${normalOf(node)}`)]))
	return {
		plans: plansIn(root, []),
		text: (spell: Spelling) => {
			const render = { names, safe, spell }
			return members([
				clientClass(ir, root, env, render),
				...nodes.map((node) => resourceClass(node, render)),
				...all.map((node) => safeClass(node, normalOf(node), render)),
			]).join("\n")
		},
		types: all.flatMap((node) => node.methods.flatMap((method) => method.types)),
	}
}
