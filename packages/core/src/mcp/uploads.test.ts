import { join } from "node:path"
import { beforeAll, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { written } from "../../../gen/src/emit/mcp/__fixtures__/written.ts"
import { generateMcpHandler } from "../../../gen/src/emit/mcp/mounted.ts"
import { callWithUploads, fileInput } from "../../tests/integration/mcp-files/client.ts"
import { generateOpenApi } from "../openapi/generate.ts"
import { honey } from "../routing/app.ts"
import { type McpHandler, mcp } from "./mount.ts"
import { memoryUploadStore, type UploadStore, uploads } from "./uploads.ts"

const SECRET = "an-app-secret-of-at-least-32-characters"
const BYTES = new TextEncoder().encode("rows,1\n")

/** An app with one file tool, `file_save`, needing no credential. */
const app = () =>
	honey()
		.post("/files")
		.meta({ mcp: true, operationId: "file.save" })
		.input({ form: z.object({ file: z.file() }) })
		.output({ "application/json": { ok: z.object({ size: z.number() }) } })
		.handler(async (ctx) => ctx.res.json("ok", { size: ctx.input.form.file.size }))

let handler: McpHandler

beforeAll(async () => {
	const { entry, files } = generateMcpHandler(
		generateOpenApi(app(), { info: { title: "Files", version: "1.0.0" } }) as unknown as Record<string, unknown>,
	)
	const dir = written({
		"mcp.gen.ts": entry,
		...Object.fromEntries(Object.entries(files).map(([name, text]) => [`mcp/${name}`, text])),
	})
	handler = ((await import(join(dir, "mcp.gen.ts"))) as { mcpHandler: McpHandler }).mcpHandler
})

describe("uploads(options) refusals", () => {
	it.each([
		[{ secret: "short" }, "uploads(): secret needs at least 32 characters, the app's own"],
		[{ ttlMs: 0 }, "uploads(): ttlMs is no whole number of milliseconds"],
		[{ ttlMs: 1.5 }, "uploads(): ttlMs is no whole number of milliseconds"],
		[{ maxBytes: -1 }, "uploads(): maxBytes is no whole number of bytes"],
		[
			{ origin: "https://shop.example/mcp" },
			"uploads(): origin https://shop.example/mcp is no origin: a scheme, a host and a port alone",
		],
		[{ origin: "shop" }, "uploads(): origin shop is no origin: a scheme, a host and a port alone"],
	])("refuses %j", (options, message) => {
		expect(() => uploads({ secret: SECRET, store: memoryUploadStore(), ...options })).toThrow(message)
	})

	it("refuses a mount whose upload route is taken", () => {
		const taken = app()
		taken.put("/mcp/uploads/:token").handler((ctx) => ctx.res.text("ok", "taken"))
		expect(() =>
			mcp(taken, "/mcp", handler, { uploads: uploads({ secret: SECRET, store: memoryUploadStore() }) }),
		).toThrow(/PUT/)
	})
})

describe("uploads(options) targets and caps", () => {
	it("puts targets under the public path (stripPrefix, basePath) at the configured origin, and caps a file's size", async () => {
		const at = honey().stripPrefix("/api").basePath("/v1")
		const served = mcp(
			at
				.post("/files")
				.meta({ mcp: true, operationId: "file.save" })
				.input({ form: z.object({ file: z.file() }) })
				.handler((ctx) => ctx.res.json("ok", { size: 1 })),
			"/mcp",
			handler,
			{
				uploads: uploads({ maxBytes: 4, origin: "https://public.example", secret: SECRET, store: memoryUploadStore() }),
			},
		)
		const fetcher = async (request: Request) => served.fetch(request, {})
		const small = await callWithUploads(
			fetcher,
			{
				args: { file: { ...(await fileInput("f", BYTES.slice(0, 4))), name: null } },
				bytes: {},
				endpoint: "https://internal/api/v1/mcp",
				headers: {},
				name: "file_save",
			},
			{ retry: (params) => params },
		)
		const big = await callWithUploads(fetcher, {
			args: { file: await fileInput("f", BYTES) },
			bytes: {},
			endpoint: "https://internal/api/v1/mcp",
			headers: {},
			name: "file_save",
		})
		expect([
			small.targets[0]?.url.startsWith("https://public.example/api/v1/mcp/uploads/"),
			big.asked.result?.content,
		]).toEqual([
			true,
			[
				{
					text: JSON.stringify({
						message: "Invalid arguments: file needs a whole size within the 4-byte upload cap and a SHA-256",
					}),
					type: "text",
				},
			],
		])
	})
})

describe("uploads(options) targets and caps, continued (2)", () => {
	it("refuses bytes a store hands back altered, and an empty token", async () => {
		const real = memoryUploadStore()
		const store: UploadStore = { ...real, take: async (id) => (await real.take(id))?.map((byte) => byte ^ 1) }
		const served = mcp(app(), "/mcp", handler, { uploads: uploads({ secret: SECRET, store }) })
		const fetcher = async (request: Request) => served.fetch(request, {})
		const run = await callWithUploads(fetcher, {
			args: { file: await fileInput("f", BYTES) },
			bytes: { f: BYTES },
			endpoint: "https://shop.example/mcp",
			headers: {},
			name: "file_save",
		})
		const empty = await fetcher(new Request("https://shop.example/mcp/uploads/", { body: BYTES, method: "PUT" }))
		expect([run.puts, run.answered?.result?.content, empty.status]).toEqual([
			[204],
			[
				{
					text: JSON.stringify({ message: "Invalid arguments: file does not match its upload's digest" }),
					type: "text",
				},
			],
			404,
		])
	})
})

describe("memoryUploadStore()", () => {
	it("forgets claims and uploads past their expiry, and gives an expired upload to no one", () => {
		vi.useFakeTimers({ now: 1_000, toFake: ["Date"] })
		try {
			const store = memoryUploadStore()
			store.claim("a", 1_500)
			store.put("a", BYTES, 1_500)
			store.put("b", BYTES, 1_500)
			store.put("c", BYTES, 5_000)
			vi.setSystemTime(2_000)
			const late = store.take("b")
			store.put("b", BYTES, 1_500)
			const reclaimed = store.claim("a", 3_000)
			expect([late, reclaimed, store.take("a"), store.take("b"), store.take("c")]).toEqual([
				undefined,
				true,
				undefined,
				undefined,
				BYTES,
			])
		} finally {
			vi.useRealTimers()
		}
	})
})

/** A body of the declared size, one byte more, then 1 KiB a pull, each only when its reader asks; what it saw. */
function overflowing(bytes: Uint8Array) {
	const seen = { cancelled: false, pulled: 0 }
	const body = new ReadableStream<Uint8Array>(
		{
			cancel: () => void (seen.cancelled = true),
			pull: (source) => {
				seen.pulled += 1
				if (seen.pulled === 1) source.enqueue(bytes.slice())
				else if (seen.pulled === 2) source.enqueue(new Uint8Array(1))
				else if (seen.pulled < 100) source.enqueue(new Uint8Array(1024))
				else source.close()
			},
		},
		{ highWaterMark: 0 },
	)
	return { body, seen }
}

describe("the upload route's size cap, as the body streams (bit 21 g)", () => {
	it.each([
		["no Content-Length", undefined],
		["a Content-Length claiming the declared size", String(BYTES.length)],
	])(
		"stops reading one byte past the declared size, with %s: 413, the source cancelled, not drained",
		async (_, length) => {
			const served = mcp(app(), "/mcp", handler, { uploads: uploads({ secret: SECRET, store: memoryUploadStore() }) })
			const fetcher = async (request: Request) => served.fetch(request, {})
			const call = {
				args: { file: await fileInput("f", BYTES) },
				bytes: {},
				endpoint: "https://shop.example/mcp",
				headers: {},
				name: "file_save",
			}
			const asked = await callWithUploads(fetcher, call, { retry: (params) => params })
			const { body, seen } = overflowing(BYTES)
			const request = new Request(
				asked.targets[0]?.url as string,
				{
					body,
					duplex: "half",
					headers: length === undefined ? {} : { "content-length": length },
					method: "PUT",
				} as RequestInit,
			)
			const answer = await fetcher(request)
			expect([answer.status, request.headers.get("content-length"), seen.cancelled, seen.pulled <= 3]).toEqual([
				413,
				length ?? null,
				true,
				true,
			])
		},
	)
})
