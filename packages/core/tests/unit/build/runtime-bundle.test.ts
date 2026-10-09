import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const DIR = resolve(import.meta.dirname, "../../../.tmp-runtime-bundle")

function run(cmd: string, args: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { cwd })
		let stderr = ""
		proc.stderr.on("data", (c: Buffer) => {
			stderr += c.toString()
		})
		proc.on("error", reject)
		proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }))
	})
}

describe("production runtime bundle", () => {
	it("bun build of honey() does not include effect or codegen", async () => {
		rmSync(DIR, { force: true, recursive: true })
		mkdirSync(DIR, { recursive: true })
		const entry = join(DIR, "app.ts")
		const out = join(DIR, "out.js")
		writeFileSync(
			entry,
			[
				'import { honey } from "../src/index.ts"',
				"const app = honey()",
				'  .get("/json")',
				'  .handler((ctx) => ctx.res.json("ok", { ok: true }))',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			].join("\n"),
			"utf-8",
		)
		try {
			const { exitCode, stderr } = await run(
				"bun",
				["build", entry, "--outfile", out, "--minify", "--target", "bun"],
				DIR,
			)
			expect(exitCode, stderr).toBe(0)
			const js = readFileSync(out, "utf-8")
			expect(js).not.toMatch(/\beffect\b/)
			expect(js).not.toContain("fast-check")
			expect(js).not.toContain("jiti")
			expect(js).not.toContain("ts-morph")
			expect(js).not.toContain("generateMCPServer")
			expect(js).not.toContain("generateRustSDK")
			expect(js).not.toContain("generatePythonSDK")
			expect(js).not.toContain("generateGoSDK")
			expect(js).not.toContain("createApiReference")
			expect(js).not.toContain("swagger-ui")
			expect(js).not.toContain("TranslationRegistry")
			expect(js).not.toContain("Deno.upgradeWebSocket")
			expect(js).not.toContain("WebSocketServer")
			expect(js).not.toMatch(/from"http"|from "http"|createServer/)
			/* a leak guard, not a budget: codegen or effect would add ~300 KB. Measured 92.3 KB:
			 * index.ts ~34 KB; validation, responses, tree and pattern ~22 KB; realtime server and
			 * bus ~7 KB, client address (ip, trust, peer) ~5.5 KB, proxy ~3.6 KB. Realtime and proxy
			 * stay in because `app.realtime()` and `.proxy()` are builder methods (not
			 * tree-shakeable), and a lazy feature load would need build-time injection. */
			expect(js.length).toBeLessThan(96_000)
		} finally {
			rmSync(DIR, { force: true, recursive: true })
		}
	}, 60_000)
})
