/**
 * The runtime is named for the product: `workers`, never the company. Platform facts keep their spelling, because
 * the platform spells them (`cf-connecting-ip`, the `Cloudflare-Workers` agent, `cloudflare:workers`).
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { detectRuntime } from "../../src/runtime/detect-runtime.ts"

const CORE = resolve(import.meta.dirname, "../..")
const read = (path: string) => readFileSync(resolve(CORE, path), "utf8")

describe("the workers runtime's public name", () => {
	it("no subpath names the company", () => {
		const { exports } = JSON.parse(read("package.json")) as { exports: Record<string, unknown> }
		expect(Object.keys(exports).filter((subpath) => /cloudflare|(^|\/)cf($|\/)/.test(subpath))).toEqual([])
		expect(Object.keys(exports)).toContain("./ws/workers")
	})

	it("detection answers workers, for both of the platform's agents", () => {
		const answers = ["Cloudflare-Workers", "workerd/1.2"].map((userAgent) =>
			detectRuntime({ navigator: { userAgent } }),
		)
		expect(answers).toEqual(["workers", "workers"])
	})

	it("the adapter carries the name", () => {
		expect(read("src/ws/workers.ts")).toContain("export function workersWebSocket(")
		expect(read("src/runtime/detect-runtime.ts")).toContain('"bun" | "node" | "workers"')
	})

	it("the platform's own spellings stay", () => {
		expect(read("src/context/peer.ts")).toContain('"cf-connecting-ip"')
		expect(read("src/context/peer.ts")).toContain('"Cloudflare-Workers"')
	})
})
