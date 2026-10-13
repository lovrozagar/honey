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

	it("Rust merged_headers setdefaults x-request-id; async and sync requests build headers before on_request", () => {
		const runtime = read("../../../src/client-rust/runtime.rs")
		const merge = runtime.slice(runtime.indexOf("pub(crate) fn merged_headers("))
		expect(merge).toMatch(/x-request-id/i)
		expect(merge).toMatch(/Uuid::new_v4|uuid::Uuid/)
		/* both pipelines merge headers (incl. the id) before firing hooks */
		const asyncBuild = runtime.slice(runtime.indexOf("async fn build_request("))
		expect(asyncBuild.indexOf("merged_headers(")).toBeLessThan(asyncBuild.indexOf("for hook in cfg.on_request"))
		const sync = read("../../../src/client-rust/runtime_sync.rs")
		const syncBody = sync.slice(sync.indexOf("fn execute_request_blocking("))
		expect(syncBody.indexOf("merged_headers(")).toBeGreaterThan(-1)
		expect(syncBody.indexOf("merged_headers(")).toBeLessThan(syncBody.indexOf("for hook in cfg.on_request"))
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
