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

/** A running server: lines sent as the test goes, each line it writes seen as it comes. */
export type Live = {
	readonly lines: readonly Record<string, unknown>[]
	send(line: string | object): void
	/** settles with the first line written, before or after, that `test` holds for */
	seen(test: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
	/** closes its input; settles as `exchange` does once it exits */
	close(): Promise<Exchanged>
}

/** `command` started, its input left open: a latch can wait on what it wrote before the next line goes. */
export function live(command: readonly string[]): Live {
	const [program, ...args] = command as [string, ...string[]]
	const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] })
	const lines: Record<string, unknown>[] = []
	const waiting: [(line: Record<string, unknown>) => boolean, (line: Record<string, unknown>) => void][] = []
	let out = ""
	let stderr = ""
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString()
		for (let end = out.indexOf("\n"); end >= 0; end = out.indexOf("\n")) {
			const text = out.slice(0, end)
			/* a line that is not JSON is kept as it came, for a leg to see, never thrown inside the stream */
			let line: Record<string, unknown>
			try {
				line = JSON.parse(text) as Record<string, unknown>
			} catch {
				line = { unparsed: text }
			}
			out = out.slice(end + 1)
			lines.push(line)
			for (const wait of waiting.filter(([test]) => test(line))) {
				waiting.splice(waiting.indexOf(wait), 1)
				wait[1](line)
			}
		}
	})
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
	const exited = new Promise<number | null>((settle) => child.once("close", settle))
	return {
		close: async () => {
			child.stdin.end()
			return { replies: lines, status: await exited, stderr }
		},
		lines,
		seen: (test) =>
			new Promise((settle) => {
				const found = lines.find(test)
				if (found === undefined) waiting.push([test, settle])
				else settle(found)
			}),
		send: (line) => void child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`),
	}
}

/** The id of the request `line` is, when it is one. */
const requestId = (line: string | object): unknown => {
	const message = (typeof line === "string" ? JSON.parse(line) : line) as { id?: unknown; method?: unknown }
	return typeof message.method === "string" ? message.id : undefined
}

/** `command` run with `lines` sent one by one, each request only once the one before it was answered; then closed. */
export async function exchangeEach(
	command: readonly string[],
	lines: readonly (string | object)[],
): Promise<Exchanged> {
	const server = live(command)
	for (const line of lines) {
		server.send(line)
		const id = requestId(line)
		if (id !== undefined) await server.seen((written) => written.id === id && !("method" in written))
	}
	return server.close()
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
