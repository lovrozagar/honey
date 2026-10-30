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
import { MOUNTED_FILE_SCHEMA } from "../src/emit/mcp/files.ts"
import { toolsOf, type ToolSpec } from "../src/emit/mcp/tools.ts"
import { type OpenApiDocument, toIR } from "../src/ir/build.ts"
import { ceilingOf, countTokens, markAllMcp } from "./capture-token-budget.ts"
import { runtimeBytes } from "./sdk-budget.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const REPO = resolve(import.meta.dirname, "../../..")
const SLOW = { timeout: 120_000 }

/*
 * G14 analog (bit 18), locked at the bit 21 close: the bytes on disk of the vendored runtime, two locks by where it
 * runs (H24.3). Every byte is named below by file and feature (each file's features sum to it, the files to the lock);
 * a file's header comment and imports are one item. A change raises a lock only by the bytes of a named feature, dead
 * code cut first.
 *
 * The portable part, 58,402 B: web APIs alone, so an app mounts it on Workers, Node or Bun.
 * - protocol.ts 10,019: createProtocol 2,422 (initialize per request and stateless, ping, server/discover, tools/list,
 *   the dispatch by era); tools/call 1,464 (an unknown tool, its arguments, an input request or invalid params, the
 *   result, a fault answered as an internal error); the types (ToolResult, Outcome, Tool, ServerInfo, Connection,
 *   Context, Protocol) 1,742; header and imports 1,096; a modern request's `_meta` claim and its refusals (-32602,
 *   -32022 naming every revision served) 992; a tool listed and a result shaped per revision 760; batches under
 *   2025-03-26 alone 621; the revisions and `_meta` keys named 537; the modern marks (resultType, cacheScope, ttlMs)
 *   195; isObject 190.
 * - files.ts 9,142 (the file-uploads extension, PR head 6101d34): the upload flow (`retried` 1,672: one outcome a
 *   file, a failed one the tool's error, each file's bytes taken once, a token the call does not hold invalid params;
 *   `asked` 1,025: each size within the cap and its SHA-256 well formed, the input request, the tokens as
 *   requestState; `staged` 1,054: a 2026-07-28 request declaring the extension, its file ids distinct) 3,751; the types
 *   (Read, FetchFile, Scope, Declared, Uploads, Files, Pending) 1,483; fileOf (a value read, inlined, uploaded or
 *   fetched under the call's signal) 1,018; an inline FileInput checked (data present, the call's inline bytes capped
 *   together, its size and digest) 710; canonical base64 in and out, no Buffer 682; header and the identifier 622; the
 *   FileInput's name and declared size and digest 425; the SHA-256 digest 281; the advertisement 170.
 * - http.ts 8,309 (Streamable HTTP, dual-era, stateless): the reply as JSON or as an event stream from the first
 *   progress, a modern call cancelled by its closed request or stream 1,405; serveHttp (the endpoint: the body capped
 *   and parsed, an unserved MCP-Protocol-Version, dispatch) 1,299; a message its era refuses (a client's response,
 *   headers not the body's, `_meta` refused) 967; Origin, POST, Accept and Content-Type 790; header and imports 714;
 *   MCP-Protocol-Version, Mcp-Method and Mcp-Name matched to the body 684; a `=?base64?…?=` value decoded 533; the body
 *   counted as it streams 494; a message's params and era 435; a reply's status 374; a response 277; the options 228;
 *   the SSE headers 109.
 * - guard.ts 8,171: the inputSchema check (items, fields, own keywords, ranges, the walk) 3,525; the redactor (as
 *   given, URL- and form-encoded, keys included) 849; $<PREFIX>_HEADERS parsed and refused 793; the Schema type of the
 *   keywords checked 741; the refusal 588; prototype keys 516; header 430; H18.11's path segment 394; type and
 *   equality helpers 229; the path helper 106.
 * - call.ts 8,237: bindTools (each tool bound to the SDK client, refused before any call, scrubbed, its answer or its
 *   collect) 2,085; the multipart form (each part from its argument; a file staged, read or decoded into a Blob; text as
 *   given, else its JSON) 1,678; ToolSpec 1,268; flat arguments back into the SDK's input groups 1,157; header and
 *   imports 1,123; the member walked to its method 364; Binding 335; SdkClient 126; Group 101.
 * - mount.ts 5,547 (MCP mounted in the app): mountedMcp (per request: the credential headers its schemes name, the
 *   in-process fetch refusing a call off the app's origin and keeping an inner 401 or insufficient_scope 403, the SDK
 *   config, each call bound to 30 s, the tools bound and the credentials scrubbed, the files handed on, the inner
 *   refusal answered as the endpoint's own) 2,394; header and imports 978; no file argument showing `{url}` without the
 *   app's fetch 831; Mount 419; Mounting 351; MountConfig 304; Mounted 270.
 * - result.ts 4,018: a 2xx as structuredContent and text 920; a failure's status, error key and message or body 616;
 *   bytes as image, audio or an embedded resource 548; header and imports 513; text and JSON results, the text cap 495;
 *   a call with no answer (transport, timeout) 400; Answer 231; the caps 174; Scrub 121.
 * - stream.ts 3,153: an event stream's bounded collect (end, max_events, the text cap, the call's bound) 1,075; each
 *   event read, a progress step, resumed by last_event_id 1,059; header and imports 573; its types 446.
 * - jsonrpc.ts 1,806: the reply makers 401; the message and id types 338; header 304; Reply 304; the error codes 269;
 *   the id check 190.
 *
 * The node part, 10,016 B: what the standalone package adds.
 * - stdio.ts 3,541: serveStdio (one message a line, each answered as it comes, calls by id with their own abort,
 *   notifications/cancelled, one writer, a stop aborting every call in flight) 2,224; header and imports 952; the
 *   Stdio seam 365.
 * - listen.ts 3,852: a request's answer (a Host not served 421, no bearer 401, another path 404) 1,218; the server
 *   (each answer written or piped, a closed response aborting its request) 1,034; header and imports 576; a Request
 *   from node's 446; the bearer compared on SHA-256 digests in constant time 356; Listen 222.
 * - reader.ts 2,623: the read (the root realpath'd, the path under it, no last link followed, no FIFO wait, a regular
 *   file and the inode realpath named, within the cap, read to exactly its size) 1,638; header and imports 554; the
 *   Disk seam 179; the open flags 132; the refusal 120.
 *
 * History (the whole, then the portable and node locks): bit 18 closed at 29,649; the TS response cap -81 to 29,568;
 * bit 19 c +734 to 30,302; bit 19 g +863 to 31,165 (bit 21's start); bit 21 b +3,997 to 35,162 (dual-era); c +7,405
 * to 42,567 (file arguments over stdio); c's fold-in -350 to 42,217; d +12,278 to 54,495 (Streamable HTTP, the
 * standalone --http); e +4,103 to 58,598, split into portable 48,620 and node 9,978 (the mount); g +9,800 portable and
 * +38 node to 58,420 and 10,016 (uploads and URL files); h -18 portable to 58,402 (the mount's unused timeout option
 * cut); i1 +190 portable to 58,592, the tools on the SDK's safe twin (`client.safe`): call.ts +292 (each REST tool
 * read off its Result, an error status's JSON object body still its failure, +232 with the catch's dropped `data`;
 * SdkClient's `safe` and the twin walked, +11; the header naming the twin, +49), result.ts -47 (Answer the Result's
 * shape, failureOf's own two fields), mount.ts -55 (the dead `throwOnError: false`, field and value, cut). Bit 21 in all: +37,443 B over its start, 31,165 -> 68,608.
 */
const MCP_PORTABLE_BYTES = 58592
/* the node part's own tail of that history: bit 21 g, +38 B to 10,016 B, and untouched since. */
const MCP_NODE_BYTES = 10016

const RUNTIME_DIR = resolve(import.meta.dirname, "../src/runtime/mcp")

/** The bytes on disk of the runtime `modules`. */
const bytesOf = (modules: readonly string[]) =>
	modules.reduce((sum, name) => sum + statSync(join(RUNTIME_DIR, `${name}.ts`)).size, 0)

describe("the MCP runtime within its byte budget (bit 18, the G14 analog)", () => {
	it(
		`ships every runtime file it holds, the portable exactly ${MCP_PORTABLE_BYTES} bytes and the node ${MCP_NODE_BYTES}, nothing else beside them`,
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const { bytes, names, others } = runtimeBytes(RUNTIME_DIR, ".ts")
			expect({
				names,
				others,
				parts: [bytesOf(MCP_PORTABLE), bytesOf(MCP_NODE)],
				whole: bytes === bytesOf(MCP_RUNTIME),
			}).toEqual({
				names: MCP_RUNTIME.map((name) => `${name}.ts`).sort(),
				others: [],
				parts: [MCP_PORTABLE_BYTES, MCP_NODE_BYTES],
				whole: true,
			})
		},
	)
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
 * - bit 21 g, remote files: no standalone tool changes. A mounted tool's file argument shows the URL value in place of
 *   the path (97 tokens, one fewer), or, on a mount without urlFiles, the FileInput alone (64, 34 fewer); so no mounted
 *   tool costs more than its standalone one (Anyrow's extract_once 393 -> 392 mounted, 359 without urlFiles).
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

/** `spec`'s tokens as tools/list shows it (2025-11-25 on, with its outputSchema). */
const listedTokens = (spec: ToolSpec) =>
	countTokens(
		JSON.stringify({
			name: spec.name,
			...(spec.description === undefined ? {} : { description: spec.description }),
			inputSchema: spec.inputSchema,
			...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
			...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
		}),
	)

describe("a mounted tool's tokens (bit 21 g)", () => {
	it.each(["mcp", "surface"])("costs no more than %s's standalone tool, with or without the URL value", (app) => {
		const ir = toIR(appSpec(app) as OpenApiDocument, { deriveOperationIds: true })
		const urlless = { anyOf: (MOUNTED_FILE_SCHEMA.anyOf as object[]).slice(0, 1) }
		const [standalone, mounted, bare] = [undefined, MOUNTED_FILE_SCHEMA, urlless].map((file) =>
			toolsOf(ir, file).map(listedTokens),
		)
		const over = (standalone as number[]).flatMap((tokens, at) =>
			[mounted, bare].flatMap((each) => (((each as number[])[at] as number) > Math.min(tokens, TOOL_MAX) ? [at] : [])),
		)
		expect([over, (standalone as number[]).length]).toEqual([[], (mounted as number[]).length])
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
