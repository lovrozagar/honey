/**
 * The mounted endpoint as a resource server, driven by the official TS clients' own OAuth flows (bit 21 f): the v2
 * @modelcontextprotocol/client 2.4.0, legacy and pinned to 2026-07-28, and the legacy @modelcontextprotocol/sdk 1.32.2,
 * each with an `authProvider` against the stub authorization server (mcp-oauth/fixture.ts). From a bare connect: the
 * 401 points at the metadata, the client discovers the authorization server from it, authorizes with PKCE S256 and
 * the endpoint as `resource`, and calls; a call needing more scope gets the 403 step-up challenge, re-authorizes for
 * the union and succeeds. Everything is local: the clients run under node from the pinned install.
 */
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clientsDir, withClients } from "../../../gen/src/emit/mcp/__fixtures__/clients.ts"
import { CLIENT_ID, type OAuthWorld, REDIRECT_URI, startOAuthWorld } from "./mcp-oauth/fixture.ts"

/** Each client: its imports, its options beside its name, and how it hands the callback to finishAuth. */
const CLIENTS = {
	modern: {
		imports: 'import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client"',
		finish: "callback",
		options: '{ versionNegotiation: { mode: { pin: "2026-07-28" } } }',
	},
	sdk: {
		imports: [
			'import { Client } from "@modelcontextprotocol/sdk/client/index.js"',
			'import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"',
			'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"',
		].join("\n"),
		finish: 'callback.get("code")',
		options: "{}",
	},
	v2: {
		imports: 'import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client"',
		finish: "callback",
		options: "{}",
	},
} as const

/**
 * The OAuth session for `client`: a provider pre-registered as CLIENT_ID whose redirect is followed at once (the stub
 * approves and redirects back), a connect that finishes the authorization the 401 started and reconnects, a list, a
 * read and a create that finishes the step-up the 403 started and calls again; one JSON line of what it saw.
 */
const script = (client: keyof typeof CLIENTS) => `${CLIENTS[client].imports}
const endpoint = new URL(process.argv[2])
let tokens, verifier, discovery, callback
const authorizations = []
const provider = {
	get redirectUrl() { return ${JSON.stringify(REDIRECT_URI)} },
	get clientMetadata() {
		return { client_name: "honey-oauth", grant_types: ["authorization_code"], redirect_uris: [${JSON.stringify(REDIRECT_URI)}], response_types: ["code"], token_endpoint_auth_method: "none" }
	},
	clientInformation: () => ({ client_id: ${JSON.stringify(CLIENT_ID)} }),
	tokens: () => tokens,
	saveTokens: (saved) => void (tokens = saved),
	redirectToAuthorization: async (url) => {
		authorizations.push(url.searchParams.get("scope"))
		callback = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")).searchParams
	},
	saveCodeVerifier: (saved) => void (verifier = saved),
	codeVerifier: () => verifier,
	discoveryState: () => discovery,
	saveDiscoveryState: (saved) => void (discovery = saved),
}
const out = { authorizations }
const opened = () => [new StreamableHTTPClientTransport(endpoint, { authProvider: provider }), new Client({ name: "honey-oauth", version: "1.0.0" }, ${CLIENTS[client].options})]
/* an authorization the client started: finish it with the callback, then run again */
const authorized = async (transport, run) => {
	try {
		return await run()
	} catch (error) {
		if (!(error instanceof UnauthorizedError) || callback === undefined) throw error
		await transport.finishAuth(${CLIENTS[client].finish})
		callback = undefined
		return run()
	}
}
try {
	let [transport, client] = opened()
	try {
		await client.connect(transport)
	} catch (error) {
		if (!(error instanceof UnauthorizedError)) throw error
		await transport.finishAuth(${CLIENTS[client].finish})
		;[transport, client] = opened()
		await client.connect(transport)
	}
	out.tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
	out.read = await authorized(transport, () => client.callTool({ name: "get_orders", arguments: {} }))
	out.created = await authorized(transport, () => client.callTool({ name: "post_orders", arguments: {} }))
	await client.close()
} catch (error) {
	out.failed = String(error?.message ?? error)
}
console.log(JSON.stringify(out))
`

type Saw = {
	readonly authorizations: readonly (string | null)[]
	readonly tools?: readonly string[]
	readonly read?: { readonly _meta?: unknown; readonly structuredContent?: unknown }
	readonly created?: { readonly _meta?: unknown; readonly structuredContent?: unknown }
	readonly failed?: string
}

/** `client`'s OAuth session against `endpoint`: what it saw. */
function session(client: keyof typeof CLIENTS, endpoint: string): Promise<Saw> {
	const path = join(clientsDir(), `oauth-${client}.mjs`)
	writeFileSync(path, script(client))
	return new Promise((settle, reject) => {
		const child = spawn(process.execPath, [path, endpoint], { cwd: clientsDir(), stdio: ["ignore", "pipe", "pipe"] })
		let out = ""
		let err = ""
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
		child.once("error", reject)
		child.once("close", (status) =>
			status === 0 ? settle(JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Saw) : reject(new Error(err)),
		)
	})
}

/** The log's auth sequence: every refusal or server failure, every metadata read, every authorization server step. */
const authSteps = (log: readonly string[]) =>
	log.filter((line) => line.startsWith("as ") || / (?:40[13]|5\d\d)$/.test(line) || line.includes("/.well-known/"))

describe.skipIf(!withClients())("the mounted resource server under the official TS clients' OAuth (bit 21 f)", () => {
	let world: OAuthWorld
	beforeAll(async () => {
		world = await startOAuthWorld()
	})
	afterAll(() => world.stop())

	it.each(["v2", "modern", "sdk"] as const)(
		"%s: 401 → metadata → authorization server → PKCE token for the endpoint → call; 403 → step-up → call",
		async (client) => {
			const from = world.log.length
			const saw = await session(client, world.endpoint)
			const { endpoint } = world
			expect([saw, authSteps(world.log.slice(from))]).toEqual([
				{
					authorizations: ["orders:read", "orders:read orders:write"],
					created: expect.objectContaining({ _meta: { "honey/status": 201 }, structuredContent: { created: "o-2" } }),
					read: expect.objectContaining({ _meta: { "honey/status": 200 }, structuredContent: { orders: ["o-1"] } }),
					tools: ["get_orders", "post_orders"],
				},
				[
					"app POST /mcp 401",
					"app GET /.well-known/oauth-protected-resource/mcp 200",
					"as GET /.well-known/oauth-authorization-server 200",
					`as authorize scope=orders:read resource=${endpoint} method=S256`,
					"as GET /authorize 302",
					`as token resource=${endpoint} pkce=true`,
					"as POST /token 200",
					"app POST /mcp 403",
					`as authorize scope=orders:read orders:write resource=${endpoint} method=S256`,
					"as GET /authorize 302",
					`as token resource=${endpoint} pkce=true`,
					"as POST /token 200",
				],
			])
		},
		60_000,
	)
})
