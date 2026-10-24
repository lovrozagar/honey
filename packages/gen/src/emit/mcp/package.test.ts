/**
 * The generated MCP server installed as a package (bit 18 phase a): node refuses to strip types under an installed
 * package's folder, so the package's bin is its compiled JavaScript. Packed with npm and installed into a fresh prefix,
 * its bin runs under node and under bun and answers alike, with no dependency fetched.
 */
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { hasNpm } from "./__fixtures__/clients.ts"
import { exchange, initialize, request, scratchDir, written } from "./__fixtures__/written.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 180_000 }
const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const DOCUMENT = {
	info: { title: "Shop", version: "1.2.0" },
	openapi: "3.1.0",
	paths: { "/items": { get: { operationId: "items.list", responses: OK, "x-mcp": true } } },
}

/** The server packed by npm and installed globally into a fresh prefix: the installed bin's path. */
function installed(): string {
	const source = written(generateMcpServer(DOCUMENT).files)
	const packs = scratchDir("pack")
	execFileSync("npm", ["pack", "--silent", "--pack-destination", packs], { cwd: source, encoding: "utf8" })
	const tarball = join(packs, readdirSync(packs).find((name) => name.endsWith(".tgz")) as string)
	const prefix = scratchDir("prefix")
	execFileSync("npm", ["install", "--global", "--offline", "--no-audit", "--no-fund", "--prefix", prefix, tarball], {
		encoding: "utf8",
	})
	return join(prefix, "bin", "shop-mcp")
}

describe.skipIf(!hasNpm())("the server installed as a package (phase a)", SLOW, () => {
	it("runs its installed bin under node and under bun, alike, with nothing fetched", async () => {
		const bin = installed()
		const lines = [initialize("2025-11-25"), request(1, "tools/list")]
		const [node, bun] = await Promise.all([exchange([process.execPath, bin], lines), exchange(["bun", bin], lines)])
		expect([
			node.status,
			node.stderr,
			(node.replies[0] as { result: { serverInfo: unknown } }).result.serverInfo,
			node.replies,
		]).toEqual([0, "", { name: "shop", version: "1.2.0" }, bun.replies])
	})
})
