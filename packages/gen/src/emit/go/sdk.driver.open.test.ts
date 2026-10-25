/**
 * The Go SDK's event-stream open, bounded (bit 19 b2): the call's timeout bounds a stream up to its response headers,
 * so a server that accepts and holds them fails the call at the timeout, as a deadline; once the headers arrive the
 * body is unbounded, so a silence mid-stream longer than the timeout is never cut.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"

const GO = withGo()

/** One untyped event stream. */
const DOCUMENT = {
	info: { title: "Opens", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/text": {
			get: {
				operationId: "text.stream",
				responses: { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } },
			},
		},
	},
}
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

let compiled: DrivenSdk | undefined
function opensSdk(): DrivenSdk {
	compiled ??= compiledSdk(DOCUMENT, { modulePath: "example.com/opens" })
	expect({ built: compiled.built, vet: compiled.vet }, compiled.stderr).toEqual({ built: true, vet: [] })
	return compiled
}

async function drive(replies: readonly Reply[], calls: readonly Call[]) {
	const sdk = opensSdk()
	return served(replies, async (server) => ({ run: await sdk.runCalls({ calls }, server, {}) }))
}

describe.skipIf(!GO)(
	"the Go SDK's event-stream open is bounded by the call's timeout, its body never (bit 19 b2)",
	() => {
		it("fails a stream whose headers come 3 s late at its 300 ms timeout, as a deadline", async () => {
			const { run } = await drive([late(3000)], [text({ take: 2, timeoutMs: 300 })])
			expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
				error: expect.objectContaining({ deadline: true }),
				observed: [{ kind: "timeout" }],
			})
		}, 600_000)

		it("keeps a stream that opened in time through an 800 ms silence past its 300 ms timeout", async () => {
			const { run } = await drive([late(0, 800)], [text({ take: 2, timeoutMs: 300 })])
			expect(run.observed, run.stderr).toEqual([events("1", "2")])
		}, 600_000)
	},
)
