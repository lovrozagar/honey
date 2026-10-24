/**
 * Agent command discovery (bit 17 phase e, E1), read from the built binary:
 * - `commands` is one usage line per API command after the `local:` line, sorted by path, text even when piped;
 *   `--json` gives one object per line;
 * - an index line's summary is its first sentence within 80 characters; an enum past 6 values is `<enum:N>`;
 * - every non-stream line, its required arguments filled, makes a call that is no usage error;
 * - `commands search` ranks by shared words, ties in path order, at most 5, none for no match;
 * - `schema` adds the method and path, the body, the answer or events, and each error status with its keys, and its
 *   JSON the same fields;
 * - spec text never brings a control character into any of them.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { catalog, HOSTILE } from "./__fixtures__/catalog.ts"
import { hasControl } from "./__fixtures__/controls.ts"
import { shop } from "./__fixtures__/shop.ts"
import { toIR, type OpenApiDocument } from "../../ir/build.ts"
import { sdkModel } from "../../ir/sdk-model.ts"
import { sketch, summaryOf } from "./discovery.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }

const shopCli = () => builtCli(generateGoCli(shop()).files)
const catalogCli = () => builtCli(generateGoCli(catalog()).files)

/** One run of `cli` with `args`, its base URL unset unless given. */
const run = (cli: ReturnType<typeof shopCli>, args: readonly string[]) => cli.cli(args, {})

/** The shop's index as `shop commands` prints it. */
const SHOP_INDEX = [
	"local: commands completion config schema skill",
	"bulk send --data json",
	"chat connect (ws)",
	"dump get # Any JSON, as the API sends it",
	"events stream (sse)",
	"feed live [--channel string] (realtime)",
	"files get <name>",
	"files put <name> --data binary",
	"forms submit --data form",
	"health",
	"help2 show",
	"items create --data json # Create an item",
	"items delete <id>",
	"items get <id> # Get an item",
	"items list [--flag] [--kind cat|dog] [--limit integer] [--ratio number] [--tags string...] [--timeout2 string] [--x-trace string] # List items",
	"items search --q string",
	"items tags get <id> <tag-id>",
	"notes create --data text",
	"pets put [--data json]",
	"raw send --data json",
	"ticks stream (sse) # Ticks, typed",
	"uploads create [--extras path...] [--file path] [--note string]",
	"version2",
	"",
].join("\n")

describe("an index line's summary (phase e)", () => {
	it("is its first sentence on one line, cut at 80 characters with …", () => {
		expect([
			summaryOf("List the nodes. Then more."),
			summaryOf("Two\nlines,  spaced.\tEnd"),
			summaryOf(`${"a".repeat(90)}. Short.`),
			summaryOf("No stop at all"),
			summaryOf("v1.2 is out. Next."),
		]).toEqual(["List the nodes.", "Two lines, spaced.", `${"a".repeat(79)}…`, "No stop at all", "v1.2 is out."])
	})
})

describe("a schema sketch (phase e)", () => {
	it("spells each kind: all-of, tuple with a rest, union, nullable, const, bytes, any, a map", () => {
		const model = sdkModel(toIR(catalog() as OpenApiDocument))
		const STR = { kind: "scalar", type: "string" } as const
		expect(
			[
				{
					kind: "allOf",
					parts: [
						{ kind: "ref", name: "Node" },
						{ fields: [], kind: "object" },
					],
				},
				{ items: [STR, { kind: "scalar", type: "integer" }], kind: "tuple", rest: STR },
				{ items: [STR], kind: "tuple" },
				{ items: { kind: "union", variants: [STR, { kind: "const", value: 1 }] }, kind: "array" },
				{ inner: { kind: "binary" }, kind: "nullable" },
				{ additional: { kind: "unknown" }, fields: [], kind: "object" },
				{ kind: "const", value: "a\u2028b" },
			].map((schema) => sketch(schema as Parameters<typeof sketch>[0], model)),
		).toEqual([
			"{children?: Node[], id: string} & {}",
			"[string, integer, ...string[]]",
			"[string]",
			"(string | 1)[]",
			"bytes|null",
			"{[key: string]: any}",
			'"a\\u2028b"',
		])
	})
})

describe.skipIf(!GO)("the commands index (phase e)", SLOW, () => {
	beforeAll(() => void shopCli(), SLOW.timeout)

	it("prints the local line, then one usage line per API command sorted by path, as text even when piped", async () => {
		const ran = await run(shopCli(), ["commands"])
		expect([ran.status, ran.stdout, ran.stderr]).toEqual([0, SHOP_INDEX, ""])
	})

	it("prints one JSON object per API command under --json, no local line", async () => {
		const ran = await run(shopCli(), ["commands", "--json"])
		const objects = ran.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { command: string })
		expect([ran.status, objects.map((o) => o.command), objects[13]]).toEqual([
			0,
			SHOP_INDEX.split("\n")
				.slice(1, -1)
				.map((line) => (line.split(/ [<[(#-]/)[0] as string).trim()),
			{
				command: "items list",
				flags: [
					{ name: "flag", type: "boolean" },
					{ enum: ["cat", "dog"], name: "kind", type: "string" },
					{ name: "limit", type: "integer" },
					{ name: "ratio", type: "number" },
					{ list: true, name: "tags", type: "string" },
					{ name: "timeout2", type: "string" },
					{ name: "x-trace", type: "string" },
				],
				summary: "List items",
			},
		])
	})

	it("makes, from each non-stream line with its required arguments filled, a call that is no usage error", async () => {
		const dir = mkdtempSync(join(goCacheDir("tmp"), "index-"))
		writeFileSync(join(dir, "part.bin"), "x")
		const lines = SHOP_INDEX.split("\n")
			.slice(1, -1)
			.filter((line) => !/\((sse|ws|realtime)\)/.test(line))
		const statuses = await served(
			lines.map(() => ({ json: {}, status: 200 })),
			async (server) => {
				const out: [string, number][] = []
				for (const line of lines) {
					const usage = line.split(" # ")[0] as string
					/* a JSON body's shape is the schema's: an array when its sketch is one */
					const schema = await shopCli().cli(["schema", ...(usage.split(/ [<[-]/)[0] as string).split(" ")], {})
					const args = filled(usage, join(dir, "part.bin"), /^--data .*\[\]$/m.test(schema.stdout) ? "[]" : "{}")
					const ran = await shopCli().cli(args, { env: { SHOP_BASE_URL: server.url }, input: "x" })
					out.push([line, ran.status])
				}
				return out
			},
		)
		expect(statuses.filter(([, status]) => status === 4)).toEqual([])
	})
})

/** A usage line's words as a call: each `<arg>` an `x`, each required `--flag kind` a value of its kind, optional ones left out. */
function filled(usage: string, file: string, json: string): string[] {
	const value: Record<string, string> = {
		binary: "-",
		form: "a=1",
		integer: "1",
		json,
		number: "1.5",
		path: file,
		text: "x",
	}
	const words = usage
		.replace(/\[[^\]]*\]/g, "")
		.trim()
		.split(/\s+/)
	return words.flatMap((word, i): string[] => {
		if (/^<.*>$/.test(word)) return ["x"]
		if (word.startsWith("--")) {
			const kind = words[i + 1] as string
			return [word, kind.includes("|") ? (kind.split("|")[0] as string) : (value[kind] ?? "x")]
		}
		return words[i - 1]?.startsWith("--") ? [] : [word]
	})
}

describe.skipIf(!GO)("commands search (phase e)", SLOW, () => {
	beforeAll(() => void catalogCli(), SLOW.timeout)

	it("ranks by words shared with the path and summary, a summary-only word too, ties in path order, at most 5", async () => {
		const [summary, capped, none] = [
			await run(catalogCli(), ["commands", "search", "tree"]),
			await run(catalogCli(), ["commands", "search", "get", "list"]),
			await run(catalogCli(), ["commands", "search", "nothing-here"]),
		]
		expect([summary.stdout, capped.stdout.split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")), none]).toEqual([
			"nodes get <id> # Get one node of the tree with every child below it, as far down as the tree goe…\n",
			["deep get", "hostile get", "nodes get", "nodes list", "orgs get", ""],
			expect.objectContaining({ status: 0, stdout: "" }),
		])
	})

	it("ranks a command sharing more words first, ahead of one before it in path order", async () => {
		const ran = await run(catalogCli(), ["commands", "search", "list", "nodes"])
		expect(ran.stdout.split("\n").map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
			"nodes list",
			"nodes get",
			"orgs list",
			"",
		])
	})
})

describe.skipIf(!GO)("a command's schema (phase e)", SLOW, () => {
	beforeAll(() => void catalogCli(), SLOW.timeout)

	it("adds the method and path, the body, the answer, and each error status with its keys", async () => {
		const ran = await run(catalogCli(), ["schema", "orgs", "create"])
		expect([ran.status, ran.stdout]).toEqual([
			0,
			[
				"orgs create --data json # Create an org",
				"POST /orgs",
				"--data {slug: string}",
				"returns string",
				"errors 400, 404, 409 org_slug_taken, 422 invalid_input slug_too_long",
				"",
			].join("\n"),
		])
	})

	it("lists a long enum whole (the index its count), names a recursive schema by its type, cuts objects past depth 3", async () => {
		const [index, list, node, deep] = [
			await run(catalogCli(), ["commands"]),
			await run(catalogCli(), ["schema", "nodes", "list"]),
			await run(catalogCli(), ["schema", "nodes", "get"]),
			await run(catalogCli(), ["schema", "deep", "get"]),
		]
		expect([
			index.stdout.split("\n").find((line) => line.startsWith("nodes list")),
			list.stdout.split("\n")[0],
			node.stdout.split("\n").at(-2),
			deep.stdout.split("\n").at(-2),
		]).toEqual([
			"nodes list [--color <enum:7>] [--order asc|desc] --page integer # List the nodes.",
			"nodes list [--color red|orange|yellow|green|blue|indigo|violet] [--order asc|desc] --page integer # List the nodes.",
			"returns {children?: Node[], id: string}",
			"returns {next: {next: {next: {…}}}}",
		])
	})
})

describe.skipIf(!GO)("a command's schema as JSON (phase e)", SLOW, () => {
	beforeAll(() => void catalogCli(), SLOW.timeout)

	it("gives the same fields as one JSON object under --json, and refuses an unknown command with exit 4", async () => {
		const [json, unknown] = [
			await run(catalogCli(), ["schema", "orgs", "create", "--json"]),
			await run(catalogCli(), ["schema", "orgs", "drop"]),
		]
		expect([JSON.parse(json.stdout), unknown.status, JSON.parse(unknown.stderr)]).toEqual([
			{
				body: "{slug: string}",
				command: "orgs create",
				errors: [
					{ status: 400 },
					{ status: 404 },
					{ keys: ["org_slug_taken"], status: 409 },
					{ keys: ["invalid_input", "slug_too_long"], status: 422 },
				],
				flags: [{ name: "data", required: true, type: "json" }],
				method: "POST",
				path: "/orgs",
				returns: "string",
				summary: "Create an org",
			},
			4,
			{ error: { kind: "usage", message: 'no command "orgs drop": see catalog commands' } },
		])
	})
})

describe.skipIf(!GO)("discovery's guard on spec text (phase e)", SLOW, () => {
	beforeAll(() => void catalogCli(), SLOW.timeout)

	it("keeps every control character a spec carries out of the index, search, schema and its JSON", async () => {
		const outputs = [
			await run(catalogCli(), ["commands"]),
			await run(catalogCli(), ["commands", "--json"]),
			await run(catalogCli(), ["commands", "search", "evil"]),
			await run(catalogCli(), ["schema", "hostile", "get"]),
			await run(catalogCli(), ["schema", "hostile", "get", "--json"]),
		].map((ran) => ran.stdout)
		const hostile = outputs[0]?.split("\n").filter((line) => line.startsWith("hostile get"))
		expect({
			controls: outputs.filter(hasControl),
			hostile,
			schemaLines: outputs[3]?.split("\n").length,
		}).toEqual({
			controls: [],
			hostile: [
				`hostile get [--mode ${JSON.stringify(`a${HOSTILE}b`).replace(CONTROL_ESCAPE, escaped)}|"c|d"] # Evil[2J summary.`,
			],
			schemaLines: 4,
		})
	})
})

/* the controls JSON.stringify leaves raw, as discovery escapes them */
const CONTROL_ESCAPE = /[\u007f-\u009f\u2028\u2029\ufeff]/g
const escaped = (ch: string) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
