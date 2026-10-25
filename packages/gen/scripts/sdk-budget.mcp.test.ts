/**
 * The generated MCP server's budgets (bit 18): the vendored MCP runtime's bytes on disk (the G14 analog), measured,
 * every file named. Its per-tool and per-app token ceilings join at phase g, read from the running server's tools/list.
 */
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { MCP_RUNTIME } from "../src/emit/mcp/server.ts"
import { runtimeBytes } from "./sdk-budget.ts"

/*
 * G14 analog (bit 18), provisional until the close locks it at the exact measured bytes:
 * - phase a, 8,383 B, nothing dead to cut (each member serves the protocol a client speaks):
 *   - server.ts 4,598: initialize negotiating 2025-11-25 down to 2025-03-26, ping, tools/list and tools/call, a
 *     protocol error for each fault, outputSchema and structuredContent left out under 2025-03-26;
 *   - stdio.ts 2,212: one message a line in and out, a parse error answered, replies in order, a handler's fault
 *     answered as an internal error, the session ended once stdin closes and the last reply is out;
 *   - jsonrpc.ts 1,573: the message, the error codes, the two reply shapes, the id check;
 *   provisional 8,400.
 * - phase b, +3,615 B to 11,998 B, nothing dead to cut: call.ts 3,615, each tool bound to the SDK client, its flat
 *   arguments back into the SDK input groups (path, query, header; the body as JSON or a form), the member walked to
 *   its method, the answer as JSON text, a failure the tool's own result with its status; provisional 12,000.
 * A change raises it only by the bytes of a named feature, dead code cut first.
 */
const MCP_RUNTIME_BYTES = 12000

describe("the MCP runtime within its byte budget (bit 18, the G14 analog)", () => {
	it(`ships every runtime file it holds, all of them within ${MCP_RUNTIME_BYTES} bytes, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(resolve(import.meta.dirname, "../src/runtime/mcp"), ".ts")
		expect({ names, others, over: Math.max(0, bytes - MCP_RUNTIME_BYTES) }).toEqual({
			names: MCP_RUNTIME.map((name) => `${name}.ts`).sort(),
			others: [],
			over: 0,
		})
	})
})
