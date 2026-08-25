import { readFileSync } from "node:fs"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

type SDKModule = {
	MatrixSDK: new (config: Record<string, unknown>) => {
		users: {
			create: (input?: Record<string, unknown>) => Promise<unknown>
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

function jsonResponse(body: unknown = { email: "a@b.com", id: "u1" }): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	})
}

function restoreLocation(desc: PropertyDescriptor | undefined): void {
	if (desc) Object.defineProperty(globalThis, "location", desc)
	else Reflect.deleteProperty(globalThis, "location")
}

let mod: SDKModule
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location")

beforeAll(async () => {
	mod = await loadSDK()
})

afterEach(() => {
	restoreLocation(originalLocation)
})

describe("generated SDK — default fetch", () => {
	it("omitted fetch does not throw Illegal invocation when the environment fetch is a method", async () => {
		const previous = globalThis.fetch
		const urls: string[] = []
		function methodFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
			if (this !== globalThis) {
				throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
			}
			urls.push(String(input))
			return Promise.resolve(jsonResponse())
		}
		globalThis.fetch = methodFetch as typeof fetch
		try {
			const sdk = new mod.MatrixSDK({
				baseURL: "https://api.example.com",
				throwOnError: true,
			})
			const result = await sdk.users.create({ json: { email: "a@b.com" } })
			expect(result).toMatchObject({ email: "a@b.com", id: "u1" })
			expect(urls).toEqual(["https://api.example.com/users"])
		} finally {
			globalThis.fetch = previous
		}
	})

	it("honors a provided fetch as-is", async () => {
		const previous = globalThis.fetch
		let nativeCalls = 0
		globalThis.fetch = (async () => {
			nativeCalls++
			return jsonResponse()
		}) as typeof fetch
		const urls: string[] = []
		const custom = (async (input: RequestInfo | URL) => {
			urls.push(String(input))
			return jsonResponse({ email: "custom@b.com", id: "c1" })
		}) as typeof fetch
		try {
			const sdk = new mod.MatrixSDK({
				baseURL: "https://api.example.com",
				fetch: custom,
				throwOnError: true,
			})
			const result = await sdk.users.create({ json: { email: "a@b.com" } })
			expect(result).toMatchObject({ id: "c1" })
			expect(urls).toEqual(["https://api.example.com/users"])
			expect(nativeCalls).toBe(0)
		} finally {
			globalThis.fetch = previous
		}
	})

	it("assigns a missing environment fetch as-is when config.fetch is omitted", async () => {
		const previous = globalThis.fetch
		;(globalThis as { fetch?: typeof fetch }).fetch = undefined
		try {
			const sdk = new mod.MatrixSDK({
				baseURL: "https://api.example.com",
				throwOnError: true,
			})
			await expect(sdk.users.list({})).rejects.toThrow()
		} finally {
			globalThis.fetch = previous
		}
	})

	it("uses the bound default fetch for SSE when config.fetch is omitted", async () => {
		const previous = globalThis.fetch
		function methodFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
			if (this !== globalThis) {
				throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
			}
			expect(String(input)).toBe("https://api.example.com/events/stream")
			const encoder = new TextEncoder()
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("event: message\ndata: hi\n\n"))
					controller.close()
				},
			})
			return Promise.resolve(new Response(stream, { headers: { "content-type": "text/event-stream" }, status: 200 }))
		}
		globalThis.fetch = methodFetch as typeof fetch
		try {
			const sdk = new mod.MatrixSDK({
				baseURL: "https://api.example.com",
				throwOnError: true,
			})
			const events: Array<{ data: string; event?: string }> = []
			for await (const ev of sdk.events.stream({})) {
				events.push(ev)
			}
			expect(events).toEqual([{ data: "hi", event: "message" }])
		} finally {
			globalThis.fetch = previous
		}
	})
})

describe("generated SDK — relative baseURL", () => {
	it("joins a path-only baseURL with the operation path against location.origin", async () => {
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { origin: "https://app.example.com" },
		})
		const urls: string[] = []
		const custom = (async (input: RequestInfo | URL) => {
			urls.push(String(input))
			return jsonResponse()
		}) as typeof fetch
		const sdk = new mod.MatrixSDK({
			baseURL: "/api",
			fetch: custom,
			throwOnError: true,
		})
		await sdk.users.list({})
		expect(urls).toEqual(["https://app.example.com/api/users"])
	})

	it("keeps an absolute http(s) baseURL unchanged when location.origin is present", async () => {
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { origin: "https://app.example.com" },
		})
		const urls: string[] = []
		const custom = (async (input: RequestInfo | URL) => {
			urls.push(String(input))
			return jsonResponse()
		}) as typeof fetch
		const sdk = new mod.MatrixSDK({
			baseURL: "https://api.example.com",
			fetch: custom,
			throwOnError: true,
		})
		await sdk.users.list({})
		expect(urls).toEqual(["https://api.example.com/users"])
	})

	it("throws a clear error for a path-only baseURL without an origin", async () => {
		const sdk = new mod.MatrixSDK({
			baseURL: "/api",
			fetch: (async () => jsonResponse()) as typeof fetch,
			throwOnError: true,
		})
		await expect(sdk.users.list({})).rejects.toThrow(
			/Invalid baseURL "\/api": expected an absolute http\(s\): or ws\(s\): URL/,
		)
	})

	it("throws a clear error when a relative baseURL cannot be parsed against the origin", async () => {
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { origin: "https://app.example.com" },
		})
		const sdk = new mod.MatrixSDK({
			baseURL: "///",
			fetch: (async () => jsonResponse()) as typeof fetch,
			throwOnError: true,
		})
		await expect(sdk.users.list({})).rejects.toThrow(/Invalid baseURL "\/\/\/"/)
	})

	it("throws a clear error when location.origin is the opaque string null", async () => {
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { origin: "null" },
		})
		const sdk = new mod.MatrixSDK({
			baseURL: "/api",
			fetch: (async () => jsonResponse()) as typeof fetch,
			throwOnError: true,
		})
		await expect(sdk.users.list({})).rejects.toThrow(/expected an absolute http\(s\): or ws\(s\): URL/)
	})

	it("treats a throwing location getter as no origin", async () => {
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			get() {
				throw new Error("blocked")
			},
		})
		const sdk = new mod.MatrixSDK({
			baseURL: "/api",
			fetch: (async () => jsonResponse()) as typeof fetch,
			throwOnError: true,
		})
		await expect(sdk.users.list({})).rejects.toThrow(/expected an absolute http\(s\): or ws\(s\): URL/)
	})
})
