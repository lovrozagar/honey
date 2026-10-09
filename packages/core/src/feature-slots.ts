import type { createProxyHandler } from "./proxy.ts"
import type { createBus } from "./realtime/bus.ts"
import type { resolveRealtimeConfig } from "./realtime/route.ts"
import type { createRealtimePublisher, createRealtimeSession } from "./realtime/server.ts"
import type { compileTrust } from "./trust.ts"
import type { originAllowed } from "./ws-origin.ts"
import type { createWsSession } from "./ws/session.ts"

/**
 * Runtime features a builder method needs but most apps never call. The core imports none of
 * them, so a bundle of an app that does not use them leaves them out; each feature's entry
 * registers itself when imported. A builder method that finds its feature missing throws at
 * registration, naming the import.
 */
export type FeatureSlots = {
	proxy: { createProxyHandler: typeof createProxyHandler }
	realtime: {
		createBus: typeof createBus
		createRealtimePublisher: typeof createRealtimePublisher
		createRealtimeSession: typeof createRealtimeSession
		resolveRealtimeConfig: typeof resolveRealtimeConfig
	}
	trust: { compileTrust: typeof compileTrust }
	ws: { createWsSession: typeof createWsSession; originAllowed: typeof originAllowed }
}

export type FeatureName = keyof FeatureSlots

const ENTRY: Record<FeatureName, string> = {
	proxy: "@lovrozagar/honey/proxy",
	realtime: "@lovrozagar/honey/realtime",
	trust: "@lovrozagar/honey/trust",
	ws: "@lovrozagar/honey/ws/session",
}

const slots: { [K in FeatureName]?: FeatureSlots[K] } = {}

export function registerFeature<K extends FeatureName>(name: K, impl: FeatureSlots[K]): void {
	slots[name] = impl
}

/** Tests only: forget a registered feature. */
export function resetFeature(name: FeatureName): void {
	delete slots[name]
}

/** The registered feature, or a throw that names the import `caller` needs. */
export function requireFeature<K extends FeatureName>(name: K, caller: string): FeatureSlots[K] {
	const impl = slots[name]
	if (impl === undefined) {
		throw new Error(`honey: ${caller} requires \`import "${ENTRY[name]}"\` in the app entry.`)
	}
	return impl as FeatureSlots[K]
}

/**
 * The registered feature, importing its entry first when nothing registered it yet. Works where
 * modules load at run time (Node, Bun, Deno from `node_modules`); a bundle cannot follow the
 * opaque specifier, so there the entry must be imported (honey's WebSocket adapters do).
 */
export async function loadFeature<K extends FeatureName>(name: K, caller: string): Promise<FeatureSlots[K]> {
	const impl = slots[name]
	if (impl !== undefined) return impl as FeatureSlots[K]
	try {
		await import(/* @vite-ignore */ ENTRY[name])
	} catch {
		/* reported below, naming the import */
	}
	return requireFeature(name, caller)
}
