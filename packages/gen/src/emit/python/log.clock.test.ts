/**
 * The Python SDK's request_start clock (bit 19 d2, sweep item 18): a call's clock starts at request_start, so that
 * entry logs duration_ms 0, as the TS, Go, C# and Java SDKs log it; before, the clock started when the call's log was
 * built, and whatever ran between (the body's encoding, the header layers) was counted, in request_start and every
 * later entry. A clock the program sets, 25 ms a reading and only in the log module, a second added as the log is
 * made, stands for that gap, so the leg needs no load to read it.
 */
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"

const PY = withPython()
const SLOW = { timeout: 600_000 }

const BODY = `    import importlib
    import types

    log = importlib.import_module(sdk.__name__ + "._honey.log")
    ticks = [0.0]

    def tick() -> float:
        ticks[0] += 0.025
        return ticks[0]

    log.time = types.SimpleNamespace(monotonic=tick)
    made = log.CallLog.__init__

    def making(self: object, *args: object) -> None:
        made(self, *args)
        ticks[0] += 1.0  # a second passes between the log made and the request started

    log.CallLog.__init__ = making
    entries: list[object] = []
    with client(on_log=entries.append) as c:
        c.echo.get()
    async with aclient(on_log=entries.append) as a:
        await a.echo.get()
    note([[e.event, e.duration_ms] for e in entries])`

describe.skipIf(!PY)("the Python SDK's request_start clock (bit 19 d2)", SLOW, () => {
	it("logs request_start at duration_ms 0 and times the answer from it, on both clients, whatever ran since the call's log was built", async () => {
		const run = await served(
			[
				{ json: {}, status: 200 },
				{ json: {}, status: 200 },
			],
			(server) => consume("http", "clock", { base: server.url, body: BODY }),
		)
		/* the clock's start and the answer are one reading apart, 25 ms; timed from the log's making, 1,050 */
		const call = [
			["request_start", 0],
			["response_received", 25],
		]
		expect({ out: run.out?.main, ran: run.ran }, run.stderr).toEqual({
			out: [JSON.stringify([...call, ...call]).replaceAll(",", ", ")],
			ran: true,
		})
	})
})
