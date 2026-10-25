/**
 * The official MCP clients a leg drives the emitted server with (bit 18): @modelcontextprotocol/sdk 1.32.2 and the v2
 * @modelcontextprotocol/client 2.4.0, pinned by `client-lock.json` (npm ci checks every package's integrity) and
 * installed into the toolchain cache as bit 17's tools are: test fixtures only, never a dependency of gen. An install
 * whose lock is not the one checked in counts as absent. `clientCheck` runs one client against a server command and
 * reports what it saw.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURES = "packages/gen/src/emit/mcp/__fixtures__"

/** Where the clients are installed. */
export const clientsDir = (): string => join(process.env.HOME ?? "", ".cache/honey-tmp/mcp-clients")

/** The checked-in lock's sha256, as an install stamps it. */
const lockSha = () =>
	createHash("sha256")
		.update(readFileSync(new URL("./client-lock.json", import.meta.url)))
		.digest("hex")

/** The command that installs the pinned clients, from anywhere in the repo: verified by npm ci, kept whole or not at all. */
export function clientsInstall(): string {
	return [
		`P="$(git rev-parse --show-toplevel)/${FIXTURES}" && D="$HOME/.cache/honey-tmp/mcp-clients"`,
		`rm -rf "$D.partial" && mkdir -p "$D.partial" && cp "$P/client-pins.json" "$D.partial/package.json"`,
		`cp "$P/client-lock.json" "$D.partial/package-lock.json"`,
		`(cd "$D.partial" && npm ci --ignore-scripts --no-audit --no-fund)`,
		`sha256sum "$P/client-lock.json" | cut -d" " -f1 > "$D.partial/lock.sha256" && rm -rf "$D" && mv "$D.partial" "$D"`,
	].join(" && ")
}

/** Whether the pinned clients are installed, from the lock checked in now. */
export const hasClients = (): boolean => {
	const stamp = join(clientsDir(), "lock.sha256")
	return existsSync(stamp) && readFileSync(stamp, "utf8").trim() === lockSha()
}

/** Whether a leg runs its clients half: a missing install fails where toolchains are required, and skips elsewhere. */
export function withClients(): boolean {
	const present = hasClients()
	if (!present && process.env.HONEY_REQUIRE_TOOLCHAINS === "1")
		throw new Error(`the pinned MCP clients are required here and are not installed: ${clientsInstall()}`)
	return present
}

/** Each client: its import of the client class and the stdio transport, and of its latest protocol revision. */
const CLIENTS = {
	sdk: [
		'import { Client } from "@modelcontextprotocol/sdk/client/index.js"',
		'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"',
		'import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"',
	],
	v2: [
		'import { Client, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"',
		'import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"',
	],
} as const

export type ClientName = keyof typeof CLIENTS

/** What a client saw: its latest revision, the one negotiated, the tools listed, a call's result or error. */
export type ClientSaw = {
	readonly latest: string
	readonly negotiated: string
	readonly tools: readonly Record<string, unknown>[]
	readonly called?: unknown
	readonly failed?: string
}

/** The check script for `client`: connect, list, call `tool` with `args` when named, report one JSON line. */
const script = (client: ClientName) =>
	`${CLIENTS[client].join("\n")}
const [command, ...rest] = JSON.parse(process.argv[2])
const call = JSON.parse(process.argv[3])
const client = new Client({ name: "honey-check", version: "1.0.0" })
await client.connect(new StdioClientTransport({ args: rest, command, env: process.env }))
const out = { latest: LATEST_PROTOCOL_VERSION, negotiated: client.getNegotiatedProtocolVersion?.() ?? client.transport?.protocolVersion ?? "", tools: (await client.listTools()).tools }
if (call) try { out.called = await client.callTool(call) } catch (error) { out.failed = String(error?.message ?? error) }
console.log(JSON.stringify(out))
await client.close()
`

/** `client` run against the server `command`, calling `call` when given; what it saw. */
export function clientCheck(
	client: ClientName,
	command: readonly string[],
	call?: { readonly name: string; readonly arguments: Record<string, unknown> },
): Promise<ClientSaw> {
	const path = join(clientsDir(), `check-${client}.mjs`)
	writeFileSync(path, script(client))
	return new Promise((settle, reject) => {
		const child = spawn(process.execPath, [path, JSON.stringify(command), JSON.stringify(call ?? null)], {
			cwd: clientsDir(),
			stdio: ["ignore", "pipe", "pipe"],
		})
		let out = ""
		let err = ""
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
		child.once("error", reject)
		child.once("close", (status) =>
			status === 0 ? settle(JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as ClientSaw) : reject(new Error(err)),
		)
	})
}

/** One step of a client session: list the tools, or call one. */
export type Step = { readonly list: true } | { readonly call: { readonly name: string; readonly arguments: object } }

/** The session script for `client`: connect, run each step in order, report every result (or its error) as one JSON line. */
const sessionScript = (client: ClientName) =>
	`${CLIENTS[client].join("\n")}
const [command, ...rest] = JSON.parse(process.argv[2])
const steps = JSON.parse(process.argv[3])
const client = new Client({ name: "honey-conformance", version: "1.0.0" })
await client.connect(new StdioClientTransport({ args: rest, command, env: process.env }))
const out = []
for (const step of steps) {
	try {
		out.push(step.list ? { tools: (await client.listTools()).tools } : { result: await client.callTool(step.call) })
	} catch (error) {
		out.push({ failed: String(error?.message ?? error) })
	}
}
console.log(JSON.stringify(out))
await client.close()
`

/** What one step gave: the tools listed, a call's result, or the client's error. */
export type Stepped = {
	readonly tools?: Record<string, unknown>[]
	readonly result?: Record<string, unknown>
	readonly failed?: string
}

/** `client` run against the server `command`, through `steps` in order: each step's tools, result or failure. */
export function clientSession(
	client: ClientName,
	command: readonly string[],
	steps: readonly Step[],
): Promise<readonly Stepped[]> {
	const path = join(clientsDir(), `session-${client}.mjs`)
	writeFileSync(path, sessionScript(client))
	return new Promise((settle, reject) => {
		const child = spawn(process.execPath, [path, JSON.stringify(command), JSON.stringify(steps)], {
			cwd: clientsDir(),
			stdio: ["ignore", "pipe", "pipe"],
		})
		let out = ""
		let err = ""
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
		child.once("error", reject)
		child.once("close", (status) =>
			status === 0
				? settle(JSON.parse(out.trim().split("\n").at(-1) ?? "[]") as readonly Stepped[])
				: reject(new Error(err)),
		)
	})
}

/** Whether npm can run here: the packed-install leg needs it. */
export const hasNpm = (): boolean => spawnSync("npm", ["--version"]).status === 0
