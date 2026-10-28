/**
 * One spawn bound, kept twice: core and gen each hold SPAWN_TIMEOUT in their own test support (gen never imports core,
 * nor core gen's src), at the paths honey/spawn-timeout names in its messages (SHARED). Each module is read as text,
 * not imported, and both must export the number core's tests use, so the twins cannot drift and the rule's paths
 * cannot point at a module that moved.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"
import { SHARED } from "../../lint/spawn-timeout.js"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const REPO = join(import.meta.dirname, "../../../..")

type Declarator = { id: { name?: string }; init?: { type: string; value?: unknown } | null }
type Statement = { declaration?: { declarations?: Declarator[] } | null; type: string }

/** The number `export const SPAWN_TIMEOUT = …` holds in the repo file at `path`, or undefined. */
function exported(path: string): unknown {
	const code = readFileSync(join(REPO, path), "utf8")
	const body = (parseSync(path, code).program as unknown as { body: Statement[] }).body
	for (const statement of body) {
		if (statement.type !== "ExportNamedDeclaration") continue
		for (const d of statement.declaration?.declarations ?? [])
			if (d.id.name === "SPAWN_TIMEOUT" && d.init?.type === "Literal") return d.init.value
	}
	return undefined
}

describe("SPAWN_TIMEOUT's twins", () => {
	it("are one number in core's and gen's own test support, at the paths the rule names", () => {
		expect({ core: exported(SHARED.core), gen: exported(SHARED.gen) }).toEqual({
			core: SPAWN_TIMEOUT,
			gen: SPAWN_TIMEOUT,
		})
	})
})
