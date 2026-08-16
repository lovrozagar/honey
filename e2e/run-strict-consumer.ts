#!/usr/bin/env bun
/**
 * Packaging tier. Packs @lovrozagar/honey exactly as npm would, installs the tarball into a
 * throwaway consumer whose tsconfig turns on every strictness flag we could plausibly meet,
 * and fails on any diagnostic originating inside the package.
 *
 * This exists because a package that ships raw TypeScript inherits the *consumer's* compiler
 * flags. `skipLibCheck` does not help — it covers `.d.ts` only — and there is no per-directory
 * suppression for `.ts` under node_modules, so a consumer cannot opt out of our lint posture.
 * Nothing else in the test matrix can see that: every other tier compiles honey with honey's
 * own tsconfig.
 *
 *   bun run e2e/run-strict-consumer.ts
 *   bun run e2e/run-strict-consumer.ts --keep     # leave the sandbox for inspection
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const corePath = join(repoRoot, "packages", "core")
const fixture = join(here, "strict-consumer")
const sandbox = join(repoRoot, ".cache", "strict-consumer")
const keep = process.argv.includes("--keep")

const PKG = "@lovrozagar/honey"

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { cwd, stderr: "pipe", stdin: "ignore", stdout: "pipe" })
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	return { code, out: stdout + stderr }
}

rmSync(sandbox, { force: true, recursive: true })
mkdirSync(sandbox, { recursive: true })

/* 1. pack exactly what npm would publish */
console.log("packing …")
const packed = await run(["npm", "pack", "--pack-destination", sandbox, "--silent"], corePath)
if (packed.code !== 0) {
	console.error(packed.out)
	process.exit(1)
}
const tarball = readdirSync(sandbox).find((f) => f.endsWith(".tgz"))
if (!tarball) {
	console.error("npm pack produced no tarball")
	process.exit(1)
}

/* 2. a consumer that depends on the tarball, not the workspace */
const consumer = join(sandbox, "consumer")
mkdirSync(join(consumer, "src"), { recursive: true })
await Bun.write(join(consumer, "src", "app.ts"), await Bun.file(join(fixture, "src", "app.ts")).text())
await Bun.write(join(consumer, "tsconfig.json"), await Bun.file(join(fixture, "tsconfig.json")).text())
await Bun.write(
	join(consumer, "package.json"),
	`${JSON.stringify(
		{
			dependencies: { [PKG]: `file:${join(sandbox, tarball)}`, zod: "4.3.6" },
			devDependencies: { typescript: "7.0.2" },
			name: "strict-consumer-sandbox",
			private: true,
			type: "module",
			version: "0.0.0",
		},
		null,
		2,
	)}\n`,
)

console.log("installing the tarball …")
const installed = await run(["npm", "install", "--no-audit", "--no-fund", "--silent"], consumer)
if (installed.code !== 0) {
	console.error(installed.out)
	process.exit(1)
}

/* 3. type-check under maximal strictness */
console.log("type-checking under maximal strictness …\n")
const checked = await run(["npx", "tsc", "--noEmit", "-p", "tsconfig.json"], consumer)

const lines = checked.out.split("\n").filter((l) => l.includes("error TS"))
const inPackage = lines.filter((l) => l.includes(`node_modules/${PKG}/`))
const inConsumer = lines.filter((l) => !l.includes(`node_modules/${PKG}/`))

if (inPackage.length > 0) {
	const byCode = new Map<string, number>()
	for (const line of inPackage) {
		const code = /error (TS\d+)/.exec(line)?.[1] ?? "TS?"
		byCode.set(code, (byCode.get(code) ?? 0) + 1)
	}
	console.log(`FAIL  ${inPackage.length} diagnostics originate inside ${PKG}\n`)
	for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${String(n).padStart(5)}  ${code}`)
	}
	console.log("\nfirst few:")
	for (const line of inPackage.slice(0, 5)) console.log(`  ${line.trim()}`)
	console.log(
		`\nA consumer cannot suppress these: skipLibCheck covers .d.ts only, and there is no\n` +
			`per-directory opt-out for .ts under node_modules.`,
	)
}

if (inConsumer.length > 0) {
	console.log(`\n${inConsumer.length} diagnostics in the fixture itself (these are ours to fix):`)
	for (const line of inConsumer.slice(0, 10)) console.log(`  ${line.trim()}`)
}

if (!keep) rmSync(sandbox, { force: true, recursive: true })
else console.log(`\nsandbox kept at ${sandbox}`)

if (inPackage.length > 0 || inConsumer.length > 0) process.exit(1)
console.log(`pass  0 diagnostics from ${PKG} under maximal strictness`)
