/**
 * client.py's classes (G1, G2): a `<Path>Resource` per namespace of `IR.tree` for `SDK` and an
 * `Async<Path>Resource` twin for `AsyncSDK`, each child namespace an attribute (snake_case) and each operation
 * a method, then the two root clients. `SDK` has no stream method, and no attribute for a namespace that only
 * holds streams (H44). Both roots reserve `close`, `aclose`, `is_stale` and `safe`, so their trees stay equal.
 *
 * `safe` (bit 21 i2) is each root's safe mirror: a `Safe<Path>Resource` (`AsyncSafe…`) per class, the same tree, each
 * operation one line, `name = Safe.of(<Class>.name)` (`of_sync` on `SDK`'s side): the normal method itself, typed to
 * answer a `Result`, its `self._t` the runtime's `Safe` view of the transport. A connection (WebSocket, realtime) is
 * the same method on both, `Safe.keep` typing it for the twin's `self`. A root member spelled `safe` is emitted as
 * `safe_`, and the generation says so.
 */
import type { IR, IRNamespace } from "../../ir/model.ts"
import { methodsOf, namespacesOf } from "../../ir/resource-tree.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { pyDocLines, pyString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, pyClassName, pyIdentifier } from "../shared/lang.ts"
import { MIRROR, mirrorNotice } from "../shared/mirror.ts"
import { BUILTINS, type MethodEnv, type PyMethod, pyMethod } from "./sdk-method.ts"
import type { PythonCallPlan } from "./sdk-plan.ts"

/** A namespace: its path, its child namespaces by attribute, its methods. */
type Resource = {
	readonly path: readonly string[]
	readonly children: readonly { readonly attribute: string; readonly node: Resource }[]
	readonly methods: readonly PyMethod[]
}

/**
 * The client env, the operations by id, the async transport class the API needs, whether it declares an `ErrorKey`,
 * and the notices the generation reports (a root member renamed for the mirror).
 */
export type ClientEnv = MethodEnv & {
	readonly ops: ReadonlyMap<string, SdkOp>
	readonly transport: string
	readonly keyed: boolean
	readonly notices: string[]
}

/* the root clients' own members: no namespace or operation takes their names */
const ROOT_NAMES = ["close", "aclose", "is_stale", MIRROR]

/**
 * `ns` at `path`: its children first, so a method never takes an attribute's name. A root member spelled `safe` is
 * `safe_` (shared/mirror.ts), and noticed; no sibling is spelled `safe_` already, as `pyIdentifier` never ends one in
 * `_` but a keyword's.
 */
function resourceOf(ns: IRNamespace, path: readonly string[], env: ClientEnv): Resource {
	const scope = new NameScope(path.length === 0 ? ROOT_NAMES : [])
	const claim = (segment: string) => {
		const ident = pyIdentifier(segment)
		if (path.length > 0 || ident !== MIRROR) return scope.claim(ident)
		const name = scope.claim(`${MIRROR}_`)
		env.notices.push(mirrorNotice("python", MIRROR, ident, name) as string)
		return name
	}
	const children = namespacesOf(ns).map(([segment, child]) => ({
		attribute: claim(segment),
		node: resourceOf(child, [...path, segment], env),
	}))
	const methods = methodsOf(ns).map(([segment, op]) => pyMethod(env.ops.get(op.id) as SdkOp, claim(segment), env))
	return { children, methods, path }
}

/** Whether `SDK` has anything below `node`: a method that is no stream. */
const hasSync = (node: Resource): boolean =>
	node.methods.some((method) => method.sync !== null) || node.children.some(({ node: child }) => hasSync(child))

/** Every resource below the root, leaves first, children in code-unit order. */
const below = (node: Resource): Resource[] => node.children.flatMap(({ node: child }) => [...below(child), child])

/** A namespace's class on each side: a sync one where `SDK` reaches it, an async one always. */
type Names = { readonly sync?: string; readonly async: string }

/**
 * The classes' names, each node's normal ones and its safe twins': a sync one where `SDK` reaches the namespace, an
 * async one always; the roots are `SDK` and `AsyncSDK`, their twins `SafeSDK` and `AsyncSafeSDK` as claimed.
 */
function classNames(root: Resource, env: ClientEnv) {
	const base = (node: Resource) => (node === root ? "SDK" : `${node.path.map(pyClassName).join("")}Resource`)
	/* the normal classes first, so a twin never moves the name one of them had */
	const claimed = (nodes: readonly Resource[], prefix: string) =>
		new Map<Resource, Names>(
			nodes.map((node) => {
				const sync = node === root || hasSync(node) ? env.at.names.claim(`${prefix}${base(node)}`) : undefined
				const async = env.at.names.claim(`Async${prefix}${base(node)}`)
				return [node, sync === undefined ? { async } : { async, sync }]
			}),
		)
	const normal = claimed(below(root), "").set(root, { async: "AsyncSDK", sync: "SDK" })
	return { normal, safe: claimed([...below(root), root], "Safe") }
}

/** A class's members, a blank line apart. */
const members = (blocks: readonly (readonly string[])[]) =>
	blocks.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines])

/** One client's view of the tree: whose classes and methods it has, and, on a safe mirror, whose methods they twin. */
type Side = {
	readonly async: boolean
	readonly name: (node: Resource) => string | undefined
	readonly transport: string
	readonly twins?: (node: Resource) => string
}

/** The attributes `node` has on `side`, each its child's class over `transport`. */
const attributes = (node: Resource, side: Side, transport: string) =>
	node.children.flatMap(({ attribute, node: child }) => {
		const type = side.name(child)
		return type === undefined ? [] : [`        self.${attribute} = ${type}(${transport})`]
	})

/**
 * The methods `node` has on `side`, in order, each given the builtins the methods before it shadow; on a safe mirror
 * each is one line, the twinned class's method typed to answer a `Result`, a connection as it is.
 */
function methodBlocks(node: Resource, side: Side): string[][] {
	const shadowed = new Set<string>()
	return node.methods.flatMap((method) => {
		const lines = side.async ? method.async : method.sync
		if (lines === null) return []
		if (side.twins !== undefined) {
			const twinned = `${side.twins(node)}.${method.name}`
			const connection = method.plan.stream === "ws" || method.plan.stream === "realtime"
			return [[`    ${method.name} = Safe.${connection ? "keep" : side.async ? "of" : "of_sync"}(${twinned})`]]
		}
		const block = lines(shadowed)
		if (BUILTINS.includes(method.name)) shadowed.add(method.name)
		return [block]
	})
}

/** The class of `node` on `side`; a safe mirror's methods one line each, with no blank line between them. */
function resourceClass(node: Resource, side: Side): string[] {
	const init = ["    def __init__(self, transport: " + side.transport + ") -> None:", "        self._t = transport"]
	const methods = methodBlocks(node, side)
	return [
		`class ${side.name(node)}:`,
		...members([
			[...init, ...attributes(node, side, "transport")],
			...(side.twins === undefined ? methods : methods.length > 0 ? [methods.flat()] : []),
		]),
	]
}

/** A root client: its constructor, attributes, safe mirror and methods, `is_stale`, closing, its context manager. */
function rootClass(root: Resource, side: Side, safe: Side, doc: string): string[] {
	const [aw, a] = side.async ? ["await ", "a"] : ["", ""]
	const transport = side.async ? side.transport : "SyncTransport"
	const own = [
		[
			"    def __init__(self, config: ClientConfig | None = None) -> None:",
			`        self._t = ${transport}(config or ClientConfig(), _DEFAULTS)`,
			...attributes(root, side, "self._t"),
			`        self.${MIRROR} = ${safe.name(root)}(Safe(self._t))`,
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
	const { normal, safe } = classNames(root, env)
	const sync: Side = { async: false, name: (node) => normal.get(node)?.sync, transport: "SyncTransport" }
	const async: Side = { async: true, name: (node) => normal.get(node)?.async, transport: env.transport }
	const twin = (side: Side): Side => ({
		async: side.async,
		name: (node) => (side.async ? safe.get(node)?.async : safe.get(node)?.sync),
		transport: "Safe",
		twins: (node) => side.name(node) as string,
	})
	const [safeSync, safeAsync] = [twin(sync), twin(async)]
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
		rootClass(root, sync, safeSync, clientTitle(ir)),
		rootClass(root, async, safeAsync, clientTitle(ir)),
		/* after the classes they twin: each method line reads its normal class */
		...nodes.filter((node) => sync.name(node) !== undefined).map((node) => resourceClass(node, safeSync)),
		...nodes.map((node) => resourceClass(node, safeAsync)),
		resourceClass(root, safeSync),
		resourceClass(root, safeAsync),
	]
	return { lines: blocks.flatMap((lines, i) => [...(i > 0 ? ["", ""] : []), ...lines]), plans: plansIn(root, []) }
}
