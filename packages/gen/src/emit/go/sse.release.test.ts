/**
 * How the Go SDK lets an SSE body go in a consumer's own program, under a ctx nothing cancels: the driver's legs
 * (sse.test.ts, sdk.driver.stream.test.ts) cancel each call's ctx as the call ends, and net/http then closes the
 * connection whatever the runtime did, so only a consumer shows the runtime's own close. Each program opens the
 * text stream next: its answer waits until stream 0's client left (gone.ts), so the program still runs when the
 * close is seen, and a body let go only at its exit fails.
 */
import { describe, expect, it } from "vitest"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const goDescribe = describe.skipIf(!withGo())

const MODULE = "example.com/release"
const events = (schema: Record<string, unknown>) => ({
	200: { content: { "text/event-stream": { schema } }, description: "ok" },
})
/** A typed and a string SSE op. */
const DOC = {
	components: { schemas: { Tick: { properties: { n: { type: "integer" } }, required: ["n"], type: "object" } } },
	info: { title: "Release", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/text": { get: { operationId: "text.stream", responses: events({ type: "string" }) } },
		"/ticks": { get: { operationId: "ticks.stream", responses: events({ $ref: "#/components/schemas/Tick" }) } },
	},
}

const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "hold"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const tick = (n: number) => `data: {"n":${n}}\n\n`

/** The program's next request: the text stream read to its first event, under a ctx nothing cancels. */
const NEXT = `	live := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	for ev, err := range live.Text.Stream(ctx, nil) {
		note(ev.Data, err)
		break
	}`

/** The consumer `body` then NEXT, against `first` then the held text stream: its build, notes, and the verdict. */
async function released(body: string, first: Reply, imports: readonly string[] = []) {
	const next = gone(sse(["data: z\n\n"], "close"))
	const files = generateGoSdk(DOC, { modulePath: MODULE }).files
	const ran = await served([first, next.reply], (server) =>
		consume(files, MODULE, { base: server.url, body: `${body}\n${NEXT}`, imports }),
	)
	return { run: { built: ran.built, out: ran.out?.main, released: next.released(), vet: ran.vet }, stderr: ran.stderr }
}

goDescribe("an SSE body a consumer lets go, no ctx canceled: the runtime's own close", () => {
	it("closes the body when the range breaks after two events, before the program goes on", async () => {
		const TAKE = `	ticks := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	read := 0
	for ev, err := range ticks.Ticks.Stream(ctx, nil) {
		note(ev.Data.N, err)
		if read++; read == 2 {
			break
		}
	}`
		const held = sse([tick(1), { waitMs: 50 }, tick(2), { waitMs: 50 }, tick(3)], "hold")
		const { run, stderr } = await released(TAKE, held)
		expect(run, stderr).toEqual({ built: true, out: ["1 <nil>", "2 <nil>", "z <nil>"], released: true, vet: [] })
	}, 600_000)

	it("closes the body unread when an OnResponse hook fails the open, before the program goes on", async () => {
		const HOOKED = `	bad := func(*sdk.ResponseContext) error { return errors.New("bad") }
	hooked := sdk.NewClient(sdk.Config{BaseURL: input.Base, OnResponse: []func(*sdk.ResponseContext) error{bad}})
	for _, err := range hooked.Ticks.Stream(ctx, nil) {
		note(err)
	}`
		const { run, stderr } = await released(HOOKED, sse([tick(1)], "hold"), ["errors"])
		expect(run, stderr).toEqual({
			built: true,
			out: ["honey: OnResponse hook: bad", "z <nil>"],
			released: true,
			vet: [],
		})
	}, 600_000)
})
