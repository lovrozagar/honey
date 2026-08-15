import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const CORE = resolve(import.meta.dirname, "../../..")
const REPO = resolve(CORE, "../..")

function read(abs: string): string {
	return readFileSync(abs, "utf-8")
}

describe("framework README face", () => {
	it("published README is a start, not the SDK matrix", () => {
		const readme = read(resolve(CORE, "README.md"))
		expect(readme).toMatch(/honey init/)
		expect(readme).toMatch(/app\.serve/)
		expect(readme).toMatch(/\/docs/)
		expect(readme).toMatch(/\bcurl\b/)
		expect(readme).toMatch(/\/health/)
		expect(readme).toMatch(/docs\/sdk\.md/)
		expect(readme).not.toMatch(/Four-language parity pledge/)
		expect(readme).not.toMatch(/generateTypeScriptSDK/)
	})

	it("SDK matrix lives in docs/sdk.md", () => {
		const sdk = read(resolve(CORE, "docs/sdk.md"))
		expect(sdk).toMatch(/generateTypeScriptSDK/)
		expect(sdk).toMatch(/generatePythonSDK/)
		expect(sdk).toMatch(/generateGoSDK/)
		expect(sdk).toMatch(/generateRustSDK/)
		expect(sdk).toMatch(/Capability matrix/)
	})

	it("root README starts the same way and keeps a develop section", () => {
		const root = read(resolve(REPO, "README.md"))
		expect(root).toMatch(/honey init/)
		expect(root).toMatch(/app\.serve/)
		expect(root).toMatch(/\/docs/)
		expect(root).toMatch(/\bcurl\b/)
		expect(root).toMatch(/\/health/)
		expect(root).toMatch(/## Develop/)
	})
})
