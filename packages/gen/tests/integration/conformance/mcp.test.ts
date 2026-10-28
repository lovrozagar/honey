/**
 * The MCP target of the conformance grid (bit 18 phase f): mcp-runner.ts's grid driven by the official
 * @modelcontextprotocol/sdk 1.32.2 client over stdio, a legacy client negotiating 2025-11-25; bit 21 b adds the same
 * grid as a variant driven by the v2 @modelcontextprotocol/client 2.4.0 pinned to 2026-07-28, the modern era
 * (python-harness.mcp.test.ts runs Python's client in the python project). Bit 21 d: both again over Streamable HTTP,
 * the server's `--http` with its bearer token. Bit 21 e: both against the handler mounted in the reference app itself,
 * each call in process. Opt-in: `vitest run --mode harness`.
 */
import { describe } from "vitest"
import { clientSession, httpSession, withClients } from "../../../src/emit/mcp/__fixtures__/clients.ts"
import { targetSuite } from "./harness.ts"
import { MCP_TOKEN, mcpMountedRunner, mcpRunner } from "./mcp-runner.ts"

describe.skipIf(!withClients())("mcp clients", () => {
	targetSuite(mcpRunner((command, steps) => clientSession("sdk", command, steps), "2025-11-25"))
	targetSuite(
		mcpRunner((command, steps) => clientSession("modern", command, steps), "2026-07-28", "2026-07-28, v2 client"),
	)
	targetSuite(
		mcpRunner(
			(command, steps) => clientSession("sdk", command, steps, MCP_TOKEN),
			"2025-11-25",
			"http, sdk client",
			true,
		),
	)
	targetSuite(
		mcpRunner(
			(command, steps) => clientSession("modern", command, steps, MCP_TOKEN),
			"2026-07-28",
			"http, 2026-07-28, v2 client",
			true,
		),
	)
	targetSuite(
		mcpMountedRunner((target, steps) => httpSession("sdk", target, steps), "2025-11-25", "mounted, sdk client"),
	)
	targetSuite(
		mcpMountedRunner(
			(target, steps) => httpSession("modern", target, steps),
			"2026-07-28",
			"mounted, 2026-07-28, v2 client",
		),
	)
})
