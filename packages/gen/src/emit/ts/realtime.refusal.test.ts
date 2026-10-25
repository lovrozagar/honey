/**
 * A resumable connection's deterministic refusal is terminal (bit 19 e, carry-in #6), as Go's is: when every transport
 * fails with a `status` of 400, 401, 403, 404, 405, 410 or 422, the open ends with the most specific (401, 403, 422,
 * 400, 410, then 404 and 405; a tie the first transport's). One refused transport still falls through, and one transient
 * failure (408, 429, 5xx, no status) among them backs off and retries. The client's one refresh per open reaches the
 * SDK-built connection in bit 19 e2; the bare one keeps no refresh hook (b2).
 */
import { describe, expect, it } from "vitest"
import { emittedSdk } from "./__fixtures__/emitted.ts"

type Frame = { data: unknown; id: number; t: "msg" } | { reconnectToken: string; t: "ready" }
type Conn = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: Frame) => void
	send(data: string): void
}
type Adapter = { connect(url: string, opts: object): Conn }
type Resumable = AsyncIterable<unknown> & { close(): void; readonly state: string }
type Create = (opts: { reconnectDelayMs?: number; transports: Adapter[]; url: string }) => Resumable

const DOC = { info: { title: "T", version: "1" }, openapi: "3.1.0", paths: {} }

/** A dial's script: a refusal's status, an error without one, or a stream of messages that then drops. */
type Step = number | "network" | { drop?: number; msgs: number[] }

const TRANSPORTS = ["ws", "sse", "longpoll"] as const

/** Three transports, each dial taking the next step of its own script; every dial logged by its transport. */
function transports(scripts: Record<(typeof TRANSPORTS)[number], Step[]>) {
	const dials: string[] = []
	const adapters = TRANSPORTS.map((name): Adapter => {
		const steps = [...scripts[name]]
		return {
			connect() {
				dials.push(name)
				const step = steps.shift() ?? "network"
				const conn: Conn = { close: () => {}, onClose: () => {}, onError: () => {}, onFrame: () => {}, send: () => {} }
				queueMicrotask(async () => {
					if (step === "network") return conn.onError(new Error("network"))
					if (typeof step === "number")
						return conn.onError(Object.assign(new Error(`refused ${step}`), { status: step }))
					conn.onFrame({ reconnectToken: `rt-${dials.length}`, t: "ready" })
					/* the open settles before the stream moves on */
					await new Promise((resolve) => setTimeout(resolve, 0))
					for (const n of step.msgs) {
						await Promise.resolve()
						conn.onFrame({ data: n, id: n, t: "msg" })
					}
					await Promise.resolve()
					if (step.drop) conn.onError(Object.assign(new Error(`refused ${step.drop}`), { status: step.drop }))
					else conn.onClose("network")
				})
				return conn
			},
		}
	})
	return { adapters, dials }
}

/** Up to `count` values off a connection over `scripts`, then how it ended: its error's status, or still open. */
async function run(scripts: Parameters<typeof transports>[0], count = 1) {
	const create = (await emittedSdk(DOC)).createResumableConnection as Create
	const { adapters, dials } = transports(scripts)
	const connection = create({ reconnectDelayMs: 1, transports: adapters, url: "https://rt.example/feed" })
	const values: unknown[] = []
	let ended: unknown = "open"
	try {
		for await (const value of connection) {
			values.push(value)
			if (values.length === count) break
		}
	} catch (err) {
		ended = (err as { status?: number }).status
	}
	const state = connection.state
	connection.close()
	return { dials, ended, state, values }
}

describe("a resumable connection's refusal is terminal, a transient failure is not (bit 19 e)", () => {
	it.each([400, 401, 403, 404, 405, 410, 422])(
		"ends when every transport refuses with a %i, with that error",
		async (status) => {
			expect(await run({ longpoll: [status], sse: [status], ws: [status] })).toEqual({
				dials: ["ws", "sse", "longpoll"],
				ended: status,
				state: "closed",
				values: [],
			})
		},
	)

	it("falls through a refused transport, a 429, a 408, a 503 and an error without a status, backing off", async () => {
		const scripts = { longpoll: [{ msgs: [2] }], sse: [{ msgs: [1] }, 408], ws: [404, 429] }
		expect(await run(scripts, 2)).toEqual({
			dials: ["ws", "sse", "ws", "sse", "longpoll"],
			ended: "open",
			state: "connected",
			values: [1, 2],
		})
		expect(await run({ longpoll: [], sse: [{ msgs: [1] }], ws: ["network"] })).toMatchObject({ values: [1] })
	})

	it("retries a reconnect a 503 or a 429 failed among refusals; ends the one every transport refused", async () => {
		const scripts = { longpoll: [404, 404, 410], sse: [{ msgs: [1] }, 404, 429, 403], ws: [503, 503, 404, 404] }
		const chain = ["ws", "sse", "longpoll"]
		expect(await run(scripts, 2)).toEqual({
			dials: ["ws", "sse", ...chain, ...chain, ...chain],
			ended: 403,
			state: "closed",
			values: [1],
		})
	})
})

/** How a connection over transports refusing `ws`, `sse` and `longpoll` ended. */
const ended = async (ws: number, sse: number, longpoll: number) =>
	(await run({ longpoll: [longpoll], sse: [sse], ws: [ws] })).ended

describe("a resumable connection's most specific refusal (bit 19 e)", () => {
	it("ends with the most specific refusal, a tie the first transport's", async () => {
		expect({
			auth: await ended(404, 401, 404),
			forbidden: await ended(404, 410, 403),
			missing: await ended(404, 404, 404),
			order: [await ended(400, 422, 410), await ended(410, 400, 404)],
			tie: await ended(405, 404, 405),
		}).toEqual({ auth: 401, forbidden: 403, missing: 404, order: [422, 400], tie: 405 })
	})

	it("ends at a drop by a refusal, dialing nothing more", async () => {
		expect(await run({ longpoll: [], sse: [{ msgs: [1], drop: 403 }], ws: [503] }, 2)).toEqual({
			dials: ["ws", "sse"],
			ended: 403,
			state: "closed",
			values: [1],
		})
	})
})
