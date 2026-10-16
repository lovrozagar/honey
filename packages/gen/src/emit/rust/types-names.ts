/**
 * The crate-level names Rust types are declared under: one scope that components, hoisted types and
 * the client's own declarations all claim from, clear of every item the runtime makes public at the
 * crate root (`lib.rs` re-exports each runtime module's public items), of the emitter's own `ErrorKey`,
 * and of the prelude and std names generated code relies on (H52).
 */
import type { IR } from "../../ir/model.ts"
import { irResolver } from "../../ir/schema.ts"
import { valueCycleSchemas } from "../../ir/sdk-model.ts"
import { compareCodeUnits, isRustPreludeType, NameScope, rustTypeIdent } from "../shared/lang.ts"
import { publicItems, runtimeFiles } from "./http.ts"
import type { RustTypeNames } from "./types.ts"

/**
 * The top-level `pub` items of the runtime's Rust files (contract §6.2), `ws` and `realtime` included,
 * so a component keeps its Rust name whichever runtime files its SDK ships: every
 * `pub struct|enum|trait|type|fn|const|static` at column 0, the way `go/types-names.ts` reads the Go runtime.
 */
function runtimeIdentifiers(): string[] {
	return Object.entries(runtimeFiles({ realtime: true, ws: true }))
		.filter(([name]) => name.endsWith(".rs"))
		.flatMap(([, source]) => publicItems(source))
}

/* the crate-root types the emitter itself declares beside the runtime's: errors.ts's enum */
const EMITTED: readonly string[] = ["ErrorKey"]

/** Names for one schema on its own: each as asked for, no cycles, refs left unresolved. */
export function plainNames(): RustTypeNames {
	return {
		claim: (base) => base,
		cyclic: new Set(),
		hoist: (_key, base) => base,
		ref: rustTypeIdent,
		resolve: (schema) => schema,
	}
}

/**
 * Names for the SDK of `ir`: each component claims its Rust name in code-unit order, as `<Name>Model`
 * when the runtime or the prelude owns it; hoisted types and the client's declarations claim after
 * them, a hoist key always getting the name it got first; `cyclic` is every component on a by-value cycle.
 */
export function irNames(ir: IR): RustTypeNames {
	const scope = new NameScope([...runtimeIdentifiers(), ...EMITTED])
	const components = new Map<string, string>()
	for (const name of Object.keys(ir.schemas).sort(compareCodeUnits)) {
		const base = rustTypeIdent(name)
		components.set(name, scope.claim(scope.has(base) || isRustPreludeType(base) ? `${base}Model` : base))
	}
	/* a joined name can spell a prelude one (`Hash` + `map`): that one is taken too, so the claim moves on */
	const claim = (base: string) => {
		const name = scope.claim(base)
		return isRustPreludeType(name) ? scope.claim(base) : name
	}
	const hoisted = new Map<string, string>()
	return {
		claim,
		cyclic: valueCycleSchemas(ir.schemas),
		hoist: (key, base) => {
			const name = hoisted.get(key) ?? claim(base)
			hoisted.set(key, name)
			return name
		},
		ref: (name) => components.get(name) ?? rustTypeIdent(name),
		resolve: irResolver(ir.schemas),
	}
}
