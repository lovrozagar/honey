/**
 * The generated MCP server's budgets (bit 18): the vendored MCP runtime's bytes on disk (the G14 analog), locked at
 * the close, every file named; and the tokens an agent reads of each e2e app's tools (H6), read from what its running
 * server answers to tools/list.
 */
import { readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { exchange, initialize, request, written } from "../src/emit/mcp/__fixtures__/written.ts"
import { MCP_NODE, MCP_PORTABLE, MCP_RUNTIME } from "../src/emit/mcp/runtime.ts"
import { generateMcpServer } from "../src/emit/mcp/server.ts"
import { toolsOf } from "../src/emit/mcp/tools.ts"
import { type OpenApiDocument, toIR } from "../src/ir/build.ts"
import { ceilingOf, countTokens, markAllMcp } from "./capture-token-budget.ts"
import { runtimeBytes } from "./sdk-budget.ts"

const REPO = resolve(import.meta.dirname, "../../..")
const SLOW = { timeout: 120_000 }

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
 * - phase g, no runtime change. The lock: nothing dead to cut, so the ceiling is the measured 29,649 B, provisional
 *   29,700 → locked 29,649.
 * - the TS response cap (bit 11/18 fix), −81 B to 29,568 B: the SDK reads at most 1 MiB, so result.ts's note for
 *   bytes past it is dead and cut (−105, with its doc); call.ts +24 (a 2xx whose body the SDK refused is a failure).
 * - bit 19 c, +734 B to 30,302 B: guard.ts checks the constraint keywords the IR now carries (maxItems, minLength and
 *   maxLength in code points, exclusiveMinimum and exclusiveMaximum), each refusal naming the argument; pattern is
 *   stated, never run.
 * - bit 19 g, +863 B to 31,165 B: $<PREFIX>_HEADERS, a JSON object each header of which passes the SDK's own header
 *   check (request.ts headerValue, b1's rule, passed in), each value sent on every call and scrubbed from results:
 *   guard.ts configHeaders' parse and refusal +657, the redactor taking several secrets +89, two short comments +100;
 *   call.ts +17. $<PREFIX>_REDIRECT lives in the emitted entry (+0 runtime).
 * - bit 21 b, +3,997 B to 35,162 B: dual-era, MCP 2026-07-28 beside 2025-11-25 down to 2025-03-26, the protocol split
 *   from its transport. Dead code cut first: a sync-throw guard on a tool's call (every bound call is async, so it can
 *   only reject) and a branch leaving `data` off an error (JSON drops it when undefined); nothing else is dead. By file:
 *   - protocol.ts (server.ts renamed, 5,407 -> 8,730, +3,323): a modern request's `_meta` claim, read per request and
 *     never from the connection, 303; its refusals (-32602 for a `_meta` without its revision or the client's
 *     capabilities; -32022 naming every revision served and the one asked) 592; server/discover 211; the modern
 *     marks (`resultType` on every result, `ttlMs` and `cacheScope` on a list) 257; the revisions and `_meta` keys
 *     named (the modern, the batch one) 214; batches under 2025-03-26 alone 621 and their dispatch 112; the transport
 *     seam (Connection, Context and Protocol for Session) 330; isObject, shared by params, arguments, `_meta` and
 *     capabilities, 183; a handler's fault answered here, moved from stdio, 64; the complexity and length rules'
 *     split (tools/call and the refusals their own functions, the Asked type, the per-era case labels) 260; docs 176;
 *   - stdio.ts +525: notifications/cancelled aborting the call it names with nothing more written for it (each call's
 *     own abort under the stop signal, the calls by id, its writer) 502; a fault written at once and a call when
 *     done, with no promise around a reply, 172 less the parse error's queue −111; the connection's legacy revision
 *     35; the handler's fault moved to the protocol −188; docs 111; imports 4;
 *   - jsonrpc.ts +143: UnsupportedProtocolVersion (-32022) 36, an error's `data` 107;
 *   - call.ts, result.ts, stream.ts +2 each: they import protocol.ts for server.ts.
 * - bit 21 c, +7,405 B to 42,567 B: file arguments over stdio (H24). Dead code cut first: call.ts's own base64 check and
 *   Buffer decode (-280) give way to files.ts's canonical decoder, which the bytes body shares; the file schema is the
 *   emitter's (emit/mcp/files.ts, tools.gen.ts data), so no runtime byte holds it. By file:
 *   - files.ts 2,645 (new; the file-uploads extension's values): an inline FileInput checked (data present, canonical
 *     base64, the call's inline bytes capped together, decoded to its size, its SHA-256 base64url digest) 993; a file
 *     argument read or inlined, its rule as the refusal, a path's base name 609; the canonical base64 decoder (pad bits
 *     zero, atob, no Buffer) 400; the extension's identifier and server/discover's maxInlineBytes 280; the Read type
 *     126; the header 239;
 *   - reader.ts 2,623 (new; the stdio file reader, node:fs): the read 1,640 (the root realpath'd at start, a directory
 *     or no reader; the path realpath'd under it; open with no last link followed and no FIFO wait; the descriptor a
 *     regular file, the inode realpath named, within the cap, read to exactly its size, closed), the open flags 132, the
 *     refusal 120, the Disk seam a test swaps through 179, imports and header 554;
 *   - call.ts +1,659: the multipart form (each part from its argument, one or many; a file read or decoded into a
 *     Blob; text as given, else its JSON; encoded by fetch's own FormData, its boundary in the content type) +1,191;
 *     the call (the reader passed in, the inline cap, the form when the spec has parts) +234; ToolSpec's parts +173;
 *     Binding's inline cap +73; the import +56; the header +94; the decoder shared -162;
 *   - protocol.ts +374: a call's reader from its transport's context (Tool.call +48, Context +100, the call +14)
 *     +162; server/discover's extensions (createProtocol's parameter +54, the capability +35) +89; docs +123;
 *   - stdio.ts +104: serveStdio's reader into every context +46 (its parameter, the type import, the context), docs +58.
 * - bit 21 c fold-in, -350 B to 42,217 B: the file-uploads extension is advertised from bit 21 g, with its uploads, so
 *   its advertisement is dead and cut: files.ts -216 (the identifier constant and filesCapability -280, the header's
 *   note +64), protocol.ts -134 (createProtocol's extensions parameter -54, their spread in server/discover -35, docs
 *   -45). The identifier stays named in files.ts's header, where g's capability lands.
 * - bit 21 d, +12,278 B to 54,495 B: MCP's Streamable HTTP transport, dual-era and stateless, and the standalone server
 *   the bin serves with --http (H24). Nothing in the runtime it builds on was dead; in its own first cut the transport
 *   refusals' JSON-RPC bodies (403, 406, 413, 415: a MAY) were cut, and the listener's hand-written body pump gave way to
 *   node's pipeline, which also cancels the body's stream when the client leaves. By file:
 *   - http.ts 8,126 (new; web-standard, no node API, so a Worker mounts it): the reply as JSON or as an event stream
 *     from the call's first progress (unbuffered), a modern call cancelled by its closed request or stream and a legacy
 *     one by neither, 1,330; the endpoint (the body capped and parsed, -32700; an unserved MCP-Protocol-Version 400
 *     -32022 naming the revisions served; the era read from the header, absent 2025-03-26; dispatch) 1,257; a message
 *     its era refuses (a client's response 202 before 2026-07-28 and 400 in it; a modern request's headers not its
 *     body's 400 -32020, its `_meta` refused 400) 967; the Origin (its own or listed, else 403), POST (else 405 with
 *     Allow), Accept (406) and Content-Type (415) 790; MCP-Protocol-Version, Mcp-Method and Mcp-Name matched against
 *     the body 684; a `=?base64?…?=` header value decoded as UTF-8, a malformed one refused, 533; the body counted as it
 *     streams, whatever Content-Length says, 494; a reply's status (a modern unknown method 404, an unreadable message
 *     400) 374; whether a request is modern 280 and its params 155; a response 277; the options type 174; the SSE
 *     headers 109; the header and imports 702;
 *   - listen.ts 3,852 (new; node, the standalone bin's): a request's answer (a Host not a loopback name with the bound
 *     port 421, unless exposed; no bearer 401 with its challenge; a path not /mcp 404; else the handler's; a Request
 *     node cannot make 400) 1,218; the server (each answer written or piped, a response closed early aborting its
 *     request, listening) 1,034; a Request from node's (every header as sent, a repeat joined; the body a web stream;
 *     the close its signal) 446; the bearer compared on SHA-256 digests in constant time 356; the Listen type 222; the
 *     header and imports 576;
 *   - protocol.ts +210: `claimed`, a modern request's `_meta`, shared with the transport, 251 less its inline use -69;
 *     MODERN, BATCHED, VERSION, isObject and unserved exported for the transport +28;
 *   - jsonrpc.ts +90: HeaderMismatch (-32020) 25; docs 65.
 * - bit 21 e, +4,103 B to 58,598 B, now two locks, the runtime split by where it runs (H24.3): the portable part an app
 *   mounts, web APIs alone so a Worker runs it, 48,620 B (jsonrpc, protocol, files, http, guard, result, stream, call,
 *   mount), and the node part the standalone package adds, 9,978 B (stdio 3,503, reader 2,623, listen 3,852, each
 *   unchanged). Nothing in the runtime it builds on was dead; the one node call in the portable part, result.ts's
 *   Buffer, gave way to the encoder files.ts now shares. By file:
 *   - mount.ts 3,838 (new; MCP mounted in the app): the handler 1,927 (per request: the credential headers the schemes
 *     name read from it; the in-process fetch refusing a call off the app's origin, carrying them on, keeping an inner
 *     401 or insufficient_scope 403; the SDK config; the tools bound, the credentials scrubbed; the inner refusal
 *     answered as the endpoint's own, its challenge kept or the scheme's), Mounting 400, MountConfig 304, Mounted 270,
 *     Mount 260, the header and imports 677;
 *   - files.ts +251: `encoded`, base64 32 KiB at a time with no Buffer, +282; the inline digest through it -31;
 *   - result.ts +14: a bytes result's base64 through `encoded` (its import +38, Buffer's call -24).
 * A change raises a lock only by the bytes of a named feature, dead code cut first.
 */
const MCP_PORTABLE_BYTES = 48620
const MCP_NODE_BYTES = 9978

const RUNTIME_DIR = resolve(import.meta.dirname, "../src/runtime/mcp")

/** The bytes on disk of the runtime `modules`. */
const bytesOf = (modules: readonly string[]) =>
	modules.reduce((sum, name) => sum + statSync(join(RUNTIME_DIR, `${name}.ts`)).size, 0)

describe("the MCP runtime within its byte budget (bit 18, the G14 analog)", () => {
	it(`ships every runtime file it holds, the portable within ${MCP_PORTABLE_BYTES} bytes and the node within ${MCP_NODE_BYTES}, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(RUNTIME_DIR, ".ts")
		expect({
			names,
			others,
			over: [bytesOf(MCP_PORTABLE) - MCP_PORTABLE_BYTES, bytesOf(MCP_NODE) - MCP_NODE_BYTES].map((by) =>
				Math.max(0, by),
			),
			whole: bytes === bytesOf(MCP_RUNTIME),
		}).toEqual({
			names: MCP_RUNTIME.map((name) => `${name}.ts`).sort(),
			others: [],
			over: [0, 0],
			whole: true,
		})
	})
})

/** What an agent reads of an MCP server, in o200k tokens: its whole tools/list answer, and its largest tool. */
type Tools = { readonly total: number; readonly largest: number }

/*
 * H6 (bit 18 phase g): the MCP server's own ceilings, each app's own, at ceilingOf(measured, 0.2). Measured from each
 * e2e app's running server (tools/list over stdio, the answer as it is written), every operation opted in by
 * markAllMcp. A list over its ceiling is fixed in the emitter or the schema, never by raising the ceiling; a raise names
 * the feature that adds the tokens.
 * - bit 19 c, the constraint keywords stated in each inputSchema (+17 tokens): surface's four `minLength: 1` arguments,
 *   2,110 -> 2,127 total, its largest tool unchanged at 205; the other four apps declare no constraint and are unchanged.
 * - bit 19 j1, the cutover: kitchen's document is v1's. /api/generated-tree retired with its route (one tool fewer);
 *   carry-in #7 declares /api/events and /api/events-live as text/event-stream, so each is the emitter's stream-collect
 *   tool (max_events, last_event_id, the events array), 186 and 187 tokens as surface's /out/sse is 205: kitchen
 *   627 -> 905 total, its largest 71 -> 187 (get_api_events_live). The other four apps are unchanged.
 * - bit 21 b, the modern era (2026-07-28): its tools/list carries `resultType`, `cacheScope` and `ttlMs` (+16 tokens in
 *   every app's total: compose 379, defaults 143, gateway 383, kitchen 921, surface 2,143), each tool as the legacy list
 *   has it, so every largest is unchanged; the legacy list is unchanged. Both eras are held to the same ceilings: no
 *   raise.
 * - bit 21 c, multipart operations as tools (H24): surface's POST /in/file is a tool, post_in_file, 177 tokens (its
 *   `file` part a file argument, 98 tokens of the file schema: the extension's FileInput marked and required, its
 *   digest's algorithm, or a path); surface 2,127 -> 2,304 total, its largest still the SSE tool's 205, so ceilings
 *   2,553 -> 2,765 total, 246 largest unchanged. The other four apps have no multipart operation and are unchanged.
 * - bit 21 e, a sixth app, mcp (MCP mounted in the app): Anyrow's five multipart operations as tools, 1,509 tokens
 *   (1,525 in 2026-07-28), its largest extract_stream's 355 (a file argument, five text arguments, the collect's two and
 *   its events), under H6's ~400; ceilings 1,811 total, 426 largest. The other five apps are unchanged.
 * - bit 21 e fold-in: H6 is a gate. Every app's largest-tool ceiling is min(ceilingOf(measured, 0.2), 400), one rule
 *   (largestCeiling), so mcp's 426 is 400; every other app's is under 400 already (compose 87, defaults 62, gateway
 *   170, kitchen 225, surface 246) and unchanged.
 */
const MEASURED: Readonly<Record<string, Tools>> = {
	compose: { largest: 72, total: 363 },
	defaults: { largest: 51, total: 127 },
	gateway: { largest: 141, total: 367 },
	kitchen: { largest: 187, total: 905 },
	mcp: { largest: 355, total: 1509 },
	surface: { largest: 205, total: 2304 },
}
const TOKEN_HEADROOM = 0.2

/* H6 (00-rules): ~400 tokens a tool schema at most, so no app's largest-tool ceiling passes it (bit 21 e fold-in) */
const TOOL_MAX = 400

/** An app's largest-tool ceiling: its measured largest with the headroom, never past H6's TOOL_MAX. */
const largestCeiling = (measured: number) => Math.min(ceilingOf([measured], TOKEN_HEADROOM), TOOL_MAX)

/** An e2e app's emitted OpenAPI document, every operation opted into the MCP server. */
const appSpec = (app: string) =>
	markAllMcp(
		JSON.parse(readFileSync(join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`), "utf8")) as {
			paths?: Record<string, Record<string, unknown>>
		},
	) as Record<string, unknown>

/** A modern tools/list's `_meta`: the revision and the client's capabilities (bit 21 b). */
const MODERN = {
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
}

/**
 * `app`'s server run: what tools/list answers in each era (2025-11-25, then 2026-07-28), each measured, beside what the
 * emitter wrote and what it skipped.
 */
async function toolsOfApp(app: string) {
	const document = appSpec(app)
	const ir = toIR(document as OpenApiDocument, { deriveOperationIds: true })
	const server = generateMcpServer(document, { envPrefix: "APP", name: "app" })
	const dir = written(server.files)
	const ran = await exchange(
		["env", "APP_BASE_URL=http://127.0.0.1:9", process.execPath, join(dir, "dist", "server.js")],
		[initialize("2025-11-25"), request(1, "tools/list"), request(2, "tools/list", { _meta: MODERN })],
	)
	const answers = [1, 2].map(
		(id) =>
			(
				ran.replies.find((reply) => (reply as { id?: unknown }).id === id) as {
					result: { tools: Record<string, unknown>[] }
				}
			).result,
	)
	return {
		emitted: toolsOf(ir).map((tool) => tool.name),
		listed: answers.map((answer) => answer.tools.map((tool) => tool.name)),
		measured: answers.map((answer): Tools => ({
			largest: Math.max(...answer.tools.map((tool) => countTokens(JSON.stringify(tool)))),
			total: countTokens(JSON.stringify(answer)),
		})),
		operations: ir.operations.length,
		skipped: server.skipped.length,
	}
}

describe("H6's per-tool cap (bit 21 e fold-in)", () => {
	it("caps every app's largest-tool ceiling at 400 tokens", () => {
		const over = Object.entries(MEASURED)
			.map(([app, tools]) => [app, largestCeiling(tools.largest)] as const)
			.filter(([, ceiling]) => ceiling > TOOL_MAX)
		expect(over).toEqual([])
	})
})

describe("the MCP server's tokens within each app's ceilings (bit 18 phase g, H6)", SLOW, () => {
	it.each(Object.keys(MEASURED))(
		"keeps %s's tools/list within ceilingOf(measured, 0.2) and its largest tool within that capped at 400, in either era",
		async (app) => {
			const { emitted, listed, measured, operations, skipped } = await toolsOfApp(app)
			const pinned = MEASURED[app] as Tools
			/* completeness: every operation a tool listed or a skip named, so none can pass by going unread */
			expect(listed.map((names) => ({ accounted: names.length + skipped, names }))).toEqual(
				[0, 1].map(() => ({ accounted: operations, names: emitted })),
			)
			expect(
				measured.map((each) => ({
					largest: each.largest <= largestCeiling(pinned.largest) && each.largest > 0,
					total: each.total <= ceilingOf([pinned.total], TOKEN_HEADROOM) && each.total > 0,
				})),
			).toEqual([0, 1].map(() => ({ largest: true, total: true })))
		},
	)
})
