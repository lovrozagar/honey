/**
 * The Python SDK's event-stream open, bounded (bit 19 b2), on AsyncSDK (the one client with streams): the call's timeout bounds a stream up to
 * its response headers, so a server that accepts and holds them fails the call at the timeout, as APITimeoutError; once
 * the headers arrive the body is unbounded, so a silence mid-stream longer than the timeout is never cut.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

const PY = withPython()
const SLOW = { timeout: 600_000 }
/* streams are AsyncSDK's alone: the sync client has no event-stream method */
const CLIENTS = ["async"] as const
const text = (extra: Partial<Call>): Call => ({
	operation: "text.stream",
	route: { method: "GET", path: "/text" },
	...extra,
})

/** An event stream whose headers wait `delayMs`, then two events with a `gapMs` silence between them. */
const late = (delayMs: number, gapMs = 0): Reply => ({
	delayMs,
	sse: { end: "close", steps: ["data: 1\n\n", { waitMs: gapMs }, "data: 2\n\n"] },
	status: 200,
})
const events = (...texts: readonly string[]) => ({ events: texts.map((data) => ({ data })), kind: "events" })

async function drive(client: (typeof CLIENTS)[number], replies: readonly Reply[], calls: readonly Call[]) {
	const sdk = drivenPythonSdk("sse")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return served(replies, async (server) => ({
		run: await sdk.runCalls({ calls }, { url: server.url }, { client, script: {} }),
	}))
}

describe.skipIf(!PY)(
	"the Python SDK's event-stream open is bounded by the call's timeout, its body never (bit 19 b2)",
	SLOW,
	() => {
		it.each(CLIENTS)(
			"%s: fails a stream whose headers come 3 s late at its 300 ms timeout, as APITimeoutError",
			async (client) => {
				const { run } = await drive(client, [late(3000)], [text({ take: 2, timeoutMs: 300 })])
				expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
					error: expect.objectContaining({ type: "APITimeoutError" }),
					observed: [{ kind: "timeout" }],
				})
			},
		)

		it.each(CLIENTS)(
			"%s: keeps a stream that opened in time through an 800 ms silence past its 300 ms timeout",
			async (client) => {
				const { run } = await drive(client, [late(0, 800)], [text({ take: 2, timeoutMs: 300 })])
				expect(run.observed, run.stderr).toEqual([events("1", "2")])
			},
		)
	},
)
