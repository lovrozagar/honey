import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"
import { generateGoSDK } from "../../../../src/codegen-go.ts"

const hasGo = (() => {
	try {
		execSync("go version", { stdio: "pipe" })
		return true
	} catch {
		return false
	}
})()

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

function writeTree(dir: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, content, "utf8")
	}
}

/* ── Tier 13: integration compile (requires `go` binary) ── */

describe("go-cli codegen — Tier 13: compile", () => {
	it.skipIf(!hasGo)(
		"[#81] generated CLI + co-located SDK compile via `go mod tidy && go build ./...`",
		() => {
			const spec = loadFixture("crud")
			const root = mkdtempSync(join(tmpdir(), "honey-go-cli-"))
			const cliDir = join(root, "cli")
			const sdkDir = join(root, "sdk")
			mkdirSync(cliDir, { recursive: true })
			mkdirSync(sdkDir, { recursive: true })

			const sdkResult = generateGoSDK(spec, { modulePath: "example.com/sdk" })
			writeTree(sdkDir, sdkResult.files)

			const cliResult = generateGoCLI(spec, {
				binaryName: "acme",
				modulePath: "example.com/cli",
				sdkModulePath: "example.com/sdk",
			})
			writeTree(cliDir, cliResult.files)

			execSync("go mod tidy", { cwd: sdkDir, stdio: "pipe" })
			execSync("go mod tidy", { cwd: cliDir, stdio: "pipe" })
			const buildOut = execSync("go build ./...", { cwd: cliDir, stdio: "pipe" })
			expect(buildOut.toString()).toBe("")
		},
		120_000,
	)

	it.skipIf(!hasGo)(
		"[#82] built binary prints --project-id and --output in `users list --help`",
		() => {
			const spec = loadFixture("crud")
			const root = mkdtempSync(join(tmpdir(), "honey-go-cli-help-"))
			const cliDir = join(root, "cli")
			const sdkDir = join(root, "sdk")
			mkdirSync(cliDir, { recursive: true })
			mkdirSync(sdkDir, { recursive: true })

			const sdkResult = generateGoSDK(spec, { modulePath: "example.com/sdk" })
			writeTree(sdkDir, sdkResult.files)

			const cliResult = generateGoCLI(spec, {
				binaryName: "acme",
				modulePath: "example.com/cli",
				sdkModulePath: "example.com/sdk",
			})
			writeTree(cliDir, cliResult.files)

			execSync("go mod tidy", { cwd: sdkDir, stdio: "pipe" })
			execSync("go mod tidy", { cwd: cliDir, stdio: "pipe" })
			execSync("go build -o cli .", { cwd: cliDir, stdio: "pipe" })

			const help = execSync("./cli users list --help", { cwd: cliDir, encoding: "utf8" })
			expect(help).toMatch(/--project-id|--id|--output/)
			expect(help).toContain("--output")
		},
		120_000,
	)
})
