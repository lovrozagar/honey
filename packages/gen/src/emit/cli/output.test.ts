/**
 * The CLI's output (bit 17 phase c): --json one line of compact JSON, and the piped default byte for byte the same
 * (your Q4 sharpening, both ways); ndjson, yaml (read back by a YAML parser to the same value) and table (control
 * characters escaped); table the default on a terminal; -i the declared response headers beside the data; --raw the
 * response as it came; -o to a file; and an error on stderr as one JSON line under JSON, by kind, else after the name.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli, type RunOptions } from "./__fixtures__/built.ts"
import { shop } from "./__fixtures__/shop.ts"
import { yamlValue } from "./__fixtures__/yaml.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }

const built = () => builtCli(generateGoCli(shop()).files)

/** One run of the shop CLI against a server answering `replies`. */
async function call(args: readonly string[], replies: readonly Reply[], options: RunOptions = {}) {
	return served(replies, (server) =>
		built().cli(args, { ...options, env: { SHOP_BASE_URL: server.url, ...options.env } }),
	)
}

/** The answer every format renders: keys a YAML reader would misread, strings YAML treats specially, controls. */
const TRICKY = {
	"a b": "x: y # z",
	empty: { list: [], map: {} },
	list: [1, 2.5, -3, true, null, "- dash", "\u001b[31mred", "line\nbreak", "ü €"],
	nested: { deeper: [{ k: "v" }, [1, [2]]] },
	true: "yes",
	"0x": "on",
	/* keys a bare writer breaks or a reader retypes: a mapping inside a key, a comment, a number (1e3 reads as 1000) */
	"k: v": 1,
	"# c": 2,
	"1e3": 3,
	"": 4,
}

describe.skipIf(!GO)("the formats (phase c)", SLOW, () => {
	it("prints --json as one compact line, and a piped run with no flag byte for byte the same", async () => {
		const list = [{ id: "a", name: "<x&y>" }]
		const [flagged, piped] = [
			await call(["dump", "get", "--json"], [{ json: list, status: 200 }]),
			await call(["dump", "get"], [{ json: list, status: 200 }]),
		]
		expect([flagged.stdout, piped.stdout === flagged.stdout]).toEqual(['[{"id":"a","name":"<x&y>"}]\n', true])
	})

	// v0: 4bc9131e15
	it("prints ndjson a list item per line, and anything else as one line", async () => {
		const [list, object] = [
			await call(
				["items", "list", "--format", "ndjson"],
				[
					{
						json: [
							{ id: "a", name: "1" },
							{ id: "b", name: "2" },
						],
						status: 200,
					},
				],
			),
			await call(["health", "--format", "ndjson"], [{ json: { ok: true }, status: 200 }]),
		]
		expect([list.stdout, object.stdout]).toEqual(['{"id":"a","name":"1"}\n{"id":"b","name":"2"}\n', '{"ok":true}\n'])
	})

	it("prints yaml a YAML parser reads back to the very value", async () => {
		const ran = await call(["dump", "get", "--format", "yaml"], [{ json: TRICKY, status: 200 }])
		expect([ran.status, yamlValue(ran.stdout)]).toEqual([0, TRICKY])
	})

	// v0: 904c87c75b
	// v0: 96c6447b4a
	it("prints a table: a column per key over a list of objects, its controls escaped, nested values as JSON", async () => {
		const rows = [
			{ id: "a", name: "\u001b[31mred\u001b[0m", tags: ["x"] },
			{ id: "b", name: "tab\there" },
		]
		const ran = await call(["dump", "get", "--format", "table"], [{ json: rows as Reply["json"], status: 200 }])
		expect(ran.stdout).toBe(
			["ID  NAME                TAGS", 'a   \\x1b[31mred\\x1b[0m  ["x"]', "b   tab\\there", ""].join("\n"),
		)
	})

	it("prints an object as a table of its keys and values", async () => {
		const ran = await call(["dump", "get", "--format", "table"], [{ json: { ok: true, zone: null }, status: 200 }])
		expect(ran.stdout).toBe("ok    true\nzone\n")
	})
})

/** A JSON answer as the server wrote it, byte for byte. */
const jsonText = (text: string): Reply => ({ headers: { "content-type": "application/json" }, status: 200, text })

describe.skipIf(!GO)("the formats' values: a scalar in a table, an integer past 2^53 (phase i)", SLOW, () => {
	// v0: 22f354cbef
	it("prints a scalar answer as its value in a table", async () => {
		const ran = await call(["version2", "--format", "table"], [{ json: "1.2.3", status: 200 }])
		expect(ran.stdout).toBe("1.2.3\n")
	})

	// v0: dd36c5aed5
	it("prints an integer past 2^53 exactly, as JSON and in a table", async () => {
		const [json, table] = [
			await call(["dump", "get"], [jsonText('{"id":1234567890123456789,"n":[12345678901234567890]}')]),
			await call(["dump", "get", "--format", "table"], [jsonText('{"id":1234567890123456789}')]),
		]
		expect([json.stdout, table.stdout]).toEqual([
			'{"id":1234567890123456789,"n":[12345678901234567890]}\n',
			"id  1234567890123456789\n",
		])
	})
})

describe.skipIf(!GO)("the formats' edges: JSON a terminal can't act on, a format refused (phase c)", SLOW, () => {
	it("prints DEL and the C1 controls as JSON escapes, so no raw one reaches a terminal, the value the same", async () => {
		const value = { csi: "a\u009b2Jb", del: "x\u007fy", nel: "\u0085" }
		const ran = await call(["dump", "get", "--json"], [{ json: value, status: 200 }])
		expect([ran.stdout, JSON.parse(ran.stdout)]).toEqual([
			'{"csi":"a\\u009b2Jb","del":"x\\u007fy","nel":"\\u0085"}\n',
			value,
		])
	})

	// v0: f41df25070
	it.each([
		[["--format", "xml"], '--format "xml": want json, ndjson, yaml or table'],
		[["--json", "--format", "yaml"], "--json and --format yaml disagree"],
	])("refuses %j with exit 4", async (flags, message) => {
		const ran = await call(["health", ...flags], [])
		expect([ran.status, JSON.parse(ran.stderr)]).toEqual([4, { error: { kind: "usage", message } }])
	})
})

describe.skipIf(!GO)("a terminal, -i, --raw and -o (phase c)", SLOW, () => {
	it("prints a table on a terminal, and --json there as on a pipe", async () => {
		const answer: Reply = { json: [{ id: "a", name: "n" }], status: 200 }
		const [table, json] = [
			await call(["items", "list", "-q"], [answer], { tty: true }),
			await call(["items", "list", "--json", "-q"], [answer], { tty: true }),
		]
		expect([table.stdout, json.stdout]).toEqual(["ID  NAME\na   n\n", '[{"id":"a","name":"n"}]\n'])
	})

	it("wraps the answer with -i: its status, the declared headers only, and the data", async () => {
		const reply: Reply = {
			headers: { "x-item-version": "3", "x-other": "o" },
			json: { id: "i", name: "n" },
			status: 200,
		}
		const [included, empty] = [
			await call(["items", "get", "i", "-i"], [reply]),
			await call(["items", "delete", "i", "-i"], [{ status: 204 }]),
		]
		expect([JSON.parse(included.stdout), JSON.parse(empty.stdout)]).toEqual([
			{ data: { id: "i", name: "n" }, headers: { "x-item-version": "3" }, status: 200 },
			{ data: null, headers: {}, status: 204 },
		])
	})

	it("prints the response as it came with --raw: its status, every header, the body's text", async () => {
		const ran = await call(
			["items", "get", "r1", "--raw"],
			[{ headers: { "x-item-version": "3" }, json: { id: "r1", name: "n" }, status: 200 }],
		)
		const raw = JSON.parse(ran.stdout) as { body: string; headers: Record<string, string>; status: number }
		expect([raw.status, raw.body, raw.headers["x-item-version"], raw.headers["content-type"]]).toEqual([
			200,
			'{"id":"r1","name":"n"}',
			"3",
			"application/json",
		])
	})

	it("writes the answer to the file -o names, and nothing to stdout", async () => {
		const file = join(mkdtempSync(join(goCacheDir("cli-out"), "out-")), "items.yaml")
		const ran = await call(["health", "--format", "yaml", "-o", file], [{ json: { ok: true }, status: 200 }])
		expect([ran.status, ran.stdout, readFileSync(file, "utf8")]).toEqual([0, "", "ok: true\n"])
	})
})

describe.skipIf(!GO)("an error on stderr (phase c)", SLOW, () => {
	it("reports an API error, a timeout and a refused connection as one JSON line each, by kind", async () => {
		const notFound = await call(
			["items", "get", "x"],
			[{ json: { error_key: "item_not_found", message: "no such item" }, status: 404 }],
		)
		const slow = await call(["items", "get", "x", "--timeout", "100ms"], [{ delayMs: 1500, json: {}, status: 200 }])
		const refused = await built().cli(["items", "get", "x"], { env: { SHOP_BASE_URL: REFUSED_URL } })
		const kinds = [slow, refused].map((ran) => [
			ran.status,
			(JSON.parse(ran.stderr) as { error: { kind: string } }).error.kind,
		])
		expect([[notFound.status, JSON.parse(notFound.stderr)], ...kinds]).toEqual([
			[1, { error: { errorKey: "item_not_found", kind: "api", message: "no such item", status: 404 } }],
			[3, "timeout"],
			[3, "transport"],
		])
	})

	// v0: 96c6447b4a
	it("reports an error after the CLI's name in any other format, its controls escaped", async () => {
		/* the SDK drops an API message's controls itself; a local error (a path as given) reaches the CLI raw */
		const [api, local] = [
			await call(["items", "get", "x", "--format", "table"], [{ json: { message: "bad \u001b[2J" }, status: 500 }]),
			await call(["items", "create", "--data", "@/missing\u001b[2J", "--format", "table"], []),
		]
		expect([api.status, api.stderr, local.status, local.stderr, api.stdout + local.stdout]).toEqual([
			2,
			"shop: 500 Internal Server Error: bad [2J\n",
			4,
			"shop: --data: open /missing\\x1b[2J: no such file or directory\n",
			"",
		])
	})
})
