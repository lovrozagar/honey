import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
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

async function bundle(name: string, lines: string[]): Promise<string> {
	const entry = join(DIR, `${name}.ts`)
	const out = join(DIR, `${name}.js`)
	writeFileSync(entry, lines.join("\n"), "utf-8")
	const { exitCode, stderr } = await run("bun", ["build", entry, "--outfile", out, "--minify", "--target", "bun"], DIR)
	expect(exitCode, stderr).toBe(0)
	return readFileSync(out, "utf-8")
}

/** A marker string per optional runtime feature: present only when the feature is bundled. */
const OPTIONAL_FEATURES: Record<string, string> = {
	"i18n (error translation, plural rules)": "PluralRules",
	"metaSpec merge (codegen only)": '"hidden"',
	"proxy()": "proxy-authenticate",
	"realtime()": "no realtime routes",
	"trustProxy() hops and ranges": "a hop count",
}

describe("production runtime bundle", () => {
	it("bun build of honey() leaves out tooling and every optional runtime feature", async () => {
		rmSync(DIR, { force: true, recursive: true })
		mkdirSync(DIR, { recursive: true })
		try {
			const js = await bundle("app", [
				'import { honey } from "../src/index.ts"',
				"const app = honey()",
				'  .get("/json")',
				'  .handler((ctx) => ctx.res.json("ok", { ok: true }))',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			])
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
			for (const [feature, marker] of Object.entries(OPTIONAL_FEATURES)) {
				expect(js.includes(marker), `${feature} leaked into a bundle that does not use it`).toBe(false)
			}
			/* a budget on what the wire carries: measured 25.1 KB gzipped (bun --minify); every
			 * optional feature above is out, what remains is the core router, context and responses */
			expect(gzipSync(js, { level: 9 }).length).toBeLessThan(26_000)
		} finally {
			rmSync(DIR, { force: true, recursive: true })
		}
	}, 60_000)

	it("a feature is bundled once its entry is imported", async () => {
		rmSync(DIR, { force: true, recursive: true })
		mkdirSync(DIR, { recursive: true })
		try {
			const js = await bundle("features", [
				'import { honey } from "../src/index.ts"',
				'import "../src/proxy.ts"',
				'import "../src/realtime/register.ts"',
				'import "../src/trust.ts"',
				"const app = honey().trustProxy(1)",
				'app.all("/up/*").proxy({ destination: (_c, url, init) => fetch(`http://upstream${url}`, init) })',
				'app.realtime("/rt", { handler: () => {} })',
				"export default { fetch: (req: Request) => app.fetch(req, {}) }",
				"",
			])
			expect(js).toContain(OPTIONAL_FEATURES["proxy()"])
			expect(js).toContain(OPTIONAL_FEATURES["realtime()"])
			expect(js).toContain(OPTIONAL_FEATURES["trustProxy() hops and ranges"])
		} finally {
			rmSync(DIR, { force: true, recursive: true })
		}
	}, 60_000)
})
