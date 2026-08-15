export type ServeRuntime = "bun" | "cloudflare" | "deno" | "node"

type DetectGlobal = {
	Bun?: unknown
	Deno?: unknown
	navigator?: { userAgent?: string }
	process?: { versions?: { node?: string } }
}

export function detectRuntime(g: DetectGlobal = globalThis): ServeRuntime {
	if (typeof g.Bun !== "undefined") return "bun"
	if (typeof g.Deno !== "undefined") return "deno"
	const ua = g.navigator?.userAgent ?? ""
	if (ua.includes("Cloudflare-Workers") || ua.includes("workerd")) return "cloudflare"
	if (g.process?.versions?.node) return "node"
	throw new Error('Honey.serve() could not detect a runtime. Pass runtime: "bun" | "node" | "deno".')
}
