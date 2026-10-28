/**
 * The official MCP clients a leg drives the emitted server with (bit 18): @modelcontextprotocol/sdk 1.32.2 and the v2
 * @modelcontextprotocol/client 2.4.0, pinned by `client-lock.json` (npm ci checks every package's integrity) and
 * installed into the toolchain cache as bit 17's tools are: test fixtures only, never a dependency of gen. An install
 * whose lock is not the one checked in counts as absent. `clientCheck` runs one client against a server command and
 * reports what it saw. Bit 21 b: `modern` is the v2 client pinned to 2026-07-28 (python-client.ts holds Python's), and
 * a `negotiated` step reports the revision a session runs under.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { clientsInstall } from "../../shared/__fixtures__/installs.ts"
import type { Step, Stepped } from "./steps.ts"

/** Where the clients are installed. */
export const clientsDir = (): string => join(process.env.HOME ?? "", ".cache/honey-tmp/mcp-clients")

/** The checked-in lock's sha256, as an install stamps it. */
const lockSha = () =>
	createHash("sha256")
		.update(readFileSync(new URL("./client-lock.json", import.meta.url)))
		.digest("hex")

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
	modern: [
		'import { Client, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"',
		'import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"',
	],
} as const

/** Each client's options beside its name: the modern one pinned to 2026-07-28, never falling back to initialize. */
const OPTIONS: Readonly<Record<keyof typeof CLIENTS, string>> = {
	modern: '{ versionNegotiation: { mode: { pin: "2026-07-28" } } }',
	sdk: "{}",
	v2: "{}",
}

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
const client = new Client({ name: "honey-check", version: "1.0.0" }, ${OPTIONS[client]})
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

/** The session script for `client`: connect, run each step in order, report every result (or its error) as one JSON line. */
const sessionScript = (client: ClientName) =>
	`${CLIENTS[client].join("\n")}
const [command, ...rest] = JSON.parse(process.argv[2])
const steps = JSON.parse(process.argv[3])
const client = new Client({ name: "honey-conformance", version: "1.0.0" }, ${OPTIONS[client]})
const transport = new StdioClientTransport({ args: rest, command, env: process.env })
/* sdk 1.32.2 keeps no negotiated revision on a stdio client: it hands it to the transport, when it can take one */
let negotiated
transport.setProtocolVersion ??= (version) => void (negotiated = version)
await client.connect(transport)
const out = []
for (const step of steps) {
	try {
		out.push(step.negotiated ? { negotiated: client.getNegotiatedProtocolVersion?.() ?? negotiated } : step.list ? { tools: (await client.listTools()).tools } : { result: await client.callTool(step.call) })
	} catch (error) {
		out.push({ failed: String(error?.message ?? error) })
	}
}
console.log(JSON.stringify(out))
await client.close()
`

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

export { clientsInstall }

export type { Step, Stepped }
