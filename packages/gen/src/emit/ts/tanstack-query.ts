/**
 * The TanStack Query adapter the `ts` target writes under `--ts-tanstack-query` (bit 22):
 * `<stem>.tanstack-query.gen.ts`, the vendored modules under `runtime/ts-tanstack-query` joined into one
 * file beside the SDK, plus the types that make its surfaces exact for this document.
 *
 * The vendoring mirrors `http.ts`'s `runtimeSource`, with one difference it cannot share: those modules
 * import only each other, so dropping every sibling import is enough. These import honey's runtime too
 * (`../ts/sdk.ts`), and the emitted file needs those names from `./<stem>.runtime.gen`, so the specifier is
 * rewritten rather than dropped.
 */
import { readFileSync } from "node:fs"
import type { IR, IRNamespace } from "../../ir/model.ts"
import { compareCodeUnits } from "../shared/lang.ts"
import { quoteKey } from "../shared/literals.ts"
import { memberTree } from "./service-map.ts"

/** The adapter's modules, each after the ones it imports, as `RUNTIME_MODULES` is ordered. */
const QUERY_MODULES: readonly string[] = ["invalidate", "query"]

/* an import of a module beside this one: now the same file, so the names are already in scope */
const SIBLING_IMPORT = /^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"\.\/[\w-]+\.ts"\n/gm
/* an import of honey's own runtime, which the emitted file reads from `<stem>.runtime.gen` */
const RUNTIME_IMPORT = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\.\/ts\/[\w-]+\.ts"\n/gm
/* query-core, which stays exactly as written: type-only, so nothing has to resolve at run time */
const QUERY_CORE_IMPORT = /^import\s+type\s+\{([^}]*)\}\s+from\s+"@tanstack\/query-core"\n/gm

/** The names a `{ a, type b }` clause lists, in code-unit order and once each. */
function namesOf(clauses: readonly string[]): string[] {
	const names = new Set<string>()
	for (const clause of clauses)
		for (const name of clause.split(",")) if (name.trim() !== "") names.add(name.trim().replace(/^type\s+/, ""))
	return [...names].sort(compareCodeUnits)
}

/**
 * The adapter as one module, its imports hoisted: `runtime` is the emitted runtime's specifier
 * (`<stem>.runtime.gen`). Every module's own `export` keywords survive, so the emitted file exports what
 * the types below wrap.
 */
export function tanstackQuerySource(runtime: string): string {
	const core: string[] = []
	const honey: string[] = []
	const bodies = QUERY_MODULES.map((name) => {
		const text = readFileSync(new URL(`../../runtime/ts-tanstack-query/${name}.ts`, import.meta.url), "utf8")
		return text
			.replace(QUERY_CORE_IMPORT, (_, named: string) => {
				core.push(named)
				return ""
			})
			.replace(RUNTIME_IMPORT, (_, __, named: string) => {
				honey.push(named)
				return ""
			})
			.replace(SIBLING_IMPORT, "")
			.trim()
	})
	const imports = [
		`import type { ${namesOf(core).join(", ")} } from "@tanstack/query-core"`,
		`import type { ${namesOf(honey).join(", ")} } from "./${runtime}"`,
	]
	return `${imports.join("\n")}\n\n${bodies.join("\n\n")}\n`
}

type Tree = { [key: string]: Tree | 1 }

/** The member tree of the operations `keep` admits, branches with nothing in them left out. */
function treeOf(ns: IRNamespace, keep: (op: { id: string }) => boolean, ops: Map<string, boolean>): Tree {
	const out: Tree = {}
	for (const [name, entry] of ns.entries) {
		if (entry.kind === "namespace") {
			const nested = treeOf(entry.ns, keep, ops)
			if (Object.keys(nested).length > 0) out[name] = nested
			continue
		}
		if (keep(entry.op) && ops.get(entry.op.id) !== undefined) out[name] = 1
	}
	return out
}

/** A tree as a type literal; `{}` when it holds nothing, which no surface then offers. */
function treeText(tree: Tree, indent = "\t"): string {
	const keys = Object.keys(tree)
	if (keys.length === 0) return "{}"
	const lines = keys.map((key) => {
		const value = tree[key]
		return `${indent}${quoteKey(key)}: ${value === 1 ? "1" : treeText(value as Tree, `${indent}\t`)}`
	})
	return `{\n${lines.join("\n")}\n${indent.slice(1)}}`
}

/** Whether each operation can be cached: a `GET` that is not a stream or a connection. */
function readable(ir: IR): Map<string, boolean> {
	const out = new Map<string, boolean>()
	for (const op of ir.operations) {
		const stream = op.extensions.sse === true || op.extensions.websocket === true || op.extensions.realtime === true
		if (stream) continue
		out.set(op.id, op.method === "GET")
	}
	return out
}

/**
 * `<stem>.tanstack-query.gen.ts`: the vendored adapter, the two key trees read off this document, and the
 * mapped types that turn them into exact surfaces over the client's own operations.
 */
export function tanstackQueryText(ir: IR, name: string, stem: string): string {
	const ops = readable(ir)
	const tree = memberTree(ir.tree)
	const queries = treeOf(tree, (op) => ops.get(op.id) === true, ops)
	const mutations = treeOf(tree, (op) => ops.get(op.id) === false, ops)
	return `${tanstackQuerySource(`${stem}.runtime.gen`)}
import { serviceMap } from "./${stem}.map.gen"
import type { ${name} } from "./${stem}.client.gen"

/** Every operation of this API a cache can hold, nested as the client nests them. */
type TanstackQueryTree = ${treeText(queries)}

/** Every operation that changes something, nested the same way. */
type TanstackMutationTree = ${treeText(mutations)}

type TreeShape = { readonly [key: string]: TreeShape | 1 }

type Surfaced<TOps, TTree extends TreeShape, TLeaf> = {
	[K in Extract<keyof TTree, keyof TOps>]: TTree[K] extends 1
		? TLeaf extends 0
			? QueryFactory<TOps[K]>
			: TLeaf extends 1
				? MutationFactory<TOps[K]>
				: TLeaf extends 2
					? InfiniteFactory<TOps[K]>
					: KeyFactory<TOps[K]>
		: TTree[K] extends TreeShape
			? Surfaced<TOps[K], TTree[K], TLeaf>
			: never
}

/**
 * The TanStack Query factories for this SDK. \`sdk\` may be a client or a thunk for one, which an
 * isomorphic app needs; \`getQueryClient\` is what a successful write invalidates against.
 */
export function createQueryHelpers(
	sdk: SdkSource<${name}>,
	options: QueryHelperOptions = {},
): {
	infiniteQuery: Surfaced<${name}, TanstackQueryTree, 2>
	mutation: Surfaced<${name}, TanstackMutationTree, 1>
	mutationKey: Surfaced<${name}, TanstackMutationTree, 3>
	query: Surfaced<${name}, TanstackQueryTree, 0>
	queryKey: Surfaced<${name}, TanstackQueryTree, 3>
} {
	const helpers = queryHelpers(sdk, serviceMap as ServiceMap, ${JSON.stringify(name)}, options)
	return helpers as unknown as {
		infiniteQuery: Surfaced<${name}, TanstackQueryTree, 2>
		mutation: Surfaced<${name}, TanstackMutationTree, 1>
		mutationKey: Surfaced<${name}, TanstackMutationTree, 3>
		query: Surfaced<${name}, TanstackQueryTree, 0>
		queryKey: Surfaced<${name}, TanstackQueryTree, 3>
	}
}
`
}
