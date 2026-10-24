/**
 * An API keyed by an apiKey header, with a POST event stream (bit 17 phase i): --api-key goes where the spec's scheme
 * says, never as a bearer token; a stream that takes a JSON body sends its method, body, query and header, and prints
 * its events; a parameter's schema default shown in the flag's help, never sent.
 */
import { describe, expect, it } from "vitest"
import { withGo } from "../go/__fixtures__/go-env.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }

/** relay: every call keyed by X-API-Key; `search stream` a POST event stream with a JSON body, a query and a header. */
const relay = () => ({
	components: { securitySchemes: { key: { in: "header", name: "X-API-Key", type: "apiKey" } } },
	info: { title: "Relay", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/ping": { get: { operationId: "ping", responses: { 204: { description: "none" } } } },
		"/search": {
			post: {
				operationId: "search.stream",
				parameters: [
					{ in: "query", name: "limit", schema: { default: 10, type: "integer" } },
					{ in: "query", name: "order", schema: { default: "asc", type: "string" } },
					{ in: "header", name: "X-Trace", schema: { type: "string" } },
				],
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: { q: { type: "string" } }, required: ["q"], type: "object" },
						},
					},
					required: true,
				},
				responses: { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "events" } },
			},
		},
	},
	security: [{ key: [] }],
})

const built = () => builtCli(generateGoCli(relay()).files)

/** One run against a server answering `replies`: the run and what the server saw. */
async function call(args: readonly string[], replies: readonly Reply[]) {
	return served(replies, async (server) => {
		const ran = await built().cli(args, { env: { RELAY_BASE_URL: server.url } })
		return { ...ran, hops: server.hops }
	})
}

describe.skipIf(!GO)("an apiKey API with a POST event stream, built (phase i)", SLOW, () => {
	// v0: 7830d9193a
	it("sends --api-key under the spec's apiKey header, and no bearer token", async () => {
		const ran = await call(["ping", "--api-key", "k"], [{ status: 204 }])
		expect([ran.status, ran.hops[0]?.headers["x-api-key"], ran.hops[0]?.headers.authorization]).toEqual([
			0,
			"k",
			undefined,
		])
	})

	it("shows each parameter's schema default in its flag's help, and sends none of them unasked", async () => {
		const help = (await built().cli(["search", "stream", "--help"])).stdout.split("\n")
		const line = (flag: string) =>
			help
				.find((each) => each.trimStart().startsWith(flag))
				?.replace(/\s+/g, " ")
				.trim()
		const ran = await call(["search", "stream", "--q", "hi"], [{ sse: { end: "close", steps: [] }, status: 200 }])
		expect([line("--limit"), line("--order"), ran.hops[0]?.url]).toEqual([
			"--limit integer (default 10)",
			'--order string (default "asc")',
			"/search",
		])
	})

	// v0: 11dafff788
	// v0: 6940fde3b8
	it("sends a POST stream's method, JSON body, query and header, and prints each event", async () => {
		const events: Reply = { sse: { end: "close", steps: ["data: a\n\n", "data: b\n\n"] }, status: 200 }
		const ran = await call(["search", "stream", "--q", "hi", "--limit", "2", "--x-trace", "t"], [events])
		const hop = ran.hops[0]
		expect([ran.status, ran.stdout, hop?.method, hop?.url, hop?.body.json, hop?.headers["x-trace"]]).toEqual([
			0,
			'{"data":"a"}\n{"data":"b"}\n',
			"POST",
			"/search?limit=2",
			{ q: "hi" },
			"t",
		])
	})
})
