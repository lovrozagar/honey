/**
 * The upload corpus (bit 21 g, H24.5): the mounted endpoint's out-of-band uploads, driven by the minimal extension
 * client (mcp-files/client.ts) through the real pipeline: the app's document, gen's generated handler, `mcp()` with
 * `uploads()` over the in-memory reference store, every request through `app.fetch` in process. Each leg holds one
 * rule of the token (scoped to the principal, the tool, the arguments and the file; expiring; signed by this app's
 * secret alone), the PUT (size counted as it streams, the digest checked, one claim winning), or the retry (the bytes
 * taken once, under the same credential and call).
 */
import { createHash, createHmac } from "node:crypto"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { written } from "../../../../gen/src/emit/mcp/__fixtures__/written.ts"
import { generateMcpHandler } from "../../../../gen/src/emit/mcp/mounted.ts"
import { bodyLimit } from "../../../src/input/body-limit.ts"
import { type McpHandler, mcp } from "../../../src/mcp/mount.ts"
import { memoryUploadStore, type UploadStore, uploads } from "../../../src/mcp/uploads.ts"
import { generateOpenApi } from "../../../src/openapi/generate.ts"
import { honey } from "../../../src/routing/app.ts"
import {
	type Altered,
	callWithUploads,
	type Fetcher,
	fileInput,
	metaOf,
	replied,
	toolCall,
} from "../mcp-files/client.ts"

const SECRET = "an-app-secret-of-at-least-32-characters"
const ENDPOINT = "https://shop.example/mcp"
const A = { authorization: "ApiKey ak_alice" }
const B = { authorization: "ApiKey ak_bob" }
const KEYS = new Set([A.authorization, B.authorization])
const SCHEMES = {
	apiKey: { description: "Format: ApiKey {key}", in: "header", name: "Authorization", type: "apiKey" },
}
const BYTES = new TextEncoder().encode("%PDF-1.7 the quarterly report")
const form = z.object({ file: z.file(), note: z.string().optional() })

/** What a route read: the operation, the file's name, size and SHA-256 (hex), the note. */
type Saw = { op: string; name: string; size: number; sha256: string; note?: string }

/** An app with two file tools (`docs_save`, `archive_save`) requiring an ApiKey, each read recorded. */
function shop(seen: Saw[], limit?: number) {
	const app =
		limit === undefined
			? honey()
			: (honey().use(
					bodyLimit({ limits: { "application/json": 1 << 20, "multipart/": 1 << 20 }, maxSize: limit }),
				) as unknown as ReturnType<typeof honey>)
	for (const op of ["docs.save", "archive.save"])
		app
			.post(`/v1/${op.split(".")[0]}`)
			.meta({ mcp: true, operationId: op, security: [{ apiKey: [] }] })
			.input({ form })
			.output({ "application/json": { ok: z.object({ saved: z.number() }) } })
			.handler(async (ctx) => {
				if (!KEYS.has(ctx.req.headers.get("authorization") ?? ""))
					return ctx.res.raw(new Response(null, { headers: { "www-authenticate": "ApiKey" }, status: 401 }))
				const { file, note } = ctx.input.form
				const sha256 = createHash("sha256")
					.update(new Uint8Array(await file.arrayBuffer()))
					.digest("hex")
				seen.push({ name: file.name, op, sha256, size: file.size, ...(note === undefined ? {} : { note }) })
				return ctx.res.json("ok", { saved: file.size })
			})
	return app
}

let handler: McpHandler

beforeAll(async () => {
	const document = generateOpenApi(shop([]), { info: { title: "Shop", version: "1.0.0" }, securitySchemes: SCHEMES })
	const { entry, files } = generateMcpHandler(document as unknown as Record<string, unknown>)
	const dir = written({
		"mcp.gen.ts": entry,
		...Object.fromEntries(Object.entries(files).map(([name, text]) => [`mcp/${name}`, text])),
	})
	handler = ((await import(join(dir, "mcp.gen.ts"))) as { mcpHandler: McpHandler }).mcpHandler
})

afterEach(() => void vi.useRealTimers())

type World = { fetcher: Fetcher; seen: Saw[]; store: UploadStore }

/** The shop mounted at /mcp with uploads under `secret` into `store`, `limit` its bodyLimit when given. */
function world(options: { secret?: string; store?: UploadStore; limit?: number; ttlMs?: number } = {}): World {
	const seen: Saw[] = []
	const app = shop(seen, options.limit)
	const store = options.store ?? memoryUploadStore()
	mcp(app, "/mcp", handler, {
		authenticate: (request) => /^ApiKey \S+$/.test(request.headers.get("authorization") ?? ""),
		uploads: uploads({ secret: options.secret ?? SECRET, store, ...(options.ttlMs && { ttlMs: options.ttlMs }) }),
	})
	return { fetcher: async (request) => app.fetch(request, {}), seen, store }
}

/** `docs_save` with one uploaded file, as `world` serves it, `altered` as a leg plays the client. */
async function saved(on: World, altered: Altered = {}, args: Record<string, unknown> = { note: "q3" }) {
	const file = await fileInput("file-1", BYTES, "application/pdf")
	return callWithUploads(
		on.fetcher,
		{ args: { ...args, file }, bytes: { "file-1": BYTES }, endpoint: ENDPOINT, headers: A, name: "docs_save" },
		altered,
	)
}

/** The hex SHA-256 the route reports for `bytes`. */
const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** A PUT of `body` to `url` through `on`. */
const put = (on: World, url: string, body: BodyInit | null) =>
	on.fetcher(new Request(url, { body, duplex: "half", method: "PUT" } as RequestInit))

/** A tool's result text, or the JSON-RPC error's code and message. */
const outcome = (reply: { result?: Record<string, unknown>; error?: { code: number; message: string } } | undefined) =>
	reply?.error
		? [reply.error.code, reply.error.message]
		: [reply?.result?.isError === true, (reply?.result?.content as { text: string }[] | undefined)?.[0]?.text]

describe("an upload's round trip (the draft's flow, :143-290)", () => {
	it("asks for each data-less file with one omit target under the endpoint, then runs the call on its bytes", async () => {
		const on = world()
		const run = await saved(on)
		const [target] = run.targets
		expect([run.asked.status, run.asked.result?.resultType, Object.keys(run.asked.result ?? {}).sort()]).toEqual([
			200,
			"input_required",
			["inputRequests", "requestState", "resultType"],
		])
		expect([
			target?.fileId,
			target?.credentials,
			target?.headers,
			target?.url.startsWith(`${ENDPOINT}/uploads/`),
		]).toEqual(["file-1", "omit", undefined, true])
		expect([run.puts, outcome(run.answered), on.seen]).toEqual([
			[204],
			[false, JSON.stringify({ saved: BYTES.length })],
			[{ name: "file-1.bin", note: "q3", op: "docs.save", sha256: hex(BYTES), size: BYTES.length }],
		])
	})

	it("advertises the extension with its inline cap in server/discover", async () => {
		const on = world()
		const discover = new Request(ENDPOINT, {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "server/discover", params: { _meta: metaOf() } }),
			headers: {
				accept: "application/json, text/event-stream",
				authorization: A.authorization,
				"content-type": "application/json",
				"mcp-method": "server/discover",
				"mcp-protocol-version": "2026-07-28",
			},
			method: "POST",
		})
		const answer = await replied(await on.fetcher(discover))
		expect(((answer.result?.capabilities ?? {}) as Record<string, unknown>).extensions).toEqual({
			[["io.modelcontextprotocol", "files"].join("/")]: { maxInlineBytes: 1_048_576 },
		})
	})

	it("binds the principal as HMAC(secret, the credential headers), never the credential's bare SHA-256", async () => {
		const run = await saved(world())
		const principal = String(run.asked.result?.requestState).split(".")[4]
		const credential = `authorization: ${A.authorization}`
		const keyed = createHmac("sha256", SECRET).update(`principal\n${credential}`).digest("base64url")
		const bare = createHash("sha256").update(credential).digest("base64url")
		const bareValue = createHash("sha256").update(A.authorization).digest("base64url")
		expect([principal === keyed, principal === bare, principal === bareValue]).toEqual([true, false, false])
	})
})

describe("the token (the draft's requestState MUSTs, :262-264, :344-350)", () => {
	it("refuses a replay: a second PUT is 409, a second retry finds nothing, the tool ran once", async () => {
		const on = world()
		const run = await saved(on)
		const again = await put(on, run.targets[0]?.url as string, BYTES)
		const replayed = await replied(
			await on.fetcher(
				toolCall(
					ENDPOINT,
					"docs_save",
					{
						_meta: metaOf(),
						arguments: { file: await fileInput("file-1", BYTES, "application/pdf"), note: "q3" },
						inputResponses: { uploads: { files: [{ fileId: "file-1", status: "completed" }], resultType: "complete" } },
						requestState: run.asked.result?.requestState,
					},
					A,
				),
			),
		)
		expect([again.status, await again.text(), outcome(replayed), on.seen.length]).toEqual([
			409,
			"the upload token is used",
			[true, JSON.stringify({ message: "Invalid arguments: file was not uploaded, or its upload was taken" })],
			1,
		])
	})

	it("refuses an expired token on the PUT (403) and on the retry (-32602)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		const on = world({ ttlMs: 60_000 })
		const late = await saved(on, {
			put: (_, bytes) => {
				vi.setSystemTime(Date.now() + 60_001)
				return bytes as Uint8Array<ArrayBuffer>
			},
		})
		const on2 = world({ ttlMs: 60_000 })
		const stale = await saved(on2, {
			retry: (params) => {
				vi.setSystemTime(Date.now() + 60_001)
				return params
			},
		})
		expect([late.puts, outcome(stale.answered), on.seen, on2.seen]).toEqual([
			[403],
			[-32602, "Invalid params: requestState's upload token has expired"],
			[],
			[],
		])
	})
})

describe("the token, continued (3)", () => {
	it("refuses the state for another tool, other arguments, another credential (rotation), or a forged principal", async () => {
		const swap = async (altered: Altered) => {
			const on = world()
			const run = await saved(on, altered)
			return [run.puts, outcome(run.answered), on.seen.length]
		}
		const asked = await replied(
			await world().fetcher(
				toolCall(ENDPOINT, "docs_save", { _meta: metaOf(), arguments: { file: await fileInput("x", BYTES) } }, B),
			),
		)
		const bobs = String(asked.result?.requestState).split(".")[4]
		expect(
			await Promise.all([
				swap({ retry: (params) => ({ ...params, name: "archive_save" }) }),
				swap({ retry: (params) => ({ ...params, arguments: { ...(params.arguments as object), note: "q4" } }) }),
				swap({ retryHeaders: B }),
				swap({
					retry: (params) => {
						const fields = String(params.requestState).split(".")
						fields[4] = bobs as string
						return { ...params, requestState: fields.join(".") }
					},
					retryHeaders: B,
				}),
			]),
		).toEqual([
			[[204], [-32602, "Invalid params: requestState's upload is another call's"], 0],
			[[204], [-32602, "Invalid params: requestState's upload is another call's"], 0],
			[[204], [-32602, "Invalid params: requestState's upload was made under another credential"], 0],
			[[204], [-32602, "Invalid params: requestState holds no upload token of this app's"], 0],
		])
	})
})

describe("the token, continued (2)", () => {
	it("refuses a token another secret signed, on the PUT and in the state", async () => {
		const foreign = world({ secret: "another-app-secret-of-32-characters!!" })
		const minted = await callWithUploads(
			foreign.fetcher,
			{
				args: {
					file: await fileInput("file-1", BYTES, "application/pdf"),
					note: "q3",
				},
				bytes: {},
				endpoint: ENDPOINT,
				headers: A,
				name: "docs_save",
			},
			{ retry: (params) => params },
		)
		const on = world()
		const forged = await put(on, minted.targets[0]?.url as string, BYTES)
		const stated = await saved(on, {
			retry: (params) => ({ ...params, requestState: minted.asked.result?.requestState }),
		})
		expect([forged.status, await forged.text(), outcome(stated.answered), on.seen]).toEqual([
			403,
			"the upload token is not this app's",
			[-32602, "Invalid params: requestState holds no upload token of this app's"],
			[],
		])
	})

	it("refuses a PUT no call asked for: a made-up token, a malformed one, a field changed", async () => {
		const on = world()
		const run = await saved(on, { retry: (params) => params })
		const fields = String(run.targets[0]?.url).split("/").pop()?.split(".") as string[]
		const bigger = [...fields.slice(0, 2), String(BYTES.length + 1), ...fields.slice(3)].join(".")
		const tried = await Promise.all(
			["a.b.c.d.e.f.g", "nothing", bigger].map(async (token) => {
				const answer = await put(on, `${ENDPOINT}/uploads/${token}`, BYTES)
				return [answer.status, await answer.text()]
			}),
		)
		expect(tried).toEqual([
			[403, "the upload token is not this app's"],
			[403, "the upload token is not this app's"],
			[403, "the upload token is not this app's"],
		])
	})
})

describe("the PUT (the draft's targets enforce the declared size and digest, :244-246)", () => {
	it("refuses a body past its size as it streams (413, the stream cut), short (400), or another digest (400)", async () => {
		let pulled = 0
		const endless = () =>
			new ReadableStream<Uint8Array>({
				pull: (stream) => {
					pulled += 1
					stream.enqueue(new Uint8Array(1024))
					if (pulled === 1000) stream.close()
				},
			})
		const runs = []
		for (const body of [
			() => endless(),
			(bytes: Uint8Array) => bytes.slice(0, -1),
			(bytes: Uint8Array) => bytes.map((byte, at) => (at === 0 ? byte ^ 1 : byte)),
		]) {
			const on = world()
			const run = await saved(on, { put: (_, bytes) => body(bytes) as BodyInit })
			runs.push([run.puts, outcome(run.answered), on.seen.length])
		}
		expect(runs).toEqual([
			[[413], [true, JSON.stringify({ message: "Invalid arguments: file failed to upload" })], 0],
			[[400], [true, JSON.stringify({ message: "Invalid arguments: file failed to upload" })], 0],
			[[400], [true, JSON.stringify({ message: "Invalid arguments: file failed to upload" })], 0],
		])
		expect(pulled).toBeLessThan(10)
	})

	it("keeps nothing of a refused PUT: a truncated one then the whole file lands, and the call runs once", async () => {
		const on = world()
		const statuses: number[] = []
		const run = await saved(on, {
			put: (target, bytes) => {
				const half = bytes.slice(0, 5)
				return new ReadableStream({
					start: async (stream) => {
						const truncated = await put(on, target.url, half)
						statuses.push(truncated.status)
						stream.enqueue(bytes)
						stream.close()
					},
				}) as BodyInit
			},
		})
		expect([statuses, run.puts, outcome(run.answered)[0], on.seen.length]).toEqual([[400], [204], false, 1])
	})
})

describe("the PUT, continued (2)", () => {
	it("lets one of eight racing PUTs claim the token, the rest 409", async () => {
		const on = world()
		let statuses: number[] = []
		const run = await saved(on, {
			put: (target, bytes) => {
				return new ReadableStream({
					start: async (stream) => {
						const racing = await Promise.all(Array.from({ length: 8 }, () => put(on, target.url, bytes.slice())))
						statuses = racing.map((each) => each.status).sort()
						stream.enqueue(bytes)
						stream.close()
					},
				}) as BodyInit
			},
		})
		expect([statuses, run.puts, on.seen.length]).toEqual([[204, 409, 409, 409, 409, 409, 409, 409], [409], 0])
	})

	it("claims once in the reference store, two claims racing in one tick", async () => {
		const store = memoryUploadStore()
		const expires = Date.now() + 1000
		const claims = await Promise.all([
			store.claim("u1", expires),
			store.claim("u1", expires),
			store.claim("u2", expires),
		])
		expect(claims).toEqual([true, false, true])
	})

	it("runs the upload route under the app's bodyLimit: 413 before the token is read, nothing claimed", async () => {
		const on = world({ limit: 8 })
		const run = await saved(on)
		expect([run.puts, outcome(run.answered)[1], on.seen]).toEqual([
			[413],
			JSON.stringify({ message: "Invalid arguments: file failed to upload" }),
			[],
		])
	})
})

describe("the retry's outcomes (the draft's Retry, :292-330)", () => {
	it("runs nothing on a failed outcome, a missing one, or a request that never declared the extension", async () => {
		const on = world()
		const failed = await saved(on, {
			retry: (params) => ({
				...params,
				inputResponses: { uploads: { files: [{ fileId: "file-1", status: "failed" }], resultType: "complete" } },
			}),
		})
		const missing = await saved(on, {
			retry: (params) => ({ ...params, inputResponses: { uploads: { files: [], resultType: "complete" } } }),
		})
		const file = await fileInput("file-1", BYTES, "application/pdf")
		const undeclared = await replied(
			await on.fetcher(toolCall(ENDPOINT, "docs_save", { _meta: metaOf(false), arguments: { file } }, A)),
		)
		expect([outcome(failed.answered), outcome(missing.answered), outcome(undeclared), on.seen]).toEqual([
			[true, JSON.stringify({ message: "Invalid arguments: file failed to upload" })],
			[-32602, "Invalid params: requestState and inputResponses.uploads answer no upload this call asked for"],
			[
				true,
				JSON.stringify({
					message: `Invalid arguments: file has no data, and an upload needs a 2026-07-28 request declaring ${["io.modelcontextprotocol", "files"].join("/")}`,
				}),
			],
			[],
		])
	})
})

describe("the retry's outcomes, continued (3)", () => {
	it("keeps prototype keys data: a file id __proto__ uploads, an outcome naming __proto__ answers nothing asked", async () => {
		const on = world()
		const file = await fileInput("__proto__", BYTES)
		const bytes: Record<string, Uint8Array> = { ["__proto__"]: BYTES }
		const proto = await callWithUploads(on.fetcher, {
			args: { file },
			bytes,
			endpoint: ENDPOINT,
			headers: A,
			name: "docs_save",
		})
		const named = await saved(on, {
			retry: (params) => ({
				...params,
				inputResponses: JSON.parse(
					'{"uploads":{"resultType":"complete","files":[{"fileId":"__proto__","status":"completed"}]}}',
				),
			}),
		})
		expect([
			proto.puts,
			outcome(proto.answered)[0],
			outcome(named.answered),
			({} as Record<string, unknown>).fileId,
		]).toEqual([
			[204],
			false,
			[-32602, "Invalid params: requestState and inputResponses.uploads answer no upload this call asked for"],
			undefined,
		])
	})
})

describe("the retry's outcomes, continued (2)", () => {
	it("keeps the upload route out of the document and the tool set", async () => {
		const seen: Saw[] = []
		const app = shop(seen)
		mcp(app, "/mcp", handler, {
			authenticate: () => true,
			uploads: uploads({ secret: SECRET, store: memoryUploadStore() }),
		})
		const document = generateOpenApi(app, { info: { title: "Shop", version: "1.0.0" } }) as { paths: object }
		expect(Object.keys(document.paths).sort()).toEqual(["/v1/archive", "/v1/docs"])
	})
})
