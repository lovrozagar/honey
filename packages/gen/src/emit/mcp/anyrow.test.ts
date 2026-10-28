/**
 * Bit 21 c's acceptance: an Anyrow-shaped API's five multipart operations as tools, driven over stdio by each era's
 * official client (sdk 1.32.2 at 2025-11-25; client 2.4.0 pinned to 2026-07-28). Each call reaches the API as
 * multipart/form-data under `Authorization: ApiKey <key>`, the scheme's own prefix: every text part as given and the
 * file's bytes intact (their SHA-256 checked where the API reads them), read from the file root or sent inline. The
 * two streams are bounded collects: one cut at `max_events`, one read to its end, a heartbeat comment no event.
 */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type RecordingServer, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { anyrow } from "./__fixtures__/anyrow.ts"
import { clientSession, type Step, withClients } from "./__fixtures__/clients.ts"
import { scratchDir, written } from "./__fixtures__/written.ts"
import { FILE_SCHEMA } from "./files.ts"
import { generateMcpServer } from "./server.ts"

const CLIENTS = withClients()
const SLOW = { timeout: 120_000 }
const KEY = "ak_0123456789abcdef"

/* a PDF's head and a byte of every value, so a text decoding anywhere would change the digest */
const INVOICE = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(Array.from({ length: 256 }, (_, i) => i))])
const CSV = Buffer.from("name,qty\nbolt,4\n")

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** `bytes` inline, as the file-uploads extension's FileInput. */
const inline = (bytes: Buffer, name: string, mimeType: string) => ({
	data: bytes.toString("base64"),
	digest: { algorithm: "sha-256", value: createHash("sha256").update(bytes).digest("base64url") },
	id: name,
	mimeType,
	name,
	size: bytes.length,
})

/** An Anyrow event stream: a batch, a heartbeat, a file's progress, the completion. */
const STREAM: Reply = {
	sse: {
		end: "close",
		steps: [
			'event: batch\ndata: {"batch_id":"b1","table_id":"t1","total":1}\n\n',
			": heartbeat\n\n",
			'event: progress\ndata: {"file":"invoice.pdf","status":"complete","rows":2}\n\n',
			'event: complete\ndata: {"batch_id":"b1","status":"complete","total_rows":2}\n\n',
		],
	},
	status: 200,
}
const RESULT = {
	confidence: 0.9,
	credits: 1,
	duration_ms: 5,
	fail_count: 0,
	files: [{ file_name: "invoice.pdf", rows: 2, status: "complete" }],
	status: "complete",
	success_count: 1,
	table_id: "t1",
}
const SUGGESTED = { columns: [{ name: "name", type: "text" }], confidence: 0.8 }

/** A JSON answer of `body`. */
const json = (body: Reply["json"]): Reply => ({ json: body, status: 200 })

/** A call of `name` with `args`. */
const call = (name: string, args: object): Step => ({ call: { arguments: args, name } })

const STEPS: Step[] = [
	{ negotiated: true },
	{ list: true },
	call("extract_once", {
		file: { path: "invoice.pdf" },
		instruction: "one row a line",
		project_id: "p1",
		strictness: "strict",
	}),
	call("extract_stream", { columns: "a,b", file: { path: "invoice.pdf" }, max_events: 2, project_id: "p1" }),
	call("suggest_schema", { file: inline(CSV, "rows.csv", "text/csv"), project_id: "p1", text: "a hint" }),
	call("extract_table_once", {
		file: inline(INVOICE, "invoice.pdf", "application/pdf"),
		project_id: "p1",
		table_id: "t1",
	}),
	call("extract_table_stream", { project_id: "p1", table_id: "t1", text: "text alone" }),
]

/** What the API received, call by call: its request line, credential, media type and parts. */
const RECEIVED = (
	[
		[
			"POST /v1/projects/p1/extract",
			[
				["file", "invoice.pdf", sha(INVOICE)],
				["instruction", "one row a line"],
				["strictness", "strict"],
			],
		],
		[
			"POST /v1/projects/p1/extract-stream",
			[
				["columns", "a,b"],
				["file", "invoice.pdf", sha(INVOICE)],
			],
		],
		[
			"POST /v1/projects/p1/suggest-schema",
			[
				["file", "rows.csv", sha(CSV)],
				["text", "a hint"],
			],
		],
		["POST /v1/projects/p1/tables/t1/extract", [["file", "invoice.pdf", sha(INVOICE)]]],
		["POST /v1/projects/p1/tables/t1/extract-stream", [["text", "text alone"]]],
	] as const
).map(([line, parts]) => [line, `ApiKey ${KEY}`, "multipart/form-data", parts])

const TOOLS = ["extract_once", "extract_stream", "suggest_schema", "extract_table_once", "extract_table_stream"]

/** Each part of a multipart body: its name, and its text or its file's name and SHA-256. */
async function partsOf(body: Uint8Array, contentType: string | null) {
	const form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType ?? "" } }).formData()
	const parts: unknown[] = []
	for (const [name, value] of form.entries())
		parts.push(typeof value === "string" ? [name, value] : [name, value.name, sha(await value.bytes())])
	return parts
}

/** `client`'s session against the server in `dir` with its files in `root`: what it saw, and what the API received. */
async function session(client: "sdk" | "modern", [dir, root]: readonly [string, string], api: RecordingServer) {
	const env = [`ANYROW_BASE_URL=${api.url}`, `ANYROW_API_KEY=${KEY}`, `ANYROW_FILE_ROOT=${root}`]
	const [negotiated, listed, ...called] = await clientSession(
		client,
		["env", ...env, process.execPath, join(dir, "dist", "server.js")],
		STEPS,
	)
	const received = api.hops.map(async (hop, at) => [
		`${hop.method} ${hop.url}`,
		hop.headers.authorization,
		hop.body.contentType?.split(";")[0],
		await partsOf(api.bodies[at] as Uint8Array, hop.body.contentType),
	])
	const structured = called.map((step) => step.result?.structuredContent as { ended?: string } | undefined)
	return {
		got: structured.map((value, at) => value?.ended ?? value ?? called[at]),
		negotiated,
		received: await Promise.all(received),
		tools: (listed?.tools ?? []).map((tool) => [
			tool.name,
			(tool.inputSchema as { properties: Record<string, unknown> }).properties.file,
		]),
	}
}

describe.skipIf(!CLIENTS)("Anyrow's multipart operations through each era's official client (bit 21 c)", SLOW, () => {
	const root = scratchDir("anyrow-root")
	mkdirSync(root, { recursive: true })
	writeFileSync(join(root, "invoice.pdf"), INVOICE)
	const dir = written(generateMcpServer(anyrow(), { envPrefix: "ANYROW", name: "anyrow" }).files)

	it.each([
		["sdk", "2025-11-25"],
		["modern", "2026-07-28"],
	] as const)("%s, under %s, sends each file intact and each text part, as ApiKey <key>", async (client, era) => {
		const replies = [json(RESULT), STREAM, json(SUGGESTED), json(RESULT), STREAM]
		expect(await served(replies, (api) => session(client, [dir, root], api))).toEqual({
			got: [RESULT, "max_events", SUGGESTED, RESULT, "end"],
			negotiated: { negotiated: era },
			received: RECEIVED,
			tools: TOOLS.map((name) => [name, FILE_SCHEMA]),
		})
	})
})
