/**
 * The mounted resource server under the official Python client's OAuth (bit 21 f): `mcp` 2.3.0's `OAuthClientProvider`,
 * pinned to 2026-07-28, against core's OAuth world (an orders app whose endpoint is mounted with `oauth`, and a stub
 * authorization server), started under Bun as gen starts core's conformance app, so gen imports nothing of core.
 * From a bare connect: 401, the metadata, the authorization server, PKCE and the endpoint as `resource`, the call; a
 * call needing more scope gets the 403 step-up and re-authorizes for the union. In the `python` project.
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { describe, expect, it } from "vitest"
import { withPython } from "../python/__fixtures__/python-env.ts"
import { type OAuthTarget, pythonOAuthSession } from "./__fixtures__/python-client.ts"

const WORLD = new URL("../../../../core/tests/integration/mcp-oauth/serve.ts", import.meta.url).pathname

/** The world started, the Python session run against it, then the world's log of every request it answered. */
async function run(): Promise<[Record<string, unknown>, OAuthTarget, readonly string[]]> {
	const child = spawn("bun", ["-e", `await (await import(${JSON.stringify(WORLD)})).main()`], {
		stdio: ["pipe", "pipe", "inherit"],
	})
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
	try {
		const target = JSON.parse(String((await lines.next()).value)) as OAuthTarget
		const saw = await pythonOAuthSession(target)
		child.stdin.end()
		const { log } = JSON.parse(String((await lines.next()).value)) as { log: readonly string[] }
		return [saw, target, log]
	} finally {
		child.kill()
	}
}

describe.skipIf(!withPython())("the mounted resource server under the Python client's OAuth (bit 21 f)", () => {
	it("mcp 2.3.0: 401 → metadata → authorization server → PKCE token for the endpoint → call; 403 → step-up → call", async () => {
		const [saw, { endpoint }, log] = await run()
		const steps = log.filter(
			(line) => line.startsWith("as ") || / 40[13]$/.test(line) || line.includes("/.well-known/"),
		)
		expect([saw, steps]).toEqual([
			{
				authorizations: ["orders:read", "orders:read orders:write"],
				created: expect.objectContaining({ _meta: { "honey/status": 201 }, structuredContent: { created: "o-2" } }),
				read: expect.objectContaining({ _meta: { "honey/status": 200 }, structuredContent: { orders: ["o-1"] } }),
				tools: ["get_orders", "post_orders"],
			},
			[
				"app POST /mcp 401",
				"app GET /.well-known/oauth-protected-resource/mcp 200",
				"as GET /.well-known/oauth-authorization-server 200",
				`as authorize scope=orders:read resource=${endpoint} method=S256`,
				"as GET /authorize 302",
				`as token resource=${endpoint} pkce=true`,
				"as POST /token 200",
				"app POST /mcp 403",
				`as authorize scope=orders:read orders:write resource=${endpoint} method=S256`,
				"as GET /authorize 302",
				`as token resource=${endpoint} pkce=true`,
				"as POST /token 200",
			],
		])
	}, 300_000)
})
