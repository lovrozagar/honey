/**
 * The generated MCP server's budgets (bit 18): the vendored MCP runtime's bytes on disk (the G14 analog), measured,
 * every file named. Its per-tool and per-app token ceilings join at phase g, read from the running server's tools/list.
 */
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { MCP_RUNTIME } from "../src/emit/mcp/runtime.ts"
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
 * - phase c, +6,569 B to 18,567 B, the general validator cut to the keywords schema.ts emits (7,088 → 5,374), then
 *   split in four for the complexity rule (+649), dead code cut (the redactor's sort and dedupe, the failure's body
 *   spread):
 *   - guard.ts 6,023: the inputSchema check 3,193 (its Schema type of the 11 keywords checked 529, the check 2,664 in
 *     four functions: own keywords, items, fields, the walk), redaction 796 (as given, URL-encoded in either case,
 *     form-encoded; keys included), the refusal composing the three 588, prototype keys 516, H18.11 decoding until
 *     stable 394, the header 430, the path helper 106;
 *   - call.ts +546: the refusal before any call, every result scrubbed, an answer's body echoed in its failure;
 *   provisional 18,600. The base URL refusal is the emitted entry's, no runtime byte.
 * A change raises it only by the bytes of a named feature, dead code cut first.
 */
const MCP_RUNTIME_BYTES = 18600

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
