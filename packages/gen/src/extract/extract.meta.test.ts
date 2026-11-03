/**
 * What `extractTypes` reads of the app's declared meta (bit 22 a): the type `metaType<AppMeta>()` declares, written
 * out for the generated ctx, `null` when the app declares none, and nothing at all for an app from an older honey
 * that carries no `$meta`. Split from extract.test.ts at its 500-line cap, as tap-delivery is from tap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { extract, type FixtureProject, fixtureProject, lines, SLOW } from "./__fixtures__/project.ts"

let project: FixtureProject
beforeAll(() => {
	project = fixtureProject()
})
afterAll(() => project.dispose())

describe("the base: the meta type the app declares (bit 22 a)", () => {
	it(
		"writes the declared meta out, and leaves it null when the app declares none",
		() => {
			const declared = project.write(
				"meta/declared.ts",
				lines(
					'import { honey } from "@lovrozagar/honey"',
					'type AppMeta = { tenant?: "organization" | "project"; worker: "extract" }',
					'export const app = honey<{}>().metaType<AppMeta>().meta({ worker: "extract" })',
					'app.get("/tables").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			const none = project.write(
				"meta/none.ts",
				lines(
					'import { honey } from "@lovrozagar/honey"',
					"export const app = honey<{}>()",
					'app.get("/tables").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			expect(extract(declared).types.meta).toBe('{ tenant?: "organization" | "project"; worker: "extract" }')
			expect(extract(none).types.meta).toBeNull()
		},
		SLOW,
	)

	it(
		"reads a type-only metaType declaration, and names what an export that is no app lacks",
		() => {
			const typeOnly = project.write(
				"meta/type-only.ts",
				lines(
					'import { honey } from "@lovrozagar/honey"',
					'type AppMeta = { tenant?: "organization" | "project"; worker: "extract" }',
					"export const app = honey<{}>().metaType<AppMeta>()",
					'app.get("/tables").meta({ worker: "extract" }).handler((c) => c.res.text("ok", "ok"))',
				),
			)
			const notAnApp = project.write("meta/not-an-app.ts", lines("export const app = { get: 1 }"))
			expect(extract(typeOnly).types.meta).toBe('{ tenant?: "organization" | "project"; worker: "extract" }')
			expect(() => extract(notAnApp)).toThrow('Export "app" is not a honey app: it carries no $ctx, $env, $taps')
		},
		SLOW,
	)
})

describe("an app from an older honey", () => {
	it(
		"extracts with no declared meta at all, where the app carries no $meta",
		() => {
			/* the three members extraction needs, and no $meta: what a pre-1.0 honey's app type had */
			const older = project.write(
				"meta/older.ts",
				lines(
					'import type { HoneyContext } from "@lovrozagar/honey"',
					"type OlderApp = {",
					"\treadonly $ctx: HoneyContext<{ DB: string }>",
					"\treadonly $env: { DB: string }",
					"\treadonly $taps: {}",
					"}",
					"export const app = {} as OlderApp",
				),
			)
			expect(extract(older).types.meta).toBeNull()
		},
		SLOW,
	)
})
