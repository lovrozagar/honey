/**
 * Runtime features a builder method needs but most apps never call. The core imports none of
 * them, so a bundle of an app that does not use them leaves them out; each feature's entry
 * registers itself when imported (a `// feature-entry:` statement the package's `sideEffects`
 * list names). A builder method that finds its feature missing throws at configuration, naming
 * the import.
 */
import type { compileTrust } from "../trust/trust.ts"

export type FeatureSlots = {
	trust: { compileTrust: typeof compileTrust }
}

export type FeatureName = keyof FeatureSlots

const ENTRY: Readonly<Record<FeatureName, string>> = { trust: "@lovrozagar/honey/trust" }

// per-process-constant: feature-slot
const slots = /* @__PURE__ */ new Map<FeatureName, FeatureSlots[FeatureName]>()

export function registerFeature<K extends FeatureName>(name: K, impl: FeatureSlots[K]): void {
	slots.set(name, impl)
}

/** Tests only: forget a registered feature. */
export function resetFeature(name: FeatureName): void {
	slots.delete(name)
}

/** The registered feature, or a throw that names the import `caller` needs. */
export function requireFeature<K extends FeatureName>(name: K, caller: string): FeatureSlots[K] {
	const impl = slots.get(name)
	if (impl === undefined) throw new Error(`honey: ${caller} requires \`import "${ENTRY[name]}"\` in the app entry.`)
	return impl as FeatureSlots[K]
}
