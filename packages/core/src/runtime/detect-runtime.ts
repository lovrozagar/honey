/** The runtimes honey serves on. Cloudflare Workers is detected so `serve()` can say to export the app instead. */
export type ServeRuntime = "bun" | "cloudflare" | "node"

/** The slice of the global object `detectRuntime` inspects. */
type RuntimeGlobals = {
	/** Bun's own global: any defined value means Bun, whatever the other fields say. */
	readonly Bun?: unknown
	/** Read only for its user agent. */
	readonly navigator?: {
		/** Starts with `Cloudflare-Workers` or `workerd` on Cloudflare Workers. Unset counts as neither. */
		readonly userAgent?: string
	}
	/** Read only for `versions.node`. */
	readonly process?: {
		/** Version strings of the runtime and its components, keyed by component. */
		readonly versions?: {
			/** Set on Node, which is how Node is recognized. Bun sets it too, so `Bun` is checked first. */
			readonly node?: string
		}
	}
}

/** Bun first: it also reports a Node version. `g` is the global object, swapped in tests. */
export function detectRuntime(g: RuntimeGlobals = globalThis): ServeRuntime {
	if (g.Bun !== undefined) return "bun"
	const agent = g.navigator?.userAgent ?? ""
	if (agent.startsWith("Cloudflare-Workers") || agent.startsWith("workerd")) return "cloudflare"
	if (g.process?.versions?.node !== undefined) return "node"
	throw new Error("serve() could not detect the runtime: expected Bun, Node, or Cloudflare Workers")
}
