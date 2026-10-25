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
 * - phase d, +4,732 B to 23,299 B, dead code cut (a status-0 failure branch no guarded call reaches):
 *   - result.ts 4,100: a 2xx as structuredContent (an object, or wrapped `{result, headers}`) and text 920, bytes as
 *     image, audio or an embedded resource and the 1 MiB note 696, a failure's status with honey's error key and
 *     message or its body 616, the 100,000-character text cut and JSON text 495, the transport and timeout kinds 400,
 *     the safe-mode Answer type 231, the caps 167, the scrubber type 121, the header 454;
 *   - call.ts +632: a raw body argument (base64-decoded bytes at most 1 MiB, or text, under its content type), the
 *     safe-mode answer routed to result.ts, outputSchema and annotations listed;
 *   provisional 23,400.
 * - phase e, +6,172 B to 29,471 B:
 *   - stream.ts 3,151: an event stream's bounded collect (end, max_events, the 100,000-character cap, the call's
 *     timeout from its start as one AbortSignal), last_event_id to resume, each event a progress step, a cut a success
 *     and a never-opened stream a timeout;
 *   - call.ts +1,017: an SSE tool dispatched to the collect on a client of its own whose answer says it opened, the
 *     session's abort on every call, a stream refused outside 2xx its failure, the binding;
 *   - server.ts +767: notifications/progress for a call carrying a progressToken; a fault answered at once, a tool's
 *     call through its promise;
 *   - stdio.ts +662: every message answered as it comes, calls side by side, one writer; a stop signal aborting every
 *     call in flight, settling once they have, no later reply written;
 *   - guard.ts +568: minimum and maximum (max_events 1 to 100); result.ts +7 (TEXT_MAX exported);
 *   provisional 29,500.
 * - phase f, +178 B to 29,649 B: the status the API answered in a result's `_meta` (honey/status), observable to the
 *   conformance harness and to any client reading it: call.ts +136 (the spread on both answered paths), server.ts +42
 *   (ToolResult's `_meta`); provisional 29,700.
 * A change raises it only by the bytes of a named feature, dead code cut first.
 */
const MCP_RUNTIME_BYTES = 29700

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
