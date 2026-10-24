/**
 * Server-sent events through the CLI (bit 17 phase d): one ndjson line per event, `{event, id, data}` with an empty
 * name or id left out and the data as JSON when it is (a typed event as its type re-encodes it); --last-event-id
 * resuming; --take ending the stream after N, its body closed; a YAML document per event, ndjson for a table (one
 * warning when asked for); -o line by line; -i, --raw and --take 0 refused; an error status as the error envelope.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { SseScript } from "../shared/__fixtures__/sse-steps.ts"
import { builtCli, type RunOptions } from "./__fixtures__/built.ts"
import { shop } from "./__fixtures__/shop.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }
/* a leg the server holds open: a regression that never ends fails in this, not the file's bound; each describe
 * builds the CLI first, under SLOW, so a cold build (a module download, a link) counts against no leg's HOLD */
const HOLD = { timeout: 30_000 }

const built = () => builtCli(generateGoCli(shop()).files)

/** An event stream answering with `steps`, then ending as `end` says. */
const sse = (steps: SseScript["steps"], end: SseScript["end"] = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})

/** One run against a server answering `replies`; the run, the hops and their streams. */
async function call(args: readonly string[], replies: readonly Reply[], options: RunOptions = {}) {
	return served(replies, async (server) => {
		const ran = await built().cli(args, { ...options, env: { SHOP_BASE_URL: server.url, ...options.env } })
		return { ...ran, hops: server.hops, streams: server.streams }
	})
}

/* an event before any id has none; after one, the SDK carries the last id forward (WHATWG), the id a resume names */
const MIXED = ["data: 42\n\n", 'event: tick\nid: 1\ndata: {"n":1}\n\n', "event: done\ndata: plain text\n\n"]

describe.skipIf(!GO)("an event stream as ndjson (phase d)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	// v0: 0c5b429788
	it("prints each event as one line: its name and id when set, its data as JSON when it is, else as a string", async () => {
		const ran = await call(["events", "stream"], [sse(MIXED)])
		expect([ran.status, ran.stdout]).toEqual([
			0,
			[
				'{"data":42}',
				'{"event":"tick","id":"1","data":{"n":1}}',
				'{"event":"done","id":"1","data":"plain text"}',
				"",
			].join("\n"),
		])
	})

	it("prints a typed event as its type re-encodes it, two event types told apart by name", async () => {
		const ran = await call(
			["ticks", "stream"],
			[sse(['event: done\ndata: {"n":2}\n\n', 'event: tick\nid: 7\ndata: {"n":1,"msg":"a","extra":true}\n\n'])],
		)
		expect([
			ran.status,
			ran.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as unknown),
		]).toEqual([
			0,
			[
				{ data: { n: 2 }, event: "done" },
				{ data: { msg: "a", n: 1 }, event: "tick", id: "7" },
			],
		])
	})
})

describe.skipIf(!GO)("an event stream's resume, its end and its error (phase d)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	// v0: f58ad4199a
	it("resumes from --last-event-id, sent as the Last-Event-ID header", async () => {
		const ran = await call(["events", "stream", "--last-event-id", "41"], [sse(["id: 42\ndata: x\n\n"])])
		expect([ran.status, ran.hops[0]?.headers["last-event-id"], ran.stdout]).toEqual([
			0,
			"41",
			'{"id":"42","data":"x"}\n',
		])
	})

	it(
		"ends after --take N events with exit 0, the stream's body closed while the server still held it",
		HOLD,
		async () => {
			const ran = await call(["events", "stream", "--take", "2"], [sse(MIXED, "hold")])
			expect([ran.status, ran.stdout.split("\n").length - 1, ran.streams[0]?.clientGone]).toEqual([0, 2, true])
		},
	)

	// v0: 0ad77708fc
	it("prints the events before a stream cut mid-way, then reports it as no answer, exit 3", async () => {
		const ran = await call(["events", "stream"], [sse(["data: 1\n\n", "data: 2\n\n"], "drop")])
		expect([ran.status, ran.stdout, (JSON.parse(ran.stderr) as { error: { kind: string } }).error.kind]).toEqual([
			3,
			'{"data":1}\n{"data":2}\n',
			"transport",
		])
	})

	it("reports an error status as the error envelope, exit 1", async () => {
		const ran = await call(["events", "stream"], [{ json: { error_key: "gone", message: "no stream" }, status: 404 }])
		expect([ran.status, JSON.parse(ran.stderr)]).toEqual([
			1,
			{ error: { errorKey: "gone", kind: "api", message: "no stream", status: 404 } },
		])
	})
})

describe.skipIf(!GO)("an event stream's formats and output flags (phase d)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	// v0: f623ca0438
	it("prints a YAML document per event under --format yaml", async () => {
		const ran = await call(["events", "stream", "--format", "yaml"], [sse(MIXED.slice(1))])
		/* `n` is quoted: a YAML 1.1 reader takes it for false */
		const docs = ["---", "data:", '  "n": 1', 'event: "tick"', 'id: "1"', "---", 'data: "plain text"', 'event: "done"']
		expect(ran.stdout).toBe([...docs, 'id: "1"', ""].join("\n"))
	})

	// v0: 9b77fcc391
	it("prints ndjson for a table: one warning when --format table asked for it, none for a terminal's default", async () => {
		const [asked, terminal] = [
			await call(["events", "stream", "--format", "table"], [sse(MIXED.slice(0, 1))]),
			await call(["events", "stream", "-q"], [sse(MIXED.slice(0, 1))], { tty: true }),
		]
		expect([asked.stdout, asked.stderr, terminal.stdout, terminal.stderr]).toEqual([
			'{"data":42}\n',
			"shop: a stream prints no table: ndjson instead\n",
			'{"data":42}\n',
			"",
		])
	})

	it("writes each event to the file -o names as it arrives, and nothing to stdout", async () => {
		const file = join(mkdtempSync(join(goCacheDir("cli-stream"), "out-")), "events.ndjson")
		const ran = await call(["events", "stream", "-o", file], [sse(MIXED)])
		expect([ran.status, ran.stdout, readFileSync(file, "utf8").split("\n").length - 1]).toEqual([0, "", 3])
	})

	it.each([
		[["-i"], "-i and --raw take one answer: shop events stream streams"],
		[["--raw"], "-i and --raw take one answer: shop events stream streams"],
		[["--take", "0"], "--take 0: want 1 or more"],
	])("refuses %j on a stream with exit 4, before it is opened", async (flags, message) => {
		const ran = await call(["events", "stream", ...flags], [])
		expect([ran.status, JSON.parse(ran.stderr), ran.hops.length]).toEqual([4, { error: { kind: "usage", message } }, 0])
	})
})
