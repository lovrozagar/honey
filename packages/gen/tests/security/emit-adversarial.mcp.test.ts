/**
 * The MCP third of gen's adversarial suite (bit 18): the emitted server against hostile arguments, hostile spec text
 * and an API that echoes its key. A path value that could leave its segment (H18.11: `/`, `\`, `%2f`, `%5c` in any
 * case, `.` or `..`, after any number of decodings) is refused naming the parameter, and nothing is sent; so is an
 * argument holding `__proto__`, `constructor` or `prototype` as a key at any depth. A schema's prototype-named
 * properties are listed as its own. Spec text written into tools.gen.ts reads back as it came (the F2 fuzz). The API
 * key, as given, URL-encoded in either hex case and form-encoded, appears in no result, no echoed error body and no
 * stderr. The gen mutation harness reruns this file alone with each MCP guard disabled.
 */
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import { type Reply, served } from "../../src/emit/shared/__fixtures__/recording-server.ts"
import { guardNamed } from "../structure/mutation-harness.guards.ts"

const REPO = resolve(import.meta.dirname, "../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock: the emitter reaches runtime.ts and literal.ts, so a mutant's server is what is gated */
const { generateMcpServer } = (await import(
	resolve(REPO, "packages/gen/src/emit/mcp/server.ts")
)) as typeof import("../../src/emit/mcp/server.ts")
const { literal } = (await import(
	resolve(REPO, "packages/gen/src/emit/mcp/literal.ts")
)) as typeof import("../../src/emit/mcp/literal.ts")
const { exchange, initialize, request, written } = (await import(
	resolve(REPO, "packages/gen/src/emit/mcp/__fixtures__/written.ts")
)) as typeof import("../../src/emit/mcp/__fixtures__/written.ts")
const { failures } = (await import(
	resolve(REPO, "packages/gen/src/emit/shared/__fixtures__/escape-oracle.ts")
)) as typeof import("../../src/emit/shared/__fixtures__/escape-oracle.ts")

const SLOW = { timeout: 120_000 }
const STR = { type: "string" }
const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype"]

/** The vault document: `files.get` by a path name, `notes.create` with prototype-named properties, its key a header. */
const vault = {
	components: { securitySchemes: { key: { in: "header", name: "X-API-Key", type: "apiKey" } } },
	info: { title: "Vault", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/files/{name}": {
			get: {
				operationId: "files.get",
				parameters: [{ in: "path", name: "name", required: true, schema: STR }],
				responses: OK,
				"x-mcp": true,
			},
		},
		"/notes": {
			post: {
				operationId: "notes.create",
				parameters: [{ in: "query", name: "__proto__", schema: STR }],
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: {
									...Object.fromEntries(PROTOTYPE_KEYS.map((key) => [key, STR])),
									list: { items: {}, type: "array" },
									meta: {},
								},
								type: "object",
							},
						},
					},
				},
				responses: OK,
				"x-mcp": true,
			},
		},
	},
	security: [{ key: [] }],
}

/** A tools/call request line, written as text, so a `__proto__` key in its arguments stays an own key on the wire. */
const callLine = (id: number, name: string, args: string) =>
	`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${name}","arguments":${args}}}`

/** The vault server run against a recording server answering `replies`, with `env`: its replies, stderr and hops. */
async function vaultRun(lines: readonly (string | object)[], replies: readonly Reply[], env: readonly string[] = []) {
	const dir = written(generateMcpServer(vault).files)
	return served(replies, async (server) => {
		const command = ["env", `VAULT_BASE_URL=${server.url}`, ...env, process.execPath, join(dir, "dist", "server.js")]
		const ran = await exchange(command, [initialize("2025-11-25"), ...lines])
		return { hops: server.hops, replies: ran.replies.slice(1), stderr: ran.stderr }
	})
}

/** A refusal's result, as the server answers it. */
const refused = (why: string) => ({
	content: [{ text: JSON.stringify({ message: `Invalid arguments: ${why}` }), type: "text" }],
	isError: true,
})

describe("gen adversarial: an MCP tool's path argument (H18.11)", SLOW, () => {
	// v0: fe7f9e3b70
	it("refuses a value that could leave its segment, after any number of decodings and in any case, and sends nothing; others go escaped", async () => {
		const leaving = [
			"../../admin",
			"a/b",
			"x%2f..%2fy",
			"%2E%2E",
			"%2e",
			"a\\b",
			"%5C",
			"%5c",
			"%2F",
			"%252f",
			"%252E%252E",
			"%25252F",
			"%2%46",
			".",
			"..",
		]
		const safe = ["a.b", "...", "a..b", "%41", "x%20y"]
		const { hops, replies } = await vaultRun(
			[...leaving, ...safe].map((name, i) => request(i + 1, "tools/call", { arguments: { name }, name: "files_get" })),
			safe.map(() => ({ json: {}, status: 200 })),
		)
		expect([replies.map((reply) => (reply as { result: unknown }).result), hops.map((hop) => hop.url)]).toEqual([
			[
				...leaving.map(() => refused("name must stay within one path segment")),
				...safe.map(() => ({ content: [{ text: "{}", type: "text" }] })),
			],
			["/files/a.b", "/files/...", "/files/a..b", "/files/%2541", "/files/x%2520y"],
		])
	})
})

describe("gen adversarial: prototype keys", SLOW, () => {
	it("refuses __proto__, constructor or prototype as an argument's key at any depth, and sends nothing", async () => {
		const cases = [
			['{"name":"a","__proto__":{"x":1}}', "files_get", "__proto__"],
			['{"__proto__":"q"}', "notes_create", "__proto__"],
			['{"body":{"constructor":"c"}}', "notes_create", "body.constructor"],
			['{"body":{"meta":{"__proto__":{"polluted":true}}}}', "notes_create", "body.meta.__proto__"],
			['{"body":{"meta":{"a":{"prototype":1}}}}', "notes_create", "body.meta.a.prototype"],
			['{"body":{"list":[1,{"constructor":{}}]}}', "notes_create", "body.list[1].constructor"],
		] as const
		const { hops, replies } = await vaultRun(
			cases.map(([args, name], i) => callLine(i + 1, name, args)),
			[],
		)
		expect([replies.map((reply) => (reply as { result: unknown }).result), hops]).toEqual([
			cases.map(([, , at]) => refused(`${at} names a prototype`)),
			[],
		])
	})

	it("lists a schema's prototype-named properties as its own, a parameter's and a body's alike", async () => {
		const { replies } = await vaultRun([request(1, "tools/list")], [])
		const tools = (replies[0] as { result: { tools: { name: string; inputSchema: Record<string, unknown> }[] } }).result
			.tools
		const notes = tools.find((tool) => tool.name === "notes_create")?.inputSchema as {
			properties: Record<string, { properties?: Record<string, unknown> }>
		}
		expect([Object.keys(notes.properties), Object.keys(notes.properties.body?.properties ?? {})]).toEqual([
			["__proto__", "body"],
			[...PROTOTYPE_KEYS, "list", "meta"],
		])
	})
})

/* a code point no emitted TypeScript may carry raw: NUL, the BOM, U+2028 and U+2029 */
const RAW = ["\u0000", "\uFEFF", "\u2028", "\u2029"]

/** `text` as a key, a value and a nested value. */
const holding = (text: string) => Object.fromEntries([[text, [text, Object.fromEntries([["k", text]])]]])

/**
 * Why `text`, as a key and as values, does not read back from its tools.gen.ts literal as it came; null when it does.
 * As it came is the shared escape's own: each unpaired surrogate U+FFFD, since no target carries one to the wire.
 */
function literalProblem(text: string): string | null {
	const source = literal(holding(text))
	const raw = RAW.find((point) => source.includes(point))
	if (raw !== undefined) return `raw U+${raw.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`
	const back = runInNewContext(`(${source})`) as Record<string, unknown>
	if (!Object.hasOwn(back, text.toWellFormed())) return "the key is not an own property"
	return JSON.stringify(back) === JSON.stringify(holding(text.toWellFormed())) ? null : "it reads back otherwise"
}

describe("gen adversarial: spec text in tools.gen.ts (F2)", () => {
	it("reads back as it came, never a raw separator, every key its own property, over the F2 fuzz", () => {
		const named = ["__proto__", "constructor", "\u2028", "\u2029", "\uFEFF", "\0", "\uD800", '"; process.exit(1); "']
		expect([named.map(literalProblem), failures(41, literalProblem, 2_000)]).toEqual([named.map(() => null), []])
	})
})

/** The key every form of which must stay out of the server's answers: a space, a slash, a plus, quotes. */
const KEY = 'k3y/+& "s3cret"'
const FORMS = {
	encoded: encodeURIComponent(KEY),
	form: new URLSearchParams({ s: KEY }).toString().slice(2),
	lower: encodeURIComponent(KEY).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
	raw: KEY,
}

/** Every string in `value`, keys included, a text block's JSON read as JSON. */
function strings(value: unknown): string[] {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value)
			if (typeof parsed === "object" && parsed !== null) return [value, ...strings(parsed)]
		} catch {
			/* not JSON: the text alone */
		}
		return [value]
	}
	if (typeof value !== "object" || value === null) return []
	return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
}

describe("gen adversarial: the API key", SLOW, () => {
	it("never appears, in any form, in a result, an echoed error body or stderr, and still reaches the API", async () => {
		const echoed = {
			[KEY]: "as a key",
			...Object.fromEntries(Object.entries(FORMS).map(([name, form]) => [name, `before ${form} after`])),
		}
		const { hops, replies, stderr } = await vaultRun(
			[1, 2].map((id) => request(id, "tools/call", { arguments: { name: "a" }, name: "files_get" })),
			[
				{ json: echoed, status: 200 },
				{ json: { detail: `bad key ${KEY}`, url: `https://vault.test/?key=${FORMS.lower}` }, status: 401 },
			],
			[`VAULT_API_KEY=${KEY}`],
		)
		const seen = strings(replies)
		const leaks = Object.entries(FORMS).filter(([, form]) => [...seen, stderr].some((text) => text.includes(form)))
		const results = replies.map((reply) => (reply as { result: { isError?: true } }).result)
		expect([
			leaks.map(([name]) => name),
			results.map((result) => [result.isError, JSON.stringify(result).includes("[redacted]")]),
			hops.map((hop) => hop.headers["x-api-key"]),
		]).toEqual([
			[],
			[
				[undefined, true],
				[true, true],
			],
			[KEY, KEY],
		])
	})
})
