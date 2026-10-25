/**
 * The MCP server's header and redirect settings (bit 19 g, carry-in #12), as the Go CLI's: `$<PREFIX>_HEADERS`, a JSON
 * object of string values, goes on every call, each value scrubbed from every result as the API key is; one that is no
 * such object, or holds a header phase b1 refuses, stops the server at start, its value never quoted.
 * `$<PREFIX>_REDIRECT` is same-origin by default (a cross-origin redirect is the result's failure) or follow (followed,
 * the credentials dropped on the other origin); any other value stops the server at start.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { exchange, exchangeEach, initialize, request, written } from "./__fixtures__/written.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 120_000 }

const DOC = {
	info: { title: "Conf", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/echo": {
			get: {
				operationId: "echo.get",
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
				"x-mcp": true,
			},
		},
	},
}

/** The server's command against the API at `url`, with `env`. */
const commandOf = (url: string, env: string[]) => [
	"env",
	`CONF_BASE_URL=${url}`,
	...env,
	process.execPath,
	join(written(generateMcpServer(DOC).files), "dist", "server.js"),
]

/** One echo_get call over `replies` with `env`: its result's text and isError, and each hop's origin, path and headers. */
async function called(replies: readonly Reply[], env: string[]) {
	return served(replies, async (server) => {
		const ran = await exchangeEach(commandOf(server.url, env), [
			initialize("2025-11-25"),
			request(1, "tools/call", { arguments: {}, name: "echo_get" }),
		])
		const result = (ran.replies[1] as { result: { content: [{ text: string }]; isError?: true } }).result
		const hops = server.hops.map((hop) => [hop.origin, hop.url, hop.headers.authorization, hop.headers["x-trace"]])
		return { error: result.isError ?? false, hops, text: result.content[0].text }
	})
}

/** How the server started under `env`: its exit status, what it wrote, and its stderr. */
async function started(env: string[]) {
	const ran = await exchange(commandOf("http://127.0.0.1:1", env), [initialize("2025-11-25")])
	return { replies: ran.replies.length, status: ran.status, stderr: ran.stderr }
}

describe("the MCP server's $<PREFIX>_HEADERS (bit 19 g, #12)", SLOW, () => {
	it("sends each header on every call and scrubs each value from the result", async () => {
		const env = ['CONF_HEADERS={"x-trace":"hv-s3cret"}']
		expect(await called([{ json: { seen: "hv-s3cret" }, status: 200 }], env)).toEqual({
			error: false,
			hops: [["primary", "/echo", undefined, "hv-s3cret"]],
			text: '{"seen":"[redacted]"}',
		})
	})

	it("stops at start on a value that is no JSON object of strings, or a header phase b1 refuses, quoting no value", async () => {
		const runs = await Promise.all(
			[
				"CONF_HEADERS=nope-s3cret",
				'CONF_HEADERS=["v-s3cret"]',
				'CONF_HEADERS={"x-a":1}',
				'CONF_HEADERS={"x b":"v-s3cret"}',
				'CONF_HEADERS={"x-a":"v-s3cret\\n"}',
			].map((env) => started([env])),
		)
		const shape = "Invalid $CONF_HEADERS: a JSON object of string values\n"
		expect(runs).toEqual([
			{ replies: 0, status: 1, stderr: shape },
			{ replies: 0, status: 1, stderr: shape },
			{ replies: 0, status: 1, stderr: shape },
			{ replies: 0, status: 1, stderr: "Invalid $CONF_HEADERS: the x b header cannot be sent\n" },
			{ replies: 0, status: 1, stderr: "Invalid $CONF_HEADERS: the x-a header's value cannot be sent\n" },
		])
	})
})

describe("the MCP server's $<PREFIX>_REDIRECT (bit 19 g, #12)", SLOW, () => {
	const away: Reply = { redirect: { origin: "alt", path: "/echo" }, status: 302 }
	const env = ["CONF_API_KEY=k-s3cret", 'CONF_HEADERS={"x-trace":"t-s3cret"}']

	it("follows no cross-origin redirect by default; under follow, follows it without the credentials", async () => {
		const unset = await called([away], env)
		const follow = await called([away, { json: { ok: true }, status: 200 }], [...env, "CONF_REDIRECT=follow"])
		expect({ follow, unset: [unset.error, unset.hops] }).toEqual({
			follow: {
				error: false,
				hops: [
					["primary", "/echo", "Bearer k-s3cret", "t-s3cret"],
					["alt", "/echo", undefined, undefined],
				],
				text: '{"ok":true}',
			},
			unset: [true, [["primary", "/echo", "Bearer k-s3cret", "t-s3cret"]]],
		})
	})

	it("stops at start on any other value", async () => {
		expect(await started(["CONF_REDIRECT=sideways"])).toEqual({
			replies: 0,
			status: 1,
			stderr: "Invalid $CONF_REDIRECT: same-origin or follow\n",
		})
	})
})
