/**
 * honey()'s memory of recent saves, through its real hotUpdate (bit 19 i): each save generates once, and once more
 * saves than SAVES_REMEMBERED have come, the oldest save's key generates again. The generation is a counting stub,
 * so the leg needs no app and no build; plugin.test.ts drives real generations (9d8e902099).
 */
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

const generations = vi.hoisted(() => ({ count: 0 }))
vi.mock("./generate.ts", async (actual) => ({
	...(await actual<typeof import("./generate.ts")>()),
	generateAndWrite: async () => {
		generations.count++
		return []
	},
}))

const { honey, SAVES_REMEMBERED } = await import("./plugin.ts")

describe("honey()'s recent saves (bit 19 i)", () => {
	it("generates once per save and again for a save it has forgotten", async () => {
		const [plugin] = honey({ app: "src/app.ts", watch: ["src/**/*.ts"] })
		plugin.configResolved({ root: "/project" })
		const save = (timestamp: number) =>
			plugin.hotUpdate({
				file: join("/project", "src/app.ts"),
				modules: [],
				server: { moduleGraph: { getModuleById: () => undefined } },
				timestamp,
			})
		for (let timestamp = 1; timestamp <= SAVES_REMEMBERED + 1; timestamp++) await save(timestamp)
		await save(SAVES_REMEMBERED + 1)
		expect(generations.count).toBe(SAVES_REMEMBERED + 1)
		await save(1)
		expect(generations.count).toBe(SAVES_REMEMBERED + 2)
	})
})
