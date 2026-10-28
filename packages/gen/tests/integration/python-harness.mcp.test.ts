/**
 * The MCP target's grid under the official Python client (bit 21 b): mcp-runner.ts's every cell driven by `mcp` 2.3.0
 * pinned to 2026-07-28, the modern era, over stdio; a variant of the `mcp` target. Here, in the python project, since
 * its client runs through python-env. Opt-in: `vitest run --mode harness`.
 */
import { describe } from "vitest"
import { pythonSession } from "../../src/emit/mcp/__fixtures__/python-client.ts"
import { withPython } from "../../src/emit/python/__fixtures__/python-env.ts"
import { targetSuite } from "./conformance/harness.ts"
import { mcpRunner } from "./conformance/mcp-runner.ts"

describe.skipIf(!withPython())("mcp python client", () => {
	targetSuite(mcpRunner(pythonSession, "2026-07-28", "2026-07-28, python client"))
})
