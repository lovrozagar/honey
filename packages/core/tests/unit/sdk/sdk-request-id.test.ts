import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type SDKModule = {
	MatrixSDK: new (config: Record<string, unknown>) => {
		users: {
			list: (input?: Record<string, unknown>) => Promise<unknown>
		}
		events: {
			stream: (input?: Record<string, unknown>) => AsyncIterable<{ data: string; event?: string }>
		}
	}
}

async function loadSDK(): Promise<SDKModule> {
	const spec = JSON.parse(
		readFileSync(new URL("../codegen/fixtures/python/runtime-matrix.json", import.meta.url), "utf8"),
	) as Record<string, unknown>
	const { files } = generateSDK(spec, { name: "MatrixSDK", stem: "sdk" })
	const clientBody = files.client.replace(/^import type \{[^\n]+\n/, "").replace(/^import \{[^\n]+\n/, "")
	const merged = `${files.map}\n${clientBody}`
	const { transform } = await import("esbuild")
	const { code: js } = await transform(merged, {
		format: "esm",
		loader: "ts",
		target: "esnext",
	})
	const dataUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
	return (await import(dataUrl)) as SDKModule
}

function jsonResponse(body: unknown = { email: "a@b.com", id: "u1", name: "A" }): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	})
}

function headerGet(headers: HeadersInit | undefined, name: string): string | null {
	if (!headers) return null
	if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name)
	if (Array.isArray(headers)) {
		const hit = headers.find(([k]) => k.toLowerCase() === name.toLowerCase())
		return hit?.[1] ?? null
	}
	const hit = Object.entries(headers as Record<string, string>).find(([k]) => k.toLowerCase() === name.toLowerCase())
	return hit?.[1] ?? null
}

function lastRequestId(fetchFn: ReturnType<typeof vi.fn>): string | null {
	const [, init] = fetchFn.mock.calls.at(-1) as [string, RequestInit]
	return headerGet(init.headers, "x-request-id")
}

let mod: SDKModule

beforeAll(async () => {
	mod = await loadSDK()
})

describe("generated SDK — auto x-request-id", () => {
	it("emitted client source ensures x-request-id before onRequest", () => {
		const spec = JSON.parse(
			readFileSync(new URL("../codegen/fixtures/python/runtime-matrix.json", import.meta.url), "utf8"),
		) as Record<string, unknown>
		const { files } = generateSDK(spec, { name: "MatrixSDK", stem: "sdk" })
		expect(files.client).toContain("x-request-id")
		expect(files.client).toMatch(/newClientRequestId|#newRequestId|randomUUID|getRandomValues/)
		/* setdefault semantics — only when absent */
		expect(files.client).toMatch(/headers\.has\(\s*["']x-request-id["']\s*\)/)
	})

	it("attaches x-request-id on REST calls", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse([{ email: "a@b.com", id: "u1", name: "A" }]))
		const sdk = new mod.MatrixSDK({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		await sdk.users.list()

		expect(lastRequestId(fetchFn)).toMatch(UUID_V4)
	})

	it("preserves per-call x-request-id", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse([{ email: "a@b.com", id: "u1", name: "A" }]))
		const sdk = new mod.MatrixSDK({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		await sdk.users.list({ headers: { "x-request-id": "call-id" } })

		expect(lastRequestId(fetchFn)).toBe("call-id")
	})

	it("onRequest hook wins over auto id", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse([{ email: "a@b.com", id: "u1", name: "A" }]))
		const seen: string[] = []
		const sdk = new mod.MatrixSDK({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				(ctx: { headers: Headers }) => {
					seen.push(ctx.headers.get("x-request-id") ?? "")
					ctx.headers.set("x-request-id", "hook-id")
				},
			],
			throwOnError: true,
		})

		await sdk.users.list()

		expect(seen[0]).toMatch(UUID_V4)
		expect(lastRequestId(fetchFn)).toBe("hook-id")
	})

	it("SSE stream attaches x-request-id", async () => {
		const encoder = new TextEncoder()
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode("event: tick\ndata: {}\n\n"))
				controller.close()
			},
		})
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(stream, {
				headers: { "content-type": "text/event-stream" },
				status: 200,
			}),
		)
		const sdk = new mod.MatrixSDK({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		const events: unknown[] = []
		for await (const ev of sdk.events.stream()) {
			events.push(ev)
		}

		expect(events.length).toBeGreaterThan(0)
		expect(lastRequestId(fetchFn)).toMatch(UUID_V4)
	})
})
