/**
 * The module-level names Python types are declared under: one scope that components, hoisted declarations,
 * `<Op>Headers` and the client's resource classes all claim from, clear of every public name the runtime
 * defines (whichever runtime files an SDK ships), of the clients' own names, and of the `typing` and
 * `collections.abc` names the emitted modules import (H52).
 */
import type { IR } from "../../ir/model.ts"
import { irResolver } from "../../ir/schema.ts"
import { compareCodeUnits, NameScope, pyClassName } from "../shared/lang.ts"
import { publicNames, runtimeFiles } from "./transport.ts"
import type { PyTypeNames } from "./types.ts"

/* the names the emitted modules import or declare beside the runtime's */
const EMITTED: readonly string[] = [
	"SDK",
	"AsyncSDK",
	"ErrorKey",
	"StrEnum",
	"Any",
	"Literal",
	"NotRequired",
	"Required",
	"Self",
	"TypeAlias",
	"TypedDict",
	"AsyncIterable",
	"Iterable",
	"Sequence",
]

/** A name as asked for. */
const asked = (base: string) => base

/** Names for one schema on its own: each as asked for, refs left unresolved. */
export function plainNames(): PyTypeNames {
	return { claim: asked, hoist: (_key, base) => asked(base), ref: pyClassName, resolve: (schema) => schema }
}

/**
 * Names for the SDK of `ir`: each component claims its class name in code-unit order, as `<Name>Model` when
 * a reserved name owns it; every later declaration claims after them, a hoist key always getting the name it
 * got first.
 */
export function irNames(ir: IR): PyTypeNames {
	const runtime = Object.values(runtimeFiles({ realtime: true, ws: true })).flatMap(publicNames)
	const scope = new NameScope([...runtime, ...EMITTED])
	const components = new Map<string, string>()
	for (const name of Object.keys(ir.schemas).sort(compareCodeUnits)) {
		const base = pyClassName(name)
		components.set(name, scope.claim(scope.has(base) ? `${base}Model` : base))
	}
	const hoisted = new Map<string, string>()
	return {
		claim: (base) => scope.claim(base),
		hoist: (key, base) => {
			const name = hoisted.get(key) ?? scope.claim(base)
			hoisted.set(key, name)
			return name
		},
		/* only a declared component is referred to by name (types.ts reads a dangling ref as Any) */
		ref: (name) => components.get(name) as string,
		resolve: irResolver(ir.schemas),
	}
}
