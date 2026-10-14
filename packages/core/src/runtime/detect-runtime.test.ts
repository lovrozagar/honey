import { describe, expect, it } from "vitest"
import { detectRuntime } from "./detect-runtime.ts"

const node = { process: { versions: { node: "26.10.0" } } }

describe("detectRuntime: which runtime this process is", () => {
	// v0: 481a9a3cb7
	it.each([
		["Bun's global", { Bun: {}, ...node }, "bun"],
		["the Workers user agent", { navigator: { userAgent: "Cloudflare-Workers" } }, "cloudflare"],
		["workerd's user agent", { navigator: { userAgent: "workerd/1.2" } }, "cloudflare"],
		["Node's version", node, "node"],
		["Node's version beside a browser-like navigator", { navigator: { userAgent: "Node.js/26" }, ...node }, "node"],
	])("%s → %s", (_source, g, runtime) => {
		expect(detectRuntime(g)).toBe(runtime)
	})

	it("reads the real globals by default", () => {
		expect(detectRuntime()).toBe(typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun")
	})

	it.each([{}, { navigator: {} }, { process: { versions: {} } }, { process: {} }])(
		"%j: no runtime it can serve on is an error, never a guess",
		(g) => {
			expect(() => detectRuntime(g)).toThrow("could not detect the runtime: expected Bun, Node, or Cloudflare Workers")
		},
	)
})
