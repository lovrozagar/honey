import { describe, expect, it, vi } from "vitest"
import { createClient } from "../../../src/client/index.ts"

function captureFetch(): { calls: Array<[string, RequestInit]>; fn: typeof fetch } {
	const calls: Array<[string, RequestInit]> = []
	const fn = vi.fn().mockImplementation((url: string, init: RequestInit) => {
		calls.push([url, init])
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)
	}) as unknown as typeof fetch
	return { calls, fn }
}

describe("file auto-detection in form input", () => {
	it("plain form values use URLSearchParams (no files)", async () => {
		const { calls, fn } = captureFetch()
		const api = createClient({ baseURL: "https://api.test.com", fetch: fn, throwOnError: true })

		await api.post("/login", { form: { password: "secret", username: "alice" } })

		const [, init] = calls[0]
		expect((init.headers as Headers).get("content-type")).toBe("application/x-www-form-urlencoded")
		expect(typeof init.body).toBe("string")
	})

	it("File value switches to FormData", async () => {
		const { calls, fn } = captureFetch()
		const api = createClient({ baseURL: "https://api.test.com", fetch: fn, throwOnError: true })

		const file = new File(["hello"], "test.txt", { type: "text/plain" })
		await api.post("/upload", { form: { avatar: file, name: "Alice" } })

		const [, init] = calls[0]
		/* Content-Type NOT set manually — browser sets multipart boundary */
		expect((init.headers as Headers).has("content-type")).toBe(false)
		expect(init.body).toBeInstanceOf(FormData)
		const fd = init.body as FormData
		expect(fd.get("name")).toBe("Alice")
		expect(fd.get("avatar")).toBeInstanceOf(File)
	})

	it("Blob value switches to FormData", async () => {
		const { calls, fn } = captureFetch()
		const api = createClient({ baseURL: "https://api.test.com", fetch: fn, throwOnError: true })

		const blob = new Blob(["data"], { type: "application/octet-stream" })
		await api.post("/upload", { form: { data: blob } })

		const [, init] = calls[0]
		expect((init.headers as Headers).has("content-type")).toBe(false)
		expect(init.body).toBeInstanceOf(FormData)
	})

	it("FileList flattened — each file appended under same key", async () => {
		const { calls, fn } = captureFetch()
		const api = createClient({ baseURL: "https://api.test.com", fetch: fn, throwOnError: true })

		/* simulate FileList-like object */
		const f1 = new File(["a"], "a.txt")
		const f2 = new File(["b"], "b.txt")
		const fileList = Object.assign([f1, f2], {
			item: (i: number) => [f1, f2][i],
			length: 2,
			[Symbol.iterator]: function* () {
				yield f1
				yield f2
			},
		})

		await api.post("/upload", { form: { documents: fileList } })

		const [, init] = calls[0]
		expect(init.body).toBeInstanceOf(FormData)
		const fd = init.body as FormData
		expect(fd.getAll("documents")).toHaveLength(2)
	})

	it("mixed: File + string values in same form", async () => {
		const { calls, fn } = captureFetch()
		const api = createClient({ baseURL: "https://api.test.com", fetch: fn, throwOnError: true })

		const file = new File(["content"], "doc.pdf", { type: "application/pdf" })
		await api.post("/upload", {
			form: { description: "My doc", file, title: "Report" },
		})

		const [, init] = calls[0]
		expect(init.body).toBeInstanceOf(FormData)
		const fd = init.body as FormData
		expect(fd.get("title")).toBe("Report")
		expect(fd.get("description")).toBe("My doc")
		expect(fd.get("file")).toBeInstanceOf(File)
	})

	it("works in tuple mode", async () => {
		const { calls, fn } = captureFetch()
		const api = createClient({ baseURL: "https://api.test.com", fetch: fn })

		const file = new File(["x"], "x.bin")
		const result = await api.post("/upload", { form: { file } })

		expect(result.data).toEqual({ ok: true })
		expect((calls[0][1].body as FormData).get("file")).toBeInstanceOf(File)
	})
})
