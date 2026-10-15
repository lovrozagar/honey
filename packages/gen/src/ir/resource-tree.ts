/**
 * The resource tree: an operation's dotted id is its place, `checkout.sessions.create` the method
 * `create` in the namespace `checkout.sessions`. An id that is also another's namespace is refused.
 */
import { compareCodeUnits } from "../emit/shared/lang.ts"
import type { IRNamespace, IROperation, IRTreeEntry } from "./model.ts"

type Entries<T> = [string, T][]

function sortedOf<K extends IRTreeEntry["kind"]>(ns: IRNamespace, kind: K): Entries<Extract<IRTreeEntry, { kind: K }>> {
	return [...ns.entries]
		.filter((entry): entry is [string, Extract<IRTreeEntry, { kind: K }>] => entry[1].kind === kind)
		.sort(([a], [b]) => compareCodeUnits(a, b))
}

/** A namespace's methods, in code-unit order. */
export function methodsOf(ns: IRNamespace): Entries<IROperation> {
	return sortedOf(ns, "method").map(([key, entry]) => [key, entry.op])
}

/** A namespace's child namespaces, in code-unit order. */
export function namespacesOf(ns: IRNamespace): Entries<IRNamespace> {
	return sortedOf(ns, "namespace").map(([key, entry]) => [key, entry.ns])
}

/** The id of the first operation under `ns` (a namespace is never empty), to name it in a conflict. */
function firstId(ns: IRNamespace): string {
	const first = ns.entries.values().next().value as IRTreeEntry
	return first.kind === "method" ? first.op.id : firstId(first.ns)
}

function conflict(callable: string, nested: string): Error {
	return new Error(
		`operationId conflict: "${callable}" is callable but also a namespace prefix of "${nested}".\n` +
			`Rename one. Suggested: "${callable}" → "${callable}One" or drop "${nested}".`,
	)
}

/** The tree of `operations` by their dotted ids. */
export function buildResourceTree(operations: readonly IROperation[]): IRNamespace {
	const root: IRNamespace = { entries: new Map() }
	for (const op of operations) {
		const segments = op.id.split(".")
		const leaf = segments.pop() as string
		let at = root
		for (const segment of segments) {
			const entry = at.entries.get(segment)
			if (entry?.kind === "method") throw conflict(entry.op.id, op.id)
			if (entry === undefined) {
				const ns: IRNamespace = { entries: new Map() }
				at.entries.set(segment, { kind: "namespace", ns })
				at = ns
			} else at = entry.ns
		}
		const existing = at.entries.get(leaf)
		if (existing?.kind === "namespace") throw conflict(op.id, firstId(existing.ns))
		at.entries.set(leaf, { kind: "method", op })
	}
	return root
}
