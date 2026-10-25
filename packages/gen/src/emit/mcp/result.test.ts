/**
 * A tool's result through the emitted server (bit 18 phase d, D1), its process against a recording server. A JSON
 * answer is text and structuredContent alike, an object as it is, any other value and an answer with declared headers
 * wrapped `{result, headers}`; text is text; bytes are image, audio or an embedded resource by their media type, and a
 * note past 1 MiB; text past 100,000 characters is cut with a note. A failure is isError: an answer outside 2xx its
 * status with honey's error key and message, else its message and body; no answer `transport` or `timeout`. A body
 * argument goes as base64-decoded bytes (at most 1 MiB, refused otherwise) or text. Both official clients validate the
 * structuredContent against the outputSchema.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { clientCheck, withClients } from "./__fixtures__/clients.ts"
import { exchange, initialize, request, written } from "./__fixtures__/written.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 120_000 }
const CLIENTS = withClients()
const STR = { type: "string" }
const MiB = 1 << 20

/** A GET answering `schema` as `type`, its declared `headers` with it. */
const get = (id: string, type: string, schema: unknown, headers?: Record<string, unknown>) => ({
	get: {
		operationId: id,
		responses: { 200: { content: { [type]: { schema } }, description: "ok", ...(headers ? { headers } : {}) } },
		"x-mcp": true,
	},
})

/** A POST sending a `type` body. */
const post = (id: string, type: string) => ({
	post: {
		operationId: id,
		requestBody: { content: { [type]: { schema: { format: "binary", type: "string" } } }, required: true },
		responses: { 204: { description: "done" } },
		"x-mcp": true,
	},
})

const BYTES = { format: "binary", type: "string" }

/** The media document: one operation per shape a result takes. */
const media = {
	info: { title: "Media", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/audio": get("audio.get", "audio/mpeg", BYTES),
		"/big": get("big.get", "application/octet-stream", BYTES),
		"/image": get("image.get", "image/png", BYTES),
		"/item": get("item.get", "application/json", { properties: { id: STR }, required: ["id"], type: "object" }),
		"/list": get("list.get", "application/json", { items: STR, type: "array" }),
		"/note": post("note.send", "text/plain"),
		"/paged": get("paged.get", "application/json", { properties: {}, type: "object" }, { "X-Total": { schema: STR } }),
		"/pdf": get("pdf.get", "application/pdf", BYTES),
		"/text": get("text.get", "text/plain", STR),
		"/upload": post("upload.send", "application/octet-stream"),
	},
}

/** The media server run against a recording server answering `replies`, with `env`: its results and the hops. */
async function run(
	calls: readonly [string, Record<string, unknown>?][],
	replies: readonly Reply[],
	env: string[] = [],
) {
	const dir = written(generateMcpServer(media).files)
	return served(replies, async (server) => {
		const lines = [
			initialize("2025-11-25"),
			...calls.map(([name, args], i) => request(i + 1, "tools/call", { arguments: args ?? {}, name })),
		]
		const command = ["env", `MEDIA_BASE_URL=${server.url}`, ...env, process.execPath, join(dir, "dist", "server.js")]
		const ran = await exchange(command, lines)
		const results = ran.replies.slice(1).map((reply) => (reply as { result: Record<string, unknown> }).result)
		return { bodies: server.bodies, hops: server.hops, results, server: server.url }
	})
}

/** A result's isError and its one text block read as JSON. */
const failed = (result: Record<string, unknown> | undefined): [unknown, Record<string, unknown>] => [
	result?.isError,
	(JSON.parse((result?.content as [{ text: string }] | undefined)?.[0].text ?? "{}") ?? {}) as Record<string, unknown>,
]

/** The `i & 0xff` pattern the recording server sends `n` bytes of, as base64. */
const pattern = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i & 0xff)).toString("base64")

describe("a tool's JSON and text result (phase d)", SLOW, () => {
	// v0: dcaad89a0c
	it("answers JSON as text and structuredContent alike, wrapping a non-object and declared headers; text as text, cut past 100,000 characters; a value its schema does not declare isError", async () => {
		const long = "x".repeat(100_005)
		const { results } = await run(
			[["item_get"], ["list_get"], ["paged_get"], ["text_get"], ["text_get"], ["item_get"]],
			[
				{ json: { id: "1" }, status: 200 },
				{ json: ["a", "b"], status: 200 },
				{ headers: { "x-total": "2" }, json: { page: 1 }, status: 200 },
				{ headers: { "content-type": "text/plain" }, status: 200, text: "plain words" },
				{ headers: { "content-type": "text/plain" }, status: 200, text: long },
				{ json: ["not", "an", "object"], status: 200 },
			],
		)
		const structured = [{ id: "1" }, { result: ["a", "b"] }, { result: { page: 1 }, headers: { "x-total": "2" } }]
		expect(results).toEqual([
			...structured.map((value) => ({
				content: [{ text: JSON.stringify(value), type: "text" }],
				structuredContent: value,
			})),
			{ content: [{ text: "plain words", type: "text" }] },
			{ content: [{ text: `${"x".repeat(100_000)}\n[cut: 100000 of 100005 characters]`, type: "text" }] },
			{
				content: [
					{
						text: JSON.stringify({ message: "The API answered something other than the object its schema declares" }),
						type: "text",
					},
				],
				isError: true,
			},
		])
	})
})

describe("a tool's bytes result (phase d)", SLOW, () => {
	// v0: 3ae872cf6f
	it("answers an image and audio as their content, other bytes as an embedded resource, bytes past 1 MiB as a note", async () => {
		const { results } = await run(
			[["image_get"], ["audio_get"], ["pdf_get"], ["big_get"]],
			[
				{ bytes: 300, headers: { "content-type": "image/png" }, status: 200 },
				{ bytes: 5, headers: { "content-type": "audio/mpeg" }, status: 200 },
				{ bytes: 7, headers: { "content-type": "application/pdf; x=1" }, status: 200 },
				{ bytes: MiB + 1, headers: { "content-type": "application/octet-stream" }, status: 200 },
			],
		)
		expect(results.map((result) => result.content)).toEqual([
			[{ data: pattern(300), mimeType: "image/png", type: "image" }],
			[{ data: pattern(5), mimeType: "audio/mpeg", type: "audio" }],
			[
				{
					resource: { blob: pattern(7), mimeType: "application/pdf", uri: "honey://pdf_get/result" },
					type: "resource",
				},
			],
			[{ text: `[application/octet-stream, ${MiB + 1} bytes: past the ${MiB}-byte cap]`, type: "text" }],
		])
	})
})

describe("a tool's failure (phase d)", SLOW, () => {
	// v0: f6f97842f6
	it("answers a status outside 2xx isError: honey's error key and message, else the message and body", async () => {
		const envelope = {
			error_key: "unauthorized",
			fields: {},
			message: "no key",
			status: 401,
			status_key: "x",
			success: false,
		}
		const { results } = await run(
			[["item_get"], ["item_get"]],
			[
				{ json: envelope, status: 401 },
				{ headers: { "content-type": "text/plain" }, status: 503, text: "down" },
			],
		)
		const [keyed, [plainError, plain]] = [failed(results[0]), failed(results[1])]
		expect([keyed, [plainError, plain.status, plain.body]]).toEqual([
			[true, { error_key: "unauthorized", message: "no key", status: 401 }],
			[true, 503, "down"],
		])
	})

	it("answers a call that got no answer isError: a transport failure, or a timeout past $<PREFIX>_TIMEOUT_MS", async () => {
		const [timedOut, refused] = await Promise.all([
			run([["item_get"]], [{ delayMs: 5_000, json: {}, status: 200 }], ["MEDIA_TIMEOUT_MS=200"]),
			(async () => {
				const dir = written(generateMcpServer(media).files)
				const ran = await exchange(
					["env", "MEDIA_BASE_URL=http://127.0.0.1:9", process.execPath, join(dir, "dist", "server.js")],
					[initialize("2025-11-25"), request(1, "tools/call", { arguments: {}, name: "item_get" })],
				)
				return (ran.replies[1] as { result: Record<string, unknown> }).result
			})(),
		])
		const kinds = [failed(timedOut.results[0]), failed(refused)].map(([isError, value]) => [isError, value.kind])
		expect(kinds).toEqual([
			[true, "timeout"],
			[true, "transport"],
		])
	})
})

describe("a tool's raw body (phase d, Q4)", SLOW, () => {
	it("sends base64 as its bytes under the body's content type, text as it is; refuses bytes not base64 or past 1 MiB, sending nothing", async () => {
		const over = Buffer.alloc(MiB + 1).toString("base64")
		const { bodies, hops, results } = await run(
			[
				["upload_send", { body: Buffer.from([0, 1, 254, 255]).toString("base64") }],
				["note_send", { body: "a note" }],
				["upload_send", { body: "not base64!" }],
				["upload_send", { body: over }],
			],
			[{ status: 204 }, { status: 204 }],
		)
		expect([
			hops.map((hop) => [hop.url, hop.body.contentType]),
			bodies.map((body) => [...body]),
			results.slice(2).map((result) => (result.content as [{ text: string }])[0].text),
		]).toEqual([
			[
				["/upload", "application/octet-stream"],
				["/note", "text/plain"],
			],
			[[0, 1, 254, 255], [...Buffer.from("a note")]],
			[
				JSON.stringify({ message: "Invalid arguments: body is not base64" }),
				JSON.stringify({ message: `Invalid arguments: body is past the ${MiB}-byte cap` }),
			],
		])
	})
})

describe.skipIf(!CLIENTS)("the official clients on a structured result (phase d)", SLOW, () => {
	it.each(["sdk", "v2"] as const)("lets %s validate a wrapped result against its outputSchema", async (client) => {
		const dir = written(generateMcpServer(media).files)
		const saw = await served([{ headers: { "x-total": "2" }, json: { page: 1 }, status: 200 }], (server) =>
			clientCheck(client, ["env", `MEDIA_BASE_URL=${server.url}`, process.execPath, join(dir, "dist", "server.js")], {
				arguments: {},
				name: "paged_get",
			}),
		)
		expect([saw.failed, (saw.called as { structuredContent?: unknown }).structuredContent]).toEqual([
			undefined,
			{ headers: { "x-total": "2" }, result: { page: 1 } },
		])
	})
})
