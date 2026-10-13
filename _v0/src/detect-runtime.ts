export type ServeRuntime = "bun" | "cloudflare" | "node"

type DetectGlobal = {
	Bun?: unknown
	navigator?: { userAgent?: string }
	process?: { versions?: { node?: string } }
}

export function detectRuntime(g: DetectGlobal = globalThis): ServeRuntime {
	if (typeof g.Bun !== "undefined") return "bun"
	const ua = g.navigator?.userAgent ?? ""
	if (ua.includes("Cloudflare-Workers") || ua.includes("workerd")) return "cloudflare"
	if (g.process?.versions?.node) return "node"
	throw new Error('Honey.serve() could not detect a runtime. Pass runtime: "bun" | "node".')
}
