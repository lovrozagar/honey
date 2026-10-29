/**
 * The package-level names Go types are declared under (v0 buildGoNames): one scope that components,
 * hoisted types and constants all claim from, clear of every identifier the Go runtime declares.
 */
import { type IR } from "../../ir/model.ts"
import { irResolver } from "../../ir/schema.ts"
import { valueCycleSchemas } from "../../ir/sdk-model.ts"
import { compareCodeUnits, goExported, NameScope } from "../shared/lang.ts"
import { runtimeFiles } from "./http.ts"
import type { GoTypeNames } from "./types.ts"

/** The package-level identifiers one Go source declares: `func`, `type`, `var` and `const`, grouped or not. */
function declared(source: string): string[] {
	const names: string[] = []
	let grouped = false
	for (const line of source.split("\n")) {
		const single = /^(?:func|type|var|const)\s+([A-Za-z_]\w*)/.exec(line)?.[1]
		const member = grouped ? /^\t([A-Za-z_]\w*)/.exec(line)?.[1] : undefined
		if (single !== undefined) names.push(single)
		if (member !== undefined) names.push(member)
		if (/^(?:var|const|type)\s*\($/.test(line)) grouped = true
		else if (line.startsWith(")")) grouped = false
	}
	return names
}

/**
 * Every identifier the runtime's Go files declare at package level (v0 goRuntimeIdentifiers): the
 * whole runtime, so a component keeps its Go name whichever runtime files its SDK ships.
 */
function runtimeIdentifiers(): string[] {
	return Object.values(runtimeFiles({ realtime: true, ws: true })).flatMap(declared)
}

/** Names for one schema on its own (v0 DEFAULT_NAMES): each as asked for, no cycles, refs left unresolved. */
export function plainNames(): GoTypeNames {
	return {
		claimConst: (base) => base,
		cyclic: new Set(),
		hoist: (_key, base) => base,
		ref: goExported,
		resolve: (schema) => schema,
	}
}

/**
 * Names for the SDK of `ir`: each component claims its exported name in code-unit order, as
 * `<Name>Model` when the runtime or the client owns it; hoisted types and constants claim after
 * them, a key always getting the name it got first; `cyclic` is every component on a by-value cycle.
 */
export function irNames(ir: IR): GoTypeNames {
	const scope = new NameScope([...runtimeIdentifiers(), "Client", "NewClient", "SafeClient"])
	const components = new Map<string, string>()
	for (const name of Object.keys(ir.schemas).sort(compareCodeUnits)) {
		const base = goExported(name)
		components.set(name, scope.claim(scope.has(base) ? `${base}Model` : base))
	}
	const hoisted = new Map<string, string>()
	return {
		claimConst: (base) => scope.claim(base),
		cyclic: valueCycleSchemas(ir.schemas),
		hoist: (key, base) => {
			const name = hoisted.get(key) ?? scope.claim(base)
			hoisted.set(key, name)
			return name
		},
		ref: (name) => components.get(name) ?? goExported(name),
		resolve: irResolver(ir.schemas),
	}
}
