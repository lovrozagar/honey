/**
 * The TS SDK's response cap (bit 11 fix): a body is read in the chunks it arrives in and refused past
 * `maxResponseBytes` decoded bytes (100 MiB by default), its read cancelled. A body far past the cap is pulled only to
 * the cap; a gzip bomb is refused on its decoded bytes through a real fetch; an error body past the cap reads as null,
 * its status kept. The refusal names the cap, the content type and, when the response sent one, its Content-Length.
 */
import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { brotliCompressSync, constants, deflateSync, gzipSync, zstdCompressSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type Flood, flood } from "../shared/__fixtures__/flood-server.ts"
import { emittedApp, emittedSdk, emittedSdkEntry } from "./__fixtures__/emitted.ts"

type Front = "app" | "sdk"
type Outcome = { data?: unknown; error?: { body?: unknown; message?: string; status?: number } | null; status?: number }

const FRONTS: readonly Front[] = ["sdk", "app"]
const MiB = 1 << 20
const CHUNK = 64 * 1024

/** `GET /items`, the SDK method `items.list`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items": {
			get: {
				operationId: "items.list",
				responses: {
					"200": {
						content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } },
						description: "ok",
					},
				},
			},
		},
	},
}

/** One safe-mode `GET /items` through `front` with `config`. */
async function get(front: Front, config: Record<string, unknown>): Promise<Outcome> {
	if (front === "sdk") {
		const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
			TestSDK: new (config: object) => { items: { list: () => Promise<Outcome> } }
		}
		return new TestSDK(config).items.list()
	}
	const { createClient } = (await emittedApp()) as unknown as {
		createClient: (config: object) => { get: (path: string) => Promise<Outcome> }
	}
	return createClient(config).get("/items")
}

/**
 * A fetch answering `status` with `total` bytes in 64 KiB chunks under `headers`, counting the bytes pulled and
 * whether the body's source was cancelled.
 */
function pulling(total: number, headers: Record<string, string>, status = 200) {
	let pulled = 0
	let cancelled = false
	const fetch = (async () => {
		let left = total
		const body = new ReadableStream<Uint8Array>(
			{
				cancel() {
					cancelled = true
				},
				pull(controller) {
					if (left <= 0) return controller.close()
					const size = Math.min(CHUNK, left)
					left -= size
					pulled += size
					controller.enqueue(new Uint8Array(size))
				},
			},
			{ highWaterMark: 0 },
		)
		return new Response(body, { headers, status })
	}) as unknown as typeof globalThis.fetch
	return { cancelled: () => cancelled, fetch, pulled: () => pulled }
}

/** A body as its size, null as it is: a body read past the cap fails a leg on a number, never a megabytes-long diff. */
const sized = (body: unknown) => (body == null ? body : ((body as { length?: number }).length ?? "a value"))

/** What a refused read's outcome holds: its status and data, the error's status, body and message. */
const refused = (outcome: Outcome) => [
	outcome.status,
	sized(outcome.data ?? null),
	outcome.error?.status,
	sized(outcome.error?.body),
	outcome.error?.message,
]

/* each content coding a fetch may ask for, as a bomb: 64 MiB of zeros coded whole, far under 1 MiB on the wire */
const CODERS = {
	br: (input: Buffer) => brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
	deflate: deflateSync,
	gzip: gzipSync,
	zstd: zstdCompressSync,
} as const
const coded = (coding: keyof typeof CODERS) => CODERS[coding](Buffer.alloc(64 * MiB))

let served: Flood | undefined
afterEach(async () => {
	await served?.close()
	served = undefined
})

describe.each(FRONTS)("the response cap, through the %s", (front) => {
	it("refuses a body 64 times past the cap, pulled only to the cap and cancelled, the message naming the type", async () => {
		const answer = pulling(64 * MiB, { "content-type": "application/octet-stream" })
		const outcome = await get(front, { baseURL: "https://api.test", fetch: answer.fetch, maxResponseBytes: MiB })
		const message = `Response body is over the ${MiB}-byte cap (application/octet-stream)`
		expect([refused(outcome), answer.pulled() <= MiB + 2 * CHUNK]).toEqual([[200, null, 200, null, message], true])
		await vi.waitFor(() => expect(answer.cancelled()).toBe(true), { timeout: 5_000 })
	})

	it("names the Content-Length the response sent", async () => {
		const length = String(5 * MiB)
		const answer = pulling(5 * MiB, { "content-length": length, "content-type": "image/png" })
		const outcome = await get(front, { baseURL: "https://api.test", fetch: answer.fetch, maxResponseBytes: MiB })
		const message = `Response body is over the ${MiB}-byte cap (image/png, ${length} bytes)`
		expect(refused(outcome)).toEqual([200, null, 200, null, message])
	})

	it.each(["gzip", "deflate"] as const)(
		"refuses a %s bomb on its decoded bytes through Node's fetch, which asks for exactly gzip and deflate",
		async (coding) => {
			const bomb = coded(coding)
			served = await flood(bomb, {
				"content-encoding": coding,
				"content-length": String(bomb.byteLength),
				"content-type": "application/octet-stream",
			})
			const outcome = await get(front, { baseURL: served.url, maxResponseBytes: MiB })
			const message = `Response body is over the ${MiB}-byte cap (application/octet-stream, ${bomb.byteLength} bytes)`
			expect([bomb.byteLength < MiB, served.encodings(), refused(outcome)]).toEqual([
				true,
				["gzip, deflate"],
				[200, null, 200, null, message],
			])
		},
	)

	it("reads an error body past the cap as null, its status kept, pulled only to the cap and cancelled", async () => {
		const answer = pulling(64 * MiB, { "content-type": "text/plain" }, 500)
		const outcome = await get(front, { baseURL: "https://api.test", fetch: answer.fetch, maxResponseBytes: MiB })
		expect([
			outcome.status,
			outcome.error?.status,
			sized(outcome.error?.body),
			answer.pulled() <= MiB + 2 * CHUNK,
		]).toEqual([500, 500, null, true])
		await vi.waitFor(() => expect(answer.cancelled()).toBe(true), { timeout: 5_000 })
	})

	it("holds 100 MiB by default", async () => {
		const answer = pulling(101 * MiB, { "content-type": "application/octet-stream" })
		const outcome = await get(front, { baseURL: "https://api.test", fetch: answer.fetch })
		const message = `Response body is over the ${100 * MiB}-byte cap (application/octet-stream)`
		expect([refused(outcome), answer.pulled() <= 100 * MiB + 2 * CHUNK]).toEqual([
			[200, null, 200, null, message],
			true,
		])
	})
})

/** A Bun program calling `items.list` on the SDK at `entry` under a 1 MiB cap, printing its safe-mode outcome. */
const BUN_CALL = (entry: string, url: string) => `const { TestSDK } = await import(${JSON.stringify(entry)})
const outcome = await new TestSDK({ baseURL: ${JSON.stringify(url)}, maxResponseBytes: ${MiB} }).items.list()
console.log(JSON.stringify({ message: outcome.error?.message ?? null, status: outcome.status }))
`

describe("the response cap under Bun, whose fetch asks for gzip, deflate, br and zstd (bit 19 b1)", () => {
	it.each(["gzip", "deflate", "br", "zstd"] as const)("refuses a %s bomb on its decoded bytes", async (coding) => {
		const bomb = coded(coding)
		served = await flood(bomb, {
			"content-encoding": coding,
			"content-length": String(bomb.byteLength),
			"content-type": "application/octet-stream",
		})
		const entry = emittedSdkEntry(DOC)
		const program = join(dirname(entry), `bun-call-${coding}.ts`)
		writeFileSync(program, BUN_CALL(entry, served.url))
		/* async: the flood server answering it runs on this process's event loop */
		const ran = await new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve) => {
			execFile("bun", [program], { encoding: "utf8", timeout: 120_000 }, (error, stdout, stderr) =>
				resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stderr, stdout }),
			)
		})
		const message = `Response body is over the ${MiB}-byte cap (application/octet-stream, ${bomb.byteLength} bytes)`
		expect([ran.status, served.encodings(), JSON.parse(ran.stdout || "null")], ran.stderr).toEqual([
			0,
			["gzip, deflate, br, zstd"],
			{ message, status: 200 },
		])
	})
})
