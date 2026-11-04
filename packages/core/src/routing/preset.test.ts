/**
 * A preset (plan 39 7.1): the settings and chain middleware an app starts from, written once with the app's own
 * setters. `honey(preset)` is the app the same chain on `honey()` builds, types included, and each app it starts owns
 * its copy: a setter on one app, or on the preset later, changes no other.
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { defineErrors } from "../errors/errors.ts"
import { createErrorTranslator } from "../i18n/error-i18n.ts"
import { requestId } from "../middleware/request-id.ts"
import { generateOpenApi } from "../openapi/generate.ts"
import { createLogger } from "../telemetry/logger.ts"
import { honey } from "./app.ts"
import { definePreset } from "./preset.ts"

type Env = { readonly REGION: string }
type RouteMeta = { team?: string; worker?: "saas" | "extract" }

const errors = defineErrors({ internal_server_error: "internal_server_error", item_gone: "gone" })
const translator = createErrorTranslator({
	errors: { en: { internal_server_error: "Something broke", item_gone: "Gone" } },
	resolveLocale: () => "en",
})
const formatter = (_error: unknown, shape: Record<string, unknown>) => ({ ...shape, envelope: 1 })

/** A json logger whose lines, without their time, land in `lines`. */
function recording() {
	const lines: Record<string, unknown>[] = []
	const write = (line: string) => {
		const { time: _time, ...rest } = JSON.parse(line) as Record<string, unknown>
		lines.push(rest)
	}
	return { lines, logger: createLogger({ format: "json", level: "info", write }) }
}

/** The settings both apps share, as a preset. */
const presetFor = (logger: ReturnType<typeof createLogger>) =>
	definePreset<Env>()
		.metaType<RouteMeta>()
		.metaSpec({ meta: { team: "x-team", worker: "x-worker" } })
		.logger(logger)
		.errorFactory(errors)
		.errorI18n(translator)
		.defaultErrorFormatter(formatter)
		.defaultBoundary("internal_server_error")
		.requestLog(true)
		.use(requestId({ generate: () => "req-1" }))

/** The same settings chained on `honey()` by hand. */
const chainedFor = (logger: ReturnType<typeof createLogger>) =>
	honey<Env>()
		.metaType<RouteMeta>()
		.metaSpec({ meta: { team: "x-team", worker: "x-worker" } })
		.logger(logger)
		.errorFactory(errors)
		.errorI18n(translator)
		.defaultErrorFormatter(formatter)
		.defaultBoundary("internal_server_error")
		.requestLog(true)
		.use(requestId({ generate: () => "req-1" }))

/** `app` with its routes: one that answers its request id, one that throws something undeclared. */
function served<A extends ReturnType<typeof chainedFor>>(app: A) {
	const scoped = app.meta({ team: "core", worker: "saas" })
	scoped.get("/id").handler((ctx) => ctx.res.json("ok", { id: ctx.requestId, worker: ctx.meta.worker }))
	scoped.get("/boom").handler(() => {
		throw new Error("db down")
	})
	return scoped
}

/** What `app` answers and logs, and the document it generates. */
async function observed(app: ReturnType<typeof served>, lines: Record<string, unknown>[]) {
	const id = await app.fetch(new Request("http://localhost/id"), { REGION: "eu" })
	const boom = await app.fetch(new Request("http://localhost/boom"), { REGION: "eu" })
	await new Promise((resolve) => setTimeout(resolve, 0))
	const { digest: _digest, ...boomBody } = (await boom.json()) as Record<string, unknown>
	return {
		boom: [boom.status, boom.headers.get("x-request-id"), boomBody],
		document: generateOpenApi(app, { info: { title: "T", version: "1" } }),
		id: [id.status, await id.json()],
		lines: lines.map(({ digest: _d, durationMs: _ms, ...line }) => line),
	}
}

describe("honey(preset)", () => {
	it("is the app the same chain on honey() builds: answers, log lines, document and types", async () => {
		const fromPreset = recording()
		const byHand = recording()
		const presetApp = served(honey(presetFor(fromPreset.logger)))
		const handApp = served(chainedFor(byHand.logger))
		expectTypeOf(honey(presetFor(fromPreset.logger))).toEqualTypeOf(chainedFor(byHand.logger))
		const [a, b] = [await observed(presetApp, fromPreset.lines), await observed(handApp, byHand.lines)]
		expect(a).toEqual(b)
		expect([a.id, a.boom[0], a.boom[1], (a.boom[2] as { message?: string }).message, a.lines.length]).toEqual([
			[200, { id: "req-1", worker: "saas" }],
			500,
			"req-1",
			"Something broke",
			3,
		])
	})

	it("starts an app that owns its settings: a setter on one app, or on the preset after, changes no other", async () => {
		const preset = definePreset<{}>().errorFactory(errors).logger(false)
		const [first, second] = [honey(preset), honey(preset)]
		first.errorFormat("problem+json")
		preset.errorFormat("problem+json")
		for (const app of [first, second])
			app
				.get("/gone")
				.errors("item_gone")
				.handler(() => {
					throw errors.item_gone()
				})
		const [one, two, third] = [
			await first.fetch(new Request("http://localhost/gone"), {}),
			await second.fetch(new Request("http://localhost/gone"), {}),
			await honey(preset)
				.get("/x")
				.handler((ctx) => ctx.res.text("ok", "x"))
				.fetch(new Request("http://localhost/y"), {}),
		]
		expect([
			one.headers.get("content-type"),
			two.headers.get("content-type"),
			third.headers.get("content-type"),
		]).toEqual(["application/problem+json", "application/json", "application/problem+json"])
	})
})
