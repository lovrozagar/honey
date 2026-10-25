/**
 * A realtime feed under --verbose (bit 19 e, carry-in #5): the Go SDK's realtime SSE and long-poll dials run the
 * OnRequest and OnResponse hooks, so --verbose logs each dial and reconnect, and the resume cursor a dial carries, the
 * `reconnect_token` and `last_event_id` query values and the Last-Event-ID header, is redacted like every other
 * credential: a reconnect token resumes another's feed. The WebSocket dial runs no hook (uniform across the SDKs).
 */
import { beforeAll, describe, expect, it } from "vitest"
import { withGo } from "../go/__fixtures__/go-env.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { shop } from "./__fixtures__/shop.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }
const HOLD = { timeout: 30_000 }

const built = () => builtCli(generateGoCli(shop()).files)

const unavailable: Reply = { status: 503, text: "" }
/** An event stream sending event `n` (its id and reconnect token the cursor), then dropping or holding. */
const stream = (n: number, end: "drop" | "hold"): Reply => ({
	sse: { end, steps: [`id: e${n}\ndata: {"id":"e${n}","n":${n},"reconnect_token":"t${n}"}\n\n`] },
	status: 200,
})

describe.skipIf(!GO)(
	"a realtime feed under --verbose logs each dial, its resume cursor redacted (bit 19 e)",
	SLOW,
	() => {
		beforeAll(() => void built(), SLOW.timeout)

		it(
			"logs the event-stream dial and its reconnect, the reconnect token and last event id never raw",
			HOLD,
			async () => {
				const replies = [unavailable, stream(1, "drop"), unavailable, stream(2, "hold")]
				const ran = await served(replies, (server) =>
					built().cli(["feed", "live", "--take", "2", "--verbose"], { env: { SHOP_BASE_URL: server.url } }),
				)
				const logged = ran.stderr.split("\n").filter((line) => line.startsWith("> ") || line.startsWith("< "))
				const dials = logged.filter((line) => line.startsWith("> GET ") && line.includes("/feed"))
				expect({
					dials: dials.map((line) => line.replace(/http:\/\/[^/]+/, "")),
					leaked: logged.filter((line) => /\bt1\b|\be1\b/.test(line)),
					lastEventId: logged.filter((line) => line.startsWith("> last-event-id:")),
					status: ran.status,
				}).toEqual({
					dials: ["> GET /feed", "> GET /feed?reconnect_token=[redacted]"],
					lastEventId: ["> last-event-id: [redacted]"],
					leaked: [],
					status: 0,
				})
			},
		)
	},
)
