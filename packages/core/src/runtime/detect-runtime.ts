/** The runtimes honey serves on. Cloudflare Workers is detected so `serve()` can say to export the app instead. */
export type ServeRuntime = "bun" | "cloudflare" | "node"

type RuntimeGlobals = {
	readonly Bun?: unknown
	readonly navigator?: { readonly userAgent?: string }
	readonly process?: { readonly versions?: { readonly node?: string } }
}

/** Bun first: it also reports a Node version. `g` is the global object, swapped in tests. */
export function detectRuntime(g: RuntimeGlobals = globalThis): ServeRuntime {
	if (g.Bun !== undefined) return "bun"
	const agent = g.navigator?.userAgent ?? ""
	if (agent.startsWith("Cloudflare-Workers") || agent.startsWith("workerd")) return "cloudflare"
	if (g.process?.versions?.node !== undefined) return "node"
	throw new Error("serve() could not detect the runtime: expected Bun, Node, or Cloudflare Workers")
}
