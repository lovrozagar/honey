/**
 * client.py's classes (G1, G2): a `<Path>Resource` per namespace of `IR.tree` for `SDK` and an
 * `Async<Path>Resource` twin for `AsyncSDK`, each child namespace an attribute (snake_case) and each operation
 * a method, then the two root clients. `SDK` has no stream method, and no attribute for a namespace that only
 * holds streams (H44). Both roots reserve `close`, `aclose` and `is_stale`, so their trees stay equal.
 */
import type { IR, IRNamespace } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { pyDocLines, pyString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, pyClassName, pyIdentifier } from "../shared/lang.ts"
import { BUILTINS, type MethodEnv, type PyMethod, pyMethod } from "./sdk-method.ts"
import type { PythonCallPlan } from "./sdk-plan.ts"

/** A namespace: its path, its child namespaces by attribute, its methods. */
type Resource = {
	readonly path: readonly string[]
	readonly children: readonly { readonly attribute: string; readonly node: Resource }[]
	readonly methods: readonly PyMethod[]
}

/** The client env, the operations by id, the async transport class the API needs, and whether it declares an `ErrorKey`. */
export type ClientEnv = MethodEnv & {
	readonly ops: ReadonlyMap<string, SdkOp>
	readonly transport: string
	readonly keyed: boolean
}

/* the root clients' own methods: no namespace or operation takes their names */
const ROOT_NAMES = ["close", "aclose", "is_stale"]

/** `ns` at `path`: its children first, so a method never takes an attribute's name. */
function resourceOf(ns: IRNamespace, path: readonly string[], env: ClientEnv): Resource {
	const scope = new NameScope(path.length === 0 ? ROOT_NAMES : [])
	const children = namespacesOf(ns).map(([segment, child]) => ({
		attribute: scope.claim(pyIdentifier(segment)),
		node: resourceOf(child, [...path, segment], env),
	}))
	const methods = methodsOf(ns).map(([segment, op]) =>
		pyMethod(env.ops.get(op.id) as SdkOp, scope.claim(pyIdentifier(segment)), env),
	)
	return { children, methods, path }
}

/** Whether `SDK` has anything below `node`: a method that is no stream. */
const hasSync = (node: Resource): boolean =>
	node.methods.some((method) => method.sync !== null) || node.children.some(({ node: child }) => hasSync(child))

/** Every resource below the root, leaves first, children in code-unit order. */
const below = (node: Resource): Resource[] => node.children.flatMap(({ node: child }) => [...below(child), child])

/** The resource classes' names: a sync one where `SDK` reaches the namespace, an async one always. */
function classNames(root: Resource, env: ClientEnv): Map<Resource, { sync?: string; async: string }> {
	const names = new Map<Resource, { sync?: string; async: string }>()
	for (const node of below(root)) {
		const base = `${node.path.map(pyClassName).join("")}Resource`
		const sync = hasSync(node) ? env.at.names.claim(base) : undefined
		names.set(node, { async: env.at.names.claim(`Async${base}`), ...(sync === undefined ? {} : { sync }) })
	}
	return names
}

/** A class's members, a blank line apart. */
const members = (blocks: readonly (readonly string[])[]) =>
	blocks.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines])

/** One client's view of the tree: whose classes and methods it has. */
type Side = {
	readonly async: boolean
	readonly name: (node: Resource) => string | undefined
	readonly transport: string
}

/** The attributes `node` has on `side`, each its child's class over `transport`. */
const attributes = (node: Resource, side: Side, transport: string) =>
	node.children.flatMap(({ attribute, node: child }) => {
		const type = side.name(child)
		return type === undefined ? [] : [`        self.${attribute} = ${type}(${transport})`]
	})

/** The methods `node` has on `side`, in order, each given the builtins the methods before it shadow. */
function methodBlocks(node: Resource, side: Side): string[][] {
	const shadowed = new Set<string>()
	return node.methods.flatMap((method) => {
		const lines = side.async ? method.async : method.sync
		if (lines === null) return []
		const block = lines(shadowed)
		if (BUILTINS.includes(method.name)) shadowed.add(method.name)
		return [block]
	})
}

/** The class of `node` on `side`. */
function resourceClass(node: Resource, side: Side): string[] {
	const init = ["    def __init__(self, transport: " + side.transport + ") -> None:", "        self._t = transport"]
	return [
		`class ${side.name(node)}:`,
		...members([[...init, ...attributes(node, side, "transport")], ...methodBlocks(node, side)]),
	]
}

/** A root client: its constructor, attributes and methods, `is_stale`, closing, and its context manager. */
function rootClass(root: Resource, side: Side, doc: string): string[] {
	const [aw, a] = side.async ? ["await ", "a"] : ["", ""]
	const transport = side.async ? side.transport : "SyncTransport"
	const own = [
		[
			"    def __init__(self, config: ClientConfig | None = None) -> None:",
			`        self._t = ${transport}(config or ClientConfig(), _DEFAULTS)`,
			...attributes(root, side, "self._t"),
		],
		[
			"    def is_stale(self, method: str, path: str) -> bool:",
			'        """Whether a read of ``method path`` sees a stale window now (``invalidation``)."""',
			"        return self._t.stale.begin(method, path).is_stale",
		],
		[`    ${a ? "async " : ""}def ${a}close(self) -> None:`, `        ${aw}self._t.${a}close()`],
		[`    ${a ? "async " : ""}def __${a}enter__(self) -> Self:`, "        return self"],
		[`    ${a ? "async " : ""}def __${a}exit__(self, *exc: object) -> None:`, `        ${aw}self.${a}close()`],
		/* after the client's own methods: an operation named like a builtin shadows only what follows it */
		...methodBlocks(root, side),
	]
	return [`class ${side.async ? "AsyncSDK" : "SDK"}:`, `    """${doc}"""`, "", ...members(own)]
}

/** Every method's call plan below `node`, reached through `accessors`, depth first. */
const plansIn = (node: Resource, accessors: readonly string[]): PythonCallPlan[] => [
	...node.methods.map((method) => ({ ...method.plan, accessors })),
	...node.children.flatMap(({ attribute, node: child }) => plansIn(child, [...accessors, attribute])),
]

/** The client's title line: the API's title, through the escape layer. */
export const clientTitle = (ir: IR) =>
	pyDocLines(
		ir.info.title === undefined
			? "The API's client, generated by honey."
			: `The ${ir.info.title} client, generated by honey.`,
	)[0] as string

/**
 * client.py's body for `ir`: the defaults (with the `ErrorKey` the runtime reads a key into), the operations'
 * constants, the resource classes (sync, then async), `SDK` and `AsyncSDK`; and every method's call plan.
 */
export function clientDecls(ir: IR, env: ClientEnv): { readonly lines: string[]; readonly plans: PythonCallPlan[] } {
	const root = resourceOf(ir.tree, [], env)
	const names = classNames(root, env)
	const sync: Side = { async: false, name: (node) => names.get(node)?.sync, transport: "SyncTransport" }
	const async: Side = { async: true, name: (node) => names.get(node)?.async, transport: env.transport }
	const nodes = below(root)
	const constants = [root, ...nodes]
		.flatMap((node) => node.methods)
		.map((method) => method.constant)
		.sort(compareCodeUnits)
	const server = ir.servers[0]
	const defaults = [
		server === undefined ? "None" : pyString(server),
		pyString(ir.auth.headerName),
		pyString(ir.auth.prefix),
		...(env.keyed ? ["ErrorKey"] : []),
	]
	const blocks = [
		[`_DEFAULTS = Defaults(${defaults.join(", ")})`, ...(constants.length > 0 ? ["", ...constants] : [])],
		...nodes.filter((node) => sync.name(node) !== undefined).map((node) => resourceClass(node, sync)),
		...nodes.map((node) => resourceClass(node, async)),
		rootClass(root, sync, clientTitle(ir)),
		rootClass(root, async, clientTitle(ir)),
	]
	return { lines: blocks.flatMap((lines, i) => [...(i > 0 ? ["", ""] : []), ...lines]), plans: plansIn(root, []) }
}
