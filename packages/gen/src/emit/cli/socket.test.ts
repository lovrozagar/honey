/**
 * WebSocket and realtime commands (bit 17 phase d): each message one ndjson line (JSON when it is, a string when
 * not, `{"bytes": base64}` when not UTF-8); each stdin line sent as a text frame, reading on at its end; a close 1000
 * or 1001 exit 0, any other exit 3; --take N ending with a close frame 1000; Ctrl-C a close frame "interrupted", exit
 * 130. A realtime feed resumes from --reconnect-token and --last-event-id, and writes its cursor to stderr at every
 * end, an error's too, so a caller resumes where it stopped.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { withGo } from "../go/__fixtures__/go-env.ts"
import { type Reply, type RecordingServer, served } from "../shared/__fixtures__/recording-server.ts"
import type { WsStep } from "../shared/__fixtures__/stream-server.ts"
import { builtCli, type RunOptions } from "./__fixtures__/built.ts"
import { shop } from "./__fixtures__/shop.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }
/* a leg the server holds open: a regression that never ends fails in this, not the file's bound; each describe
 * builds the CLI first, under SLOW, so a cold build (a module download, a link) counts against no leg's HOLD */
const HOLD = { timeout: 30_000 }

const built = () => builtCli(generateGoCli(shop()).files)

/** A WebSocket answering with `steps`. */
const ws = (steps: readonly WsStep[]): Reply => ({ status: 101, ws: { steps } })

/** A realtime event `n` per entry, each carrying its id and reconnect token, the cursor the CLI reports. */
const frames = (...ns: number[]): WsStep[] => ns.map((n) => ({ json: { id: `e${n}`, n, reconnect_token: `t${n}` } }))

/** Settled once the server holds `n` hops: the latch an interrupt waits on. */
const hopped = (server: RecordingServer, n = 1) =>
	new Promise<void>((resolve) => {
		const poll = setInterval(() => server.hops.length >= n && (clearInterval(poll), resolve()), 5)
	})

/** One run against a server answering `replies`; the run, the hops and their streams. */
async function call(
	args: readonly string[],
	replies: readonly Reply[],
	options: RunOptions | ((server: RecordingServer) => RunOptions) = {},
) {
	return served(replies, async (server) => {
		const given = typeof options === "function" ? options(server) : options
		const ran = await built().cli(args, { ...given, env: { SHOP_BASE_URL: server.url, ...given.env } })
		return { ...ran, hops: server.hops, streams: server.streams }
	})
}

describe.skipIf(!GO)("a WebSocket command (phase d)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	it(
		"sends each stdin line as a text frame, reads on at its end, and prints each message as one line",
		HOLD,
		async () => {
			const steps: WsStep[] = [
				{ receive: 2 },
				{ json: { a: 1 } },
				{ text: "hi" },
				{ close: { code: 1000, reason: "bye" } },
			]
			const ran = await call(["chat", "connect"], [ws(steps)], { input: "one\ntwo\n" })
			expect([ran.status, ran.stdout, ran.streams[0]?.received.filter((r) => r.kind === "text")]).toEqual([
				0,
				'{"a":1}\n"hi"\n',
				[
					{ kind: "text", text: "one" },
					{ kind: "text", text: "two" },
				],
			])
		},
	)

	it('prints a message that is not UTF-8 as {"bytes": base64}, so no byte is lost', async () => {
		const ran = await call(["chat", "connect"], [ws([{ binary: 256 }, { close: { code: 1000, reason: "" } }])])
		const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString("base64")
		expect([ran.status, ran.stdout]).toEqual([0, `${JSON.stringify({ bytes })}\n`])
	})
})

describe.skipIf(!GO)("a WebSocket command's end: a close, --take, Ctrl-C (phase d)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	it("exits 0 on a close 1000 or 1001, and 3 on any other close, its code and reason in the error", async () => {
		const [normal, away, failed] = [
			await call(["chat", "connect"], [ws([{ close: { code: 1000, reason: "" } }])]),
			await call(["chat", "connect"], [ws([{ close: { code: 1001, reason: "restart" } }])]),
			await call(["chat", "connect"], [ws([{ close: { code: 1011, reason: "boom" } }])]),
		]
		expect([normal.status, away.status, failed.status, JSON.parse(failed.stderr)]).toEqual([
			0,
			0,
			3,
			{ error: { kind: "transport", message: "the server closed the connection: 1011 boom" } },
		])
	})

	it("ends after --take N messages with exit 0 and a close frame 1000", HOLD, async () => {
		const ran = await call(["chat", "connect", "--take", "1"], [ws([{ text: "a" }, { text: "b" }, { waitMs: 60_000 }])])
		expect([ran.status, ran.stdout, ran.streams[0]?.received.at(-1)]).toEqual([
			0,
			'"a"\n',
			{ code: 1000, kind: "close", reason: "" },
		])
	})

	it('sends a close frame 1000 "interrupted" on Ctrl-C, and exits 130', HOLD, async () => {
		const ran = await call(["chat", "connect"], [ws([{ text: "a" }, { waitMs: 60_000 }])], (server) => ({
			interrupt: hopped(server),
		}))
		expect([ran.status, ran.streams[0]?.received.at(-1), ran.streams[0]?.clientGone]).toEqual([
			130,
			{ code: 1000, kind: "close", reason: "interrupted" },
			false,
		])
	})
})

describe.skipIf(!GO)("a realtime command (phase d)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	it(
		"prints each event, writes its cursor to stderr at the end, and resumes from it on the next run",
		HOLD,
		async () => {
			const first = await call(["feed", "live", "--take", "2"], [ws([...frames(1, 2), { waitMs: 60_000 }])])
			const resume = (JSON.parse(first.stderr) as { resume: { lastEventId: string; reconnectToken: string } }).resume
			const second = await call(
				[
					"feed",
					"live",
					"--take",
					"1",
					"--reconnect-token",
					resume.reconnectToken,
					"--last-event-id",
					resume.lastEventId,
				],
				[ws([...frames(3), { waitMs: 60_000 }])],
			)
			expect({
				dialed: second.hops[0]?.url,
				first: [first.status, first.stdout, resume],
				second: [second.status, JSON.parse(second.stderr)],
			}).toEqual({
				dialed: "/feed?last_event_id=e2&reconnect_token=t2",
				first: [
					0,
					'{"id":"e1","n":1,"reconnect_token":"t1"}\n{"id":"e2","n":2,"reconnect_token":"t2"}\n',
					{ lastEventId: "e2", reconnectToken: "t2" },
				],
				second: [0, { resume: { lastEventId: "e3", reconnectToken: "t3" } }],
			})
		},
	)

	it("writes the cursor after the CLI's name in any other format, and nothing when there is none", HOLD, async () => {
		const [named, none] = [
			await call(["feed", "live", "--take", "1", "--format", "yaml"], [ws([...frames(1), { waitMs: 60_000 }])]),
			await call(["feed", "live", "--take", "1"], [ws([{ json: { n: 1 } }, { waitMs: 60_000 }])]),
		]
		expect([named.stderr, none.stderr]).toEqual(["shop: resume with --reconnect-token t1 --last-event-id e1\n", ""])
	})
})

describe.skipIf(!GO)("a realtime command ending on an error, or refused (phase d)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	/* a long-poll dial opens unsent, so a refusal surfaces at its first poll and ends the feed after the reconnects;
	 * every reply refuses, more than the dials made, so no exhausted list answers 200 */
	it(
		"writes the cursor before the error when the feed ends on one, after --max-reconnects",
		{ timeout: 20_000 },
		async () => {
			const refused: Reply = { json: { message: "no" }, status: 403 }
			const replies = Array.from({ length: 12 }, () => refused)
			const ran = await call(["feed", "live", "--max-reconnects", "1", "--reconnect-token", "t0"], replies)
			const [cursor, error] = ran.stderr.split("\n").map((line) => (line === "" ? line : (JSON.parse(line) as unknown)))
			expect([
				ran.status,
				cursor,
				(error as { error: { kind: string; status: number } }).error,
				ran.hops.length < 12,
			]).toEqual([1, { resume: { reconnectToken: "t0" } }, expect.objectContaining({ kind: "api", status: 403 }), true])
		},
	)

	/* refusals only: were 0 let through, the SDK's 5 reconnects would end on them, never on an exhausted list's 200 */
	it("refuses --max-reconnects 0 with exit 4, before it dials", HOLD, async () => {
		const refused: Reply = { json: { message: "no" }, status: 403 }
		const ran = await call(
			["feed", "live", "--max-reconnects", "0"],
			Array.from({ length: 40 }, () => refused),
		)
		expect([ran.status, JSON.parse(ran.stderr), ran.hops.length]).toEqual([
			4,
			{ error: { kind: "usage", message: "--max-reconnects 0: want 1 or more" } },
			0,
		])
	})
})
