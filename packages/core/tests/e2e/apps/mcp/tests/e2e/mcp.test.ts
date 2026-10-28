/**
 * MCP mounted in the app (bit 21 e), on each host: Anyrow's five multipart operations driven over Streamable HTTP by
 * the official clients (sdk 1.32.2 at 2025-11-25, client 2.4.0 pinned to 2026-07-28; gen's pinned install). Inline
 * files reach the routes intact (their SHA-256 read back), the streams are bounded collects, a request with no ApiKey
 * credential is refused before any dispatch, and a key the inner route rejects is the endpoint's HTTP 401.
 */
import { createHash } from "node:crypto"
import { expect, test } from "@playwright/test"
import { httpSession, type Step, withClients } from "../../../../../../../gen/src/emit/mcp/__fixtures__/clients.ts"
import { e2eBaseUrl } from "../../../../playwright-app.ts"
import { KEY } from "../../src/key.ts"

const MCP = `${e2eBaseUrl()}/api/mcp`
const CLIENTS = withClients()

/* a PDF's head and a byte of every value, so a text decoding anywhere would change the digest */
const INVOICE = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(Array.from({ length: 256 }, (_, i) => i))])
const CSV = Buffer.from("name,qty\nbolt,4\n")
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** `bytes` inline, as the file-uploads extension's FileInput. */
const inline = (bytes: Buffer, name: string, mimeType: string) => ({
	data: bytes.toString("base64"),
	digest: { algorithm: "sha-256", value: createHash("sha256").update(bytes).digest("base64url") },
	id: name,
	mimeType,
	name,
	size: bytes.length,
})

const call = (name: string, args: object): Step => ({ call: { arguments: args, name } })
const pdf = inline(INVOICE, "invoice.pdf", "application/pdf")

/** A raw POST of `method` to the endpoint, `authorization` its credential when given: its status and challenge. */
async function posted(method: string, params: object, authorization?: string) {
	const response = await fetch(MCP, {
		body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2025-11-25",
			...(authorization === undefined ? {} : { authorization }),
		},
		method: "POST",
	})
	await response.body?.cancel()
	return [response.status, response.headers.get("www-authenticate")]
}

test.describe("MCP mounted at /api/mcp", () => {
	test.skip(!CLIENTS, "the pinned MCP clients are not installed")

	test("refuses an unauthenticated tools/list before any dispatch, the official client too", async () => {
		const [refused] = await httpSession("sdk", { headers: {}, url: MCP }, [{ list: true }])
		expect([await posted("tools/list", {}), refused?.code]).toEqual([[401, "ApiKey"], 401])
	})

	for (const [client, era] of [
		["sdk", "2025-11-25"],
		["modern", "2026-07-28"],
	] as const)
		test(`${client} at ${era} calls the five tools, each file intact under the caller's ApiKey`, async () => {
			const steps: Step[] = [
				{ negotiated: true },
				{ list: true },
				call("extract_once", { file: pdf, instruction: "one row a line", project_id: "p1", strictness: "strict" }),
				call("extract_stream", { columns: "a,b", file: pdf, max_events: 2, project_id: "p1" }),
				call("suggest_schema", { file: inline(CSV, "rows.csv", "text/csv"), project_id: "p1", text: "a hint" }),
				call("extract_table_once", { file: pdf, project_id: "p1", table_id: "t1" }),
				call("extract_table_stream", { project_id: "p1", table_id: "t1", text: "text alone" }),
			]
			const [negotiated, listed, ...called] = await httpSession(
				client,
				{ headers: { authorization: `ApiKey ${KEY}` }, url: MCP },
				steps,
			)
			const read = (at: number) =>
				(called[at]?.result as { structuredContent?: Record<string, unknown> })?.structuredContent
			const pdfRead = [{ file_name: "invoice.pdf", sha256: sha(INVOICE), size: INVOICE.length }]
			expect([
				negotiated,
				listed?.tools?.map((tool) => tool.name),
				read(0),
				read(1)?.ended,
				read(2),
				read(3)?.files,
				[read(4)?.ended, (read(4)?.events as unknown[] | undefined)?.length],
			]).toEqual([
				{ negotiated: era },
				["extract_once", "extract_stream", "suggest_schema", "extract_table_once", "extract_table_stream"],
				{ files: pdfRead, status: "complete", texts: { instruction: "one row a line", strictness: "strict" } },
				"max_events",
				{
					files: [{ file_name: "rows.csv", sha256: sha(CSV), size: CSV.length }],
					status: "complete",
					texts: { text: "a hint" },
				},
				pdfRead,
				["end", 2],
			])
		})

	test("answers HTTP 401 with the inner challenge when the inner route rejects the key, never a tool result", async () => {
		const [listed, calledByClient] = await httpSession(
			"sdk",
			{ headers: { authorization: "ApiKey wrong" }, url: MCP },
			[{ list: true }, call("suggest_schema", { project_id: "p1", text: "t" })],
		)
		const args = { arguments: { project_id: "p1", text: "t" }, name: "suggest_schema" }
		expect([
			listed?.tools?.length,
			calledByClient?.result,
			calledByClient?.code,
			await posted("tools/call", args, "ApiKey wrong"),
		]).toEqual([5, undefined, 401, [401, 'ApiKey realm="honey-e2e"']])
	})
})

/* the file-uploads extension's identifier, built so only gen's runtime module spells it */
const FILES = ["io.modelcontextprotocol", "files"].join("/")

/** A 2026-07-28 tools/call of `name` declaring the extension, `extra` beside its arguments: its JSON-RPC result. */
async function modernCall(name: string, args: object, extra: object = {}) {
	const response = await fetch(MCP, {
		body: JSON.stringify({
			id: 1,
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				_meta: {
					"io.modelcontextprotocol/clientCapabilities": { extensions: { [FILES]: {} } },
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				},
				arguments: args,
				name,
				...extra,
			},
		}),
		headers: {
			accept: "application/json, text/event-stream",
			authorization: `ApiKey ${KEY}`,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": name,
			"mcp-protocol-version": "2026-07-28",
		},
		method: "POST",
	})
	return ((await response.json()) as { result: Record<string, unknown> }).result
}

test.describe("MCP uploads at /api/mcp (bit 21 g)", () => {
	test("asks for a file without data, takes its PUT once, and runs the call on its bytes", async () => {
		const { data: _, ...metadata } = pdf
		const args = { file: metadata, project_id: "p1", table_id: "t1" }
		const asked = await modernCall("extract_table_once", args)
		const [target] = (asked.inputRequests as { uploads: { params: { files: { fileId: string; url: string }[] } } })
			.uploads.params.files
		const put = () => fetch(target?.url as string, { body: INVOICE, method: "PUT" })
		const [first, again] = [await put(), await put()]
		const answered = await modernCall("extract_table_once", args, {
			inputResponses: { uploads: { files: [{ fileId: "invoice.pdf", status: "completed" }], resultType: "complete" } },
			requestState: asked.requestState,
		})
		expect([
			asked.resultType,
			target?.url.startsWith(`${MCP}/uploads/`),
			first.status,
			again.status,
			(answered.structuredContent as { files: unknown[] }).files,
		]).toEqual([
			"input_required",
			true,
			204,
			409,
			[{ file_name: "invoice.pdf", sha256: sha(INVOICE), size: INVOICE.length }],
		])
	})
})
