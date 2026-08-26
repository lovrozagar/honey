import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

function read(rel: string): string {
	return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
}

describe("SDK runtimes — auto x-request-id (source contracts)", () => {
	it("Go mergeHeaders setdefaults x-request-id via newUUIDv4 before return", () => {
		const src = read("../../../src/client-go/runtime.go")
		const start = src.indexOf("func mergeHeaders(")
		expect(start, "mergeHeaders missing").toBeGreaterThan(-1)
		/* take until next top-level func */
		const next = src.indexOf("\nfunc ", start + 1)
		const body = src.slice(start, next === -1 ? undefined : next)
		expect(body).toContain(`"X-Request-Id"`)
		expect(body).toContain("newUUIDv4()")
		expect(body).toMatch(/\.Get\(\s*"X-Request-Id"\s*\)/)
	})

	it("Go SSE transport setdefaults x-request-id when connecting", () => {
		const src = read("../../../src/client-go/transport.go")
		const start = src.indexOf("func (t *SseTransport) Connect(")
		expect(start, "SseTransport.Connect missing").toBeGreaterThan(-1)
		const next = src.indexOf("\nfunc ", start + 1)
		const body = src.slice(start, next === -1 ? undefined : next)
		expect(body).toContain(`"X-Request-Id"`)
		expect(body).toContain("newUUIDv4()")
	})

	it("Python _build_headers setdefaults x-request-id", () => {
		const src = read("../../../src/client-python/_runtime.py")
		const start = src.indexOf("def _build_headers(")
		expect(start, "_build_headers missing").toBeGreaterThan(-1)
		const next = src.indexOf("\ndef ", start + 1)
		const body = src.slice(start, next === -1 ? undefined : next)
		expect(body).toContain("x-request-id")
		expect(body).toMatch(/uuid\.uuid4|uuid4\(\)/)
	})

	it("Python SSE transport setdefaults x-request-id", () => {
		const src = read("../../../src/client-python/_transport.py")
		expect(src).toContain("x-request-id")
		expect(src).toMatch(/uuid\.uuid4|uuid4\(\)/)
	})

	it("Rust async execute_request setdefaults x-request-id before on_request", () => {
		const src = read("../../../src/client-rust/runtime.rs")
		const start = src.indexOf("async fn execute_request(")
		expect(start, "execute_request missing").toBeGreaterThan(-1)
		const body = src.slice(start, start + 3500)
		expect(body).toMatch(/x-request-id/i)
		expect(body).toMatch(/Uuid::new_v4|uuid::Uuid/)
		/* must run before firing hooks */
		const idPos = body.search(/x-request-id/i)
		const hookPos = body.indexOf("for hook in cfg.on_request")
		expect(hookPos).toBeGreaterThan(idPos)
	})

	it("Rust sync execute_request_blocking setdefaults x-request-id before on_request", () => {
		const src = read("../../../src/client-rust/runtime_sync.rs")
		const start = src.indexOf("fn execute_request_blocking(")
		expect(start, "execute_request_blocking missing").toBeGreaterThan(-1)
		const body = src.slice(start, start + 3500)
		expect(body).toMatch(/x-request-id/i)
		expect(body).toMatch(/Uuid::new_v4|uuid::Uuid/)
		const idPos = body.search(/x-request-id/i)
		const hookPos = body.indexOf("for hook in cfg.on_request")
		expect(hookPos).toBeGreaterThan(idPos)
	})

	it("TS generated client emits portable request-id helper (not bare crypto.randomUUID only)", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "t", version: "1" },
			paths: {
				"/ping": {
					get: {
						operationId: "ping",
						responses: { "200": { description: "ok" } },
					},
				},
			},
		}
		const { files } = generateSDK(spec, { name: "PingSDK", stem: "sdk" })
		expect(files.client).toContain("x-request-id")
		/* portable helper must consider getRandomValues fallback for older runtimes */
		expect(files.client).toMatch(/getRandomValues/)
		expect(files.client).toMatch(/globalThis\.crypto/)
	})
})
