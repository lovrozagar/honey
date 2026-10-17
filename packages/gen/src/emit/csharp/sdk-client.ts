/**
 * Client.cs's classes (§4.4, C#3): the client, then a `<Path>Resource` per namespace of `IR.tree` in code-unit
 * order of its path, each child namespace a read-only property built once in the constructor and each operation an
 * `…Async` method. A class's members claim names clear of the members every class has, of the names its method
 * bodies spell in an expression and of its own name (CS0542), properties before methods; the client owns the
 * transport and disposes it. Nothing here reads spec text but through the escape layer.
 */
import type { IR, IRNamespace } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { csIdentifier, csTypeName, NameScope } from "../shared/lang.ts"
import { docLines } from "./sdk-doc.ts"
import { type CsMethod, csMethod, type MethodEnv, type Spelling } from "./sdk-method.ts"
import type { CSharpCallPlan } from "./sdk-plan.ts"

/** The method env, the operations by id, and the client's and the JSON context's class names. */
export type ClientEnv = MethodEnv & {
	readonly ops: ReadonlyMap<string, SdkOp>
	readonly client: string
	readonly context: string
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
]

/** A namespace's class name before it is claimed: its path PascalCase, then `Resource`. */
const baseName = (path: readonly string[]) => `${path.map(csTypeName).join("")}Resource`

/** `ns` at `path`, its own class named `own`: its children first, so a method never takes a property's name. */
function resourceOf(ns: IRNamespace, path: readonly string[], own: string, env: ClientEnv): Resource {
	const members = new NameScope([...CLASS_MEMBERS, env.context, own])
	const fields = new NameScope(["_defaults", "_t"])
	const children = namespacesOf(ns).map(([segment, child]) => {
		const property = members.claim(csTypeName(segment))
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

/** What rendering reads: each resource's claimed class name, and how a method spells a type the context lists. */
type Render = { readonly names: ReadonlyMap<Resource, string>; readonly spell: Spelling }

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

/** The client class: its docs, its defaults, its fields, its constructor, its properties, its methods, `Dispose`. */
function clientClass(ir: IR, root: Resource, env: ClientEnv, render: Render) {
	const own = body(root, "_t", render)
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
		"    }",
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
 * every method's call plan. Resource class names are claimed after every type the methods hoist.
 */
export function clientDecls(ir: IR, env: ClientEnv) {
	const root = resourceOf(ir.tree, [], env.client, env)
	const nodes = below(root)
	const names = new Map(nodes.map((node) => [node, env.at.names.claim(baseName(node.path))]))
	const all = [root, ...nodes]
	return {
		plans: plansIn(root, []),
		text: (spell: Spelling) =>
			members([
				clientClass(ir, root, env, { names, spell }),
				...nodes.map((node) => resourceClass(node, { names, spell })),
			]).join("\n"),
		types: all.flatMap((node) => node.methods.flatMap((method) => method.types)),
	}
}
