/**
 * The MCP-only rows of the conformance grid (bit 18 f): what the MCP server's tools/list and results say of the
 * reference app, read by mcp.test.ts. Every value is what the emitter writes for the app's served document.
 */
import { call, hop, OCTET, SHA_256B } from "./cells.ts"
import type { Call, Expected, Feature, Scenario } from "./matrix.ts"

/** An MCP-only row's read: what the runner reads of the server instead of an answer. */
const read = (mcp: NonNullable<Call["mcp"]>, more: Partial<Call> = {}): Call => ({
	mcp,
	operation: "",
	route: { method: "", path: "" },
	...more,
})

/** An MCP-only row's observation. */
const mcp = (value: Expected): Expected => ({ kind: "mcp", value })

/** The reference app's tools: every operation marked x-mcp a tool serves, `health` left unmarked (Q8). */
const TOOLS = [
	"boundary_custom",
	"boundary_default",
	"echo_get",
	"errors_declared",
	"errors_status",
	"events_append",
	"events_stream",
	"files_get",
	"files_put",
	"idempotent_create",
	"items_create",
	"items_delete",
	"items_get",
	"items_list",
	"items_patch",
	"items_update",
	"ping",
	"redirect_cross_origin",
	"ticks_stream",
	"timing_slow",
	"uploads_blob",
	"users_create",
	"users_delete",
	"users_get",
	"users_list",
	"users_update",
	"validated_create",
]

/** An item as the reference app answers it, as JSON Schema. */
const ITEM_SCHEMA = {
	additionalProperties: false,
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

/** The reference app's tools/list measured in o200k tokens (ceilingOf(measured, 0.2)): the whole list, its largest tool. */
const TOKENS_TOTAL = 2766
const TOKENS_LARGEST = 244

/** Rows only the MCP server runs (bit 18 f). */
const mcpOnly = (id: string, asserted: string, scenarios: Scenario[]): Feature => ({
	asserted,
	id,
	scenarios,
	targets: ["mcp"],
})

/** The MCP-only rows. */
export const MCP_ROWS: readonly Feature[] = [
	mcpOnly("gating", "tools/list lists every operation marked x-mcp a tool serves, and no other", [
		{ calls: [read({ read: "names" })], expect: [mcp(TOOLS)], id: "marked-only" },
	]),
	mcpOnly("output-schema", "an object answer's schema as it is; any other, and one with declared headers, wrapped", [
		{
			calls: [read({ read: "outputSchema", tools: ["items_create", "items_get", "items_list", "files_get"] })],
			expect: [
				mcp({
					files_get: null,
					items_create: ITEM_SCHEMA,
					items_get: {
						properties: {
							headers: { properties: { "x-item-version": { type: "string" } }, type: "object" },
							result: ITEM_SCHEMA,
						},
						required: ["result"],
						type: "object",
					},
					items_list: {
						properties: { result: { items: ITEM_SCHEMA, type: "array" } },
						required: ["result"],
						type: "object",
					},
				}),
			],
			id: "wrapped-or-not",
		},
	]),
	mcpOnly("annotations", "each method's hints, only where they differ from the spec's defaults", [
		{
			calls: [
				read({
					read: "annotations",
					tools: ["items_list", "items_create", "items_update", "items_patch", "items_delete", "idempotent_create"],
				}),
			],
			expect: [
				mcp({
					idempotent_create: { destructiveHint: false, idempotentHint: true },
					items_create: { destructiveHint: false },
					items_delete: { idempotentHint: true },
					items_list: { readOnlyHint: true },
					items_patch: null,
					items_update: { idempotentHint: true },
				}),
			],
			id: "by-method",
		},
	]),
	mcpOnly("binary-result", "bytes come back as an embedded resource of their media type", [
		{
			calls: [
				{ ...call("files.get", "GET", "/v1/files/:name", { params: { name: "blob.bin" } }), mcp: { read: "content" } },
			],
			expect: [
				mcp([{ mimeType: OCTET, sha256: SHA_256B, size: 256, type: "resource", uri: "honey://files_get/result" }]),
			],
			id: "resource",
			wire: [hop("GET", "/v1/files/blob.bin", { headers: { accept: OCTET } })],
		},
	]),
	mcpOnly("token-budget", "the tools/list an agent reads stays within its measured budget, whole and per tool", [
		{
			calls: [read({ read: "tokens" })],
			expect: [mcp({ largest: { $atMost: TOKENS_LARGEST }, total: { $atMost: TOKENS_TOTAL } })],
			id: "reference-app",
		},
	]),
]
