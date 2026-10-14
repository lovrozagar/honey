import { describe, expect, it } from "vitest"
import { isHoneyResponse, NODE_OUTBOUND } from "../response/builder.ts"
import type { HoneyOutHeaders } from "../response/out-headers.ts"
import { honey } from "../routing/app.ts"
import { serverTiming, type Timing } from "./server-timing.ts"

/** The Server-Timing entries `use` produces, as [name, desc?, dur]. */
async function timings(
	use: (timing: Timing) => void | Promise<void>,
	init?: { status?: number; upstream?: string; throws?: boolean },
) {
	const app = honey<{}>()
	app
		.use(serverTiming())
		.get("/t")
		.handler(async (ctx) => {
			await use(ctx.timing)
			if (init?.throws) throw new Error("boom")
			return ctx.res.text("ok", "x", init?.upstream ? { headers: { "server-timing": init.upstream } } : undefined)
		})
	const res = await app.fetch(new Request("https://app.example.com/t"), {})
	const header = res.headers.get("server-timing") ?? ""
	const entries = header.split(/,\s*/).map((part) => {
		const [name, ...params] = part.split(";")
		const fields = Object.fromEntries(params.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]))
		return { desc: fields.desc, dur: Number(fields.dur), name }
	})
	return { entries, header, status: res.status }
}

describe("serverTiming(): the header", () => {
	// v0: c7171b394b
	// v0: 858c4b6696
	// v0: e79702b09c
	// v0: f2795477d8
	// v0: 6051c3f1be
	// v0: 8e1e5ec5a4
	it("each timing by name, a description when given, and the total last", async () => {
		const { entries } = await timings(async (timing) => {
			timing.start("db", "orders query")
			timing.end("db")
			timing.start("auth")
			timing.end("auth")
		})
		expect(entries.map(({ desc, name }) => [name, desc])).toEqual([
			["db", '"orders query"'],
			["auth", undefined],
			["total", undefined],
		])
	})

	// v0: 9e6cf30f4d
	// v0: b704bf6af7
	// v0: 25524b352c
	// v0: c61351e961
	it("an unclosed timing closes at the answer; an end with no start is ignored; durations are never negative", async () => {
		const { entries } = await timings((timing) => {
			timing.start("open")
			timing.end("never-started")
		})
		expect([entries.map((entry) => entry.name), entries.every((entry) => entry.dur >= 0)]).toEqual([
			["open", "total"],
			true,
		])
	})

	// v0: 2bf5870c12
	it("keeps a Server-Timing the handler or an upstream set, adding to it", async () => {
		const { header } = await timings(() => {}, { upstream: "cdn;dur=1.5" })
		expect(header.startsWith("cdn;dur=1.5, total;dur=")).toBe(true)
	})
})

describe("serverTiming(): the plain path", () => {
	it("on a Node-bridge answer, the timing joins the handler's value on the plain header map", async () => {
		const app = honey<{}>()
		app
			.use(serverTiming())
			.get("/t")
			.handler((ctx) => ctx.res.text("ok", "x", { headers: { "server-timing": "cdn;dur=1.5" } }))
		const request = new Request("https://app.example.com/t")
		Object.defineProperty(request, NODE_OUTBOUND, { value: true })
		const res = await app.fetch(request, {})
		const value = (res.headers as unknown as HoneyOutHeaders).toRecord()["server-timing"]
		expect([isHoneyResponse(res), String(value).startsWith("cdn;dur=1.5, total;dur=")]).toEqual([true, true])
	})
})

describe("serverTiming(): hostile names and descriptions", () => {
	// v0: bf78504632
	// v0: a98f788662
	// v0: 3f290bc4dc
	// v0: 97af567d59
	it("a name becomes a token (an empty one `_`), a description a quoted string: the header stays well-formed", async () => {
		const { entries, header } = await timings((timing) => {
			timing.start('a;b=c, "d"', 'say "hi" \\ and\nbreak')
			timing.end('a;b=c, "d"')
			timing.start("")
		})
		expect([entries[0]?.name, entries[0]?.desc, entries[1]?.name, /[\r\n]/.test(header)]).toEqual([
			"a_b_c___d_",
			'"say \\"hi\\" \\\\ and?break"',
			"_",
			false,
		])
	})
})

describe("serverTiming(): on an error answer", () => {
	// v0: f50d0fcf8c
	// v0: 8139ebe0c7
	it("a handler that throws still gets its timings on the 500", async () => {
		const { entries, status } = await timings((timing) => timing.start("db"), { throws: true })
		expect([status, entries.map((entry) => entry.name)]).toEqual([500, ["db", "total"]])
	})
})
