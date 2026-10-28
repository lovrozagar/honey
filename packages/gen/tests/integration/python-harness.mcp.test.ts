/**
 * The MCP target's grid under the official Python client (bit 21 b): mcp-runner.ts's every cell driven by `mcp` 2.3.0
 * pinned to 2026-07-28, the modern era, over stdio and (bit 21 d) over Streamable HTTP with its bearer token; variants
 * of the `mcp` target; bit 21 h: against the handler mounted in the reference app, the cell's credential on the
 * client's own headers. Here, in the python project, since its client runs through python-env. Opt-in:
 * `vitest run --mode harness`.
 */
import { describe } from "vitest"
import { pythonHttpSession, pythonSession } from "../../src/emit/mcp/__fixtures__/python-client.ts"
import { withPython } from "../../src/emit/python/__fixtures__/python-env.ts"
import { targetSuite } from "./conformance/harness.ts"
import { MCP_TOKEN, mcpMountedRunner, mcpRunner } from "./conformance/mcp-runner.ts"

describe.skipIf(!withPython())("mcp python client", () => {
	targetSuite(mcpRunner(pythonSession, "2026-07-28", "2026-07-28, python client"))
	targetSuite(
		mcpRunner(
			(command, steps) => pythonSession(command, steps, MCP_TOKEN),
			"2026-07-28",
			"http, 2026-07-28, python client",
			true,
		),
	)
	targetSuite(mcpMountedRunner(pythonHttpSession, "2026-07-28", "mounted, 2026-07-28, python client"))
})
