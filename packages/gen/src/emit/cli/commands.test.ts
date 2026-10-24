/**
 * One command per operation (bit 17 phase b): the tree from the dotted ids (verbs as authored, the built-ins and a
 * group claiming first, a clash suffixed as the IR suffixes ids), each command wired and reachable, and each calling
 * the embedded SDK: the wire it sends for path, query, header and body flags, what it prints, and the usage errors it
 * refuses before anything is sent.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { sdkModel } from "../../ir/sdk-model.ts"
import { goCallPlans } from "../go/sdk.ts"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { adversarialCorpus } from "../shared/__fixtures__/adversarial-corpus.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { shop } from "./__fixtures__/shop.ts"
import { type CommandNode, commandTree } from "./commands.ts"
import { generateGoCli } from "./module.ts"

type Json = Record<string, unknown>

/** Whether Go is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const GO = withGo()
const SLOW = { timeout: 600_000 }

/** Each command's path under the root, to the operation it calls. */
function paths(document: Json): Record<string, string> {
	const out: Record<string, string> = {}
	const walk = (nodes: readonly CommandNode[], at: readonly string[]) => {
		for (const node of nodes) {
			if (node.op !== undefined) out[[...at, node.name].join(" ")] = node.op.op.id
			walk(node.children, [...at, node.name])
		}
	}
	walk(
		commandTree(sdkModel(toIR(document as OpenApiDocument, { deriveOperationIds: true })).ops, goCallPlans(document)),
		[],
	)
	return out
}

/** A document of flat GET operations by id, each answering a string. */
const flat = (...ids: string[]): Json => ({
	info: { title: "Flat", version: "1" },
	openapi: "3.1.0",
	paths: Object.fromEntries(
		ids.map((id, i) => [
			`/p${i}`,
			{
				get: {
					operationId: id,
					responses: { 200: { content: { "application/json": { schema: { type: "string" } } }, description: "ok" } },
				},
			},
		]),
	),
})

describe("the command tree (phase b)", () => {
	it("gives each operation a command by its dotted id, verbs as authored, multipart and streams too", () => {
		expect(paths(shop())).toEqual({
			"bulk send": "bulk.send",
			"chat connect": "chat.connect",
			"dump get": "dump.get",
			"events stream": "events.stream",
			"feed live": "feed.live",
			"files get": "files.get",
			"files put": "files.put",
			"forms submit": "forms.submit",
			health: "health",
			"help2 show": "help.show",
			"items create": "items.create",
			"items delete": "items.delete",
			"items get": "items.get",
			"items list": "items.list",
			"items search": "items.search",
			"items tags get": "items.tags.get",
			"notes create": "notes.create",
			"pets put": "pets.put",
			"raw send": "raw.send",
			"ticks stream": "ticks.stream",
			"uploads create": "uploads.create",
			version2: "version",
		})
	})

	it("suffixes an id taking a built-in's name, and a command spelled like a group, as the IR suffixes ids", () => {
		expect(
			paths(flat("commands", "completion", "config", "help", "schema", "skill", "version", "Items", "items.get")),
		).toEqual({
			commands2: "commands",
			completion2: "completion",
			config2: "config",
			help2: "help",
			"items get": "items.get",
			items2: "Items",
			schema2: "schema",
			skill2: "skill",
			version2: "version",
		})
	})

	it("spells a segment in kebab case: a flat id at the root, a camelCase verb split", () => {
		expect(paths(flat("getRoot", "items.listAll", "Users.byID"))).toEqual({
			"get-root": "getRoot",
			"items list-all": "items.listAll",
			"users by-id": "Users.byID",
		})
	})
})

/** The shop CLI, built once. */
const built = () => builtCli(generateGoCli(shop()).files)

/** One run of the shop CLI against a recording server answering `replies`: its outcome and what the server saw. */
async function call(args: readonly string[], replies: readonly Reply[], options: { env?: Json; input?: string } = {}) {
	const { cli } = built()
	return served(replies, async (server) => {
		const ran = await cli(args, { env: { SHOP_BASE_URL: server.url, ...options.env }, input: options.input })
		return { ...ran, bodies: server.bodies.map((body) => body.toString()), hops: server.hops }
	})
}

const OK = (json: unknown, status = 200): Reply => ({ json: json as Reply["json"], status })

/** A usage error as a piped run reports it: one JSON line on stderr (phase c). */
const usage = (message: string) => `${JSON.stringify({ error: { kind: "usage", message } })}\n`

describe.skipIf(!GO)("the shop CLI's commands, built (phase b)", SLOW, () => {
	it("reaches every command by its path", async () => {
		const { cli } = built()
		const helps = await Promise.all(Object.keys(paths(shop())).map((path) => cli([...path.split(" "), "--help"])))
		expect(helps.filter((help) => help.status !== 0 || !help.stdout.includes("Usage:")).length).toBe(0)
	})

	it("sends each flag kind to its query parameter and the header flag as the header, and prints the answer as one JSON line", async () => {
		const flags = [
			"--limit",
			"3",
			"--ratio",
			"0.5",
			"--flag",
			"--kind",
			"cat",
			"--tags",
			"x",
			"--tags",
			"y z",
			"--timeout2",
			"t",
		]
		const ran = await call(["items", "list", ...flags, "--x-trace", "tr"], [OK([{ id: "a", name: "<a&b>" }])])
		expect({
			out: [ran.status, ran.stdout, ran.stderr],
			trace: ran.hops[0]?.headers["x-trace"],
			url: ran.hops[0]?.url,
		}).toEqual({
			out: [0, '[{"id":"a","name":"<a&b>"}]\n', ""],
			trace: "tr",
			url: "/items?flag=true&kind=cat&limit=3&ratio=0.5&tags=x&tags=y+z&timeout=t",
		})
	})

	it("suffixes a parameter named like a global flag, the global flag kept: --redirect2 to the query", async () => {
		const ran = await call(["dump", "get", "--redirect2", "r", "--redirect", "follow"], [OK({ a: 1 })])
		expect([ran.status, ran.hops[0]?.url, ran.stdout]).toEqual([0, "/dump?redirect=r", '{"a":1}\n'])
	})

	it("takes path parameters positionally or by flag, escaped as the SDK escapes them", async () => {
		const [positional, flagged, mixed] = [
			await call(["items", "get", "a b/ü"], [OK({ id: "a", name: "n" })]),
			await call(["items", "get", "--id", "i1"], [OK({ id: "i1", name: "n" })]),
			await call(["items", "tags", "get", "--tag-id", "t1", "i2"], [OK("tag")]),
		]
		expect([positional, flagged, mixed].map((ran) => [ran.status, ran.hops[0]?.url, ran.stdout])).toEqual([
			[0, "/items/a%20b%2F%C3%BC", '{"id":"a","name":"n"}\n'],
			[0, "/items/i1", '{"id":"i1","name":"n"}\n'],
			[0, "/items/i2/tags/t1", '"tag"\n'],
		])
	})
})

describe.skipIf(!GO)("the shop CLI's usage errors, built (phase b)", SLOW, () => {
	it.each([
		[["items", "get"], "shop items get takes 1 argument(s) <id>, got 0"],
		[["items", "get", "a", "b"], "shop items get takes 1 argument(s) <id>, got 2"],
		[["items", "search"], "shop items search needs --q"],
		[["items", "list", "--limit", "x"], 'invalid argument "x" for "--limit" flag: not an integer'],
		[["items", "list", "--ratio", "NaN"], 'invalid argument "NaN" for "--ratio" flag: not a number'],
		[["items", "list", "--flag=maybe"], 'invalid argument "maybe" for "--flag" flag: not a boolean'],
		[["items", "list", "--kind", "fish"], 'invalid argument "fish" for "--kind" flag: must be one of cat, dog'],
		[["items", "create"], "shop items create needs a body: --data, or the body's own flags"],
		[["items", "create", "--size", "xl"], 'invalid argument "xl" for "--size" flag: must be one of s, m'],
		[["items", "create", "--data", "{"], "--data: unexpected end of JSON input"],
		[
			["items", "create", "--data", "@/nonexistent/body.json"],
			"--data: open /nonexistent/body.json: no such file or directory",
		],
		[["forms", "submit", "--b", "two"], 'invalid argument "two" for "--b" flag: not an integer'],
	])("refuses %j with exit 4 before anything is sent", async (args, message) => {
		const ran = await call(args, [])
		expect([ran.status, ran.stderr, ran.hops.length]).toEqual([4, usage(message), 0])
	})
})

describe.skipIf(!GO)("the shop CLI's bodies and answers, built (phase b)", SLOW, () => {
	it("sends the JSON body from --data, each body flag over its key", async () => {
		const [data, fields] = [
			await call(
				["items", "create", "--data", '{"name":"a","meta":{"k":[1]}}', "--n", "2"],
				[OK({ id: "1", name: "a" }, 201)],
			),
			await call(["items", "create", "--name", "b", "--size", "m"], [OK({ id: "2", name: "b" }, 201)]),
		]
		expect([data, fields].map((ran) => [ran.status, ran.hops[0]?.body.contentType, ran.hops[0]?.body.json])).toEqual([
			[0, "application/json", { meta: { k: [1] }, n: 2, name: "a" }],
			[0, "application/json", { name: "b", size: "m" }],
		])
	})

	it("decodes --data into a pointer, a raw JSON value and a slice of the SDK's types, sending each as given", async () => {
		const sent = [
			await call(["pets", "put", "--data", '{"name":"rex"}'], [{ status: 204 }]),
			await call(["raw", "send", "--data", '[1,"x",{"y":null}]'], [{ status: 204 }]),
			await call(["bulk", "send", "--data", '[{"name":"a"},{"name":"b"}]'], [{ status: 204 }]),
		]
		expect(sent.map((ran) => [ran.status, ran.hops[0]?.body.json])).toEqual([
			[0, { name: "rex" }],
			[0, [1, "x", { y: null }]],
			[0, [{ name: "a" }, { name: "b" }]],
		])
	})

	it("reads --data from a file with @ and from standard input with -", async () => {
		const file = join(mkdtempSync(join(goCacheDir("cli-data"), "data-")), "body.json")
		writeFileSync(file, '{"name":"file"}')
		const [fromFile, fromStdin] = [
			await call(["items", "create", "--data", `@${file}`], [OK({ id: "1", name: "file" }, 201)]),
			await call(["items", "create", "--data", "-"], [OK({ id: "2", name: "stdin" }, 201)], {
				input: '{"name":"stdin"}',
			}),
		]
		expect([fromFile.hops[0]?.body.json, fromStdin.hops[0]?.body.json]).toEqual([{ name: "file" }, { name: "stdin" }])
	})

	it("sends text, form and binary bodies under their media types, and prints text and bytes as they came", async () => {
		const [text, form, put, get] = [
			await call(["notes", "create", "--data", "hello"], [{ status: 200, text: "noted" }]),
			await call(["forms", "submit", "--a", "x y", "--b", "2"], [{ status: 204 }]),
			await call(["files", "put", "f.bin", "--data", "-"], [{ status: 204 }], { input: "\u0000\u0001bytes" }),
			await call(["files", "get", "f.bin"], [{ bytes: 4, status: 200 }]),
		]
		expect({
			form: [form.status, form.bodies[0], form.hops[0]?.body.contentType, form.stdout],
			get: [get.status, get.stdout.length],
			put: [put.status, put.bodies[0], put.hops[0]?.body.contentType],
			text: [text.status, text.bodies[0], text.hops[0]?.body.contentType, text.stdout],
		}).toEqual({
			form: [0, "a=x+y&b=2", "application/x-www-form-urlencoded", ""],
			get: [0, 4],
			put: [0, "\u0000\u0001bytes", "application/octet-stream"],
			text: [0, "hello", "text/plain", "noted"],
		})
	})
})

describe.skipIf(!GO)("the shop CLI's empty answers and flat ids, built (phase b)", SLOW, () => {
	it("prints nothing for an empty answer, and calls a flat id at the root", async () => {
		const [deleted, health] = [
			await call(["items", "delete", "i1"], [{ status: 204 }]),
			await call(["health"], [OK({ ok: true })]),
		]
		expect([
			[deleted.status, deleted.hops[0]?.method, deleted.stdout],
			[health.status, health.hops[0]?.url, health.stdout],
		]).toEqual([
			[0, "DELETE", ""],
			[0, "/health", '{"ok":true}\n'],
		])
	})
})

describe.skipIf(!GO)("spec text in the commands, adversarial (F2, phase b)", SLOW, () => {
	it("builds and vets the corpus's CLI, and prints its hostile description verbatim, but no control character", async () => {
		const sdk = builtCli(generateGoCli(adversarialCorpus() as Json).files)
		const help = await sdk.cli(["locals", "all", "--help"])
		expect(
			{
				built: sdk.built,
				controls: [...help.stdout].some((ch) => {
					const cp = ch.codePointAt(0) as number
					return (cp < 0x20 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f) || cp === 0xfeff
				}),
				help: [help.status, ...help.stdout.split("\n").slice(0, 2)],
				vet: sdk.vet,
			},
			sdk.stderr,
		).toEqual({
			built: true,
			controls: false,
			help: [0, "First line.", 'Second with */ and """ and `tick` and C:\\temp and a trailing quote"'],
			vet: [],
		})
	})
})
