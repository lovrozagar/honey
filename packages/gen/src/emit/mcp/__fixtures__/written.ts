/**
 * The generated MCP server on disk (bit 18): its files written into a fresh directory under the toolchain cache, its
 * TypeScript checked by the repo's own tsc (strict, erasable syntax only), and a run of it as an MCP client's process:
 * JSON-RPC lines in, the replies read back, standard input closed when they are all sent.
 */
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

/** A fresh directory under the toolchain cache. */
export const scratchDir = (name: string): string => {
	const root = join(process.env.HOME ?? "", ".cache/honey-tmp/gen-mcp")
	mkdirSync(root, { recursive: true })
	return mkdtempSync(join(root, `${name}-`))
}

/** `files` written into a fresh directory: its path. */
export function written(files: Readonly<Record<string, string>>): string {
	const dir = scratchDir("server")
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true })
		writeFileSync(join(dir, path), text)
	}
	return dir
}

/** tsc's diagnostics on the server's `src/`: strict, erasable syntax only, as node's type stripping runs it. */
export function typeErrors(dir: string): string[] {
	const require = createRequire(import.meta.url)
	const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
	const compilerOptions = {
		erasableSyntaxOnly: true,
		lib: ["es2023", "dom"],
		module: "esnext",
		moduleResolution: "bundler",
		noEmit: true,
		noUncheckedIndexedAccess: true,
		skipLibCheck: true,
		strict: true,
		target: "es2022",
		typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
		types: ["node"],
	}
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src"] }))
	try {
		execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" })
		return []
	} catch (error) {
		/* a failed run without one diagnostic is tsc not running at all, never a clean check */
		const lines = String((error as { stdout?: string }).stdout ?? "").split("\n")
		if (!lines.some((line) => / error TS\d+:/.test(line))) throw error
		return lines.filter((line) => / error TS\d+:/.test(line))
	}
}

/** A run of a server: how it exited, each line it wrote to stdout parsed, and its stderr. */
export type Exchanged = {
	readonly status: number | null
	readonly replies: readonly unknown[]
	readonly stderr: string
}

/** `command` run with `lines` on its standard input, one per line (the last unended when `trailing` is false), then closed. */
export function exchange(
	command: readonly string[],
	lines: readonly (string | object)[],
	trailing = true,
): Promise<Exchanged> {
	return new Promise((settle, reject) => {
		const [program, ...args] = command as [string, ...string[]]
		const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] })
		let out = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.once("error", reject)
		child.once("close", (status) =>
			settle({
				replies: out
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as unknown),
				status,
				stderr,
			}),
		)
		const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")
		child.stdin.end(trailing ? `${text}\n` : text)
	})
}

/** A JSON-RPC request line. */
export const request = (id: number, method: string, params?: object) => ({
	id,
	jsonrpc: "2.0",
	method,
	...(params === undefined ? {} : { params }),
})

/** The initialize request for `protocolVersion`. */
export const initialize = (protocolVersion: string) =>
	request(0, "initialize", { capabilities: {}, clientInfo: { name: "honey-test", version: "1.0.0" }, protocolVersion })
