import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── Tier 7: SSE streaming ── */

describe("go-cli codegen — Tier 7: streaming", () => {
	const sseSpec = loadFixture("sse")

	it("[#42] SSE op emits RunE that calls StreamSSE helper on SDK iter-returning method", () => {
		const result = generateGoCLI(sseSpec, { binaryName: "acme" })
		const events = result.files["cmd/events.go"]
		expect(events).toBeDefined()
		expect(events as string).toContain("StreamSSE")
	})

	it("[#43] RunE emits a `for ev, err := range it` loop writing NDJSON lines", () => {
		const result = generateGoCLI(sseSpec, { binaryName: "acme" })
		const allSrc = Object.values(result.files).join("\n")
		expect(allSrc).toMatch(/for\s+\w+\s*,\s*\w+\s*:=\s*range\s+/)
	})

	it("[#44] --output=yaml on SSE → separates events with `---\\n`", () => {
		const result = generateGoCLI(sseSpec, { binaryName: "acme" })
		const stream = result.files["cli-go/stream.go"] ?? result.files["internal/cli/stream.go"]
		expect(stream).toBeDefined()
		expect(stream as string).toContain("---")
	})

	it("[#45] SSE error mid-stream → prints partial events then exits via mapped status code", () => {
		const result = generateGoCLI(sseSpec, { binaryName: "acme" })
		const stream = result.files["cli-go/stream.go"] ?? result.files["internal/cli/stream.go"]
		expect(stream).toBeDefined()
		const src = stream as string
		expect(src).toMatch(/if\s+err\s*!=\s*nil/)
		expect(src).toMatch(/return\s+err/)
	})

	it("[#46] --output=table on SSE → falls back to ndjson with stderr warning", () => {
		const result = generateGoCLI(sseSpec, { binaryName: "acme" })
		const stream = result.files["cli-go/stream.go"] ?? result.files["internal/cli/stream.go"]
		expect(stream).toBeDefined()
		const src = stream as string
		expect(src).toMatch(/table/i)
		expect(src).toContain("os.Stderr")
	})

	it("[#47] --last-event-id flag emitted when SSE op declares a last-event-id query/header param", () => {
		const result = generateGoCLI(sseSpec, { binaryName: "acme" })
		const events = result.files["cmd/events.go"]
		expect(events).toBeDefined()
		expect(events as string).toContain(`"last-event-id"`)
	})
})
