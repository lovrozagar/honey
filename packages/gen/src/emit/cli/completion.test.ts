/**
 * Shell completion (bit 17 phase e, E1; cobra's generator, the runtime's enum flags): `__complete` offers the
 * commands, a group's commands with their summaries, a command's flags, and an enum flag's values; each of the four
 * shells' scripts parses in its own shell (bash -n, zsh -n, fish -n, PowerShell's parser), each checker proven to
 * reject a broken script; and CI installs the pinned shells by the very command the fixture names.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { type Shell, SHELLS, syntaxCheck, toolsInstall, withTools } from "./__fixtures__/tools.ts"
import { shop } from "./__fixtures__/shop.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const TOOLS_PRESENT = withTools()
const SLOW = { timeout: 600_000 }

const built = () => builtCli(generateGoCli(shop()).files)

/** `__complete`'s candidates for `args`: its lines before the directive line. */
async function candidates(args: readonly string[]): Promise<string[]> {
	const ran = await built().cli(["__complete", ...args], {})
	return ran.stdout.split("\n").filter((line) => line !== "" && !line.startsWith(":"))
}

/** A script no shell parses: an `if` never closed. */
const BROKEN: Record<Shell, string> = {
	bash: "if true; then\n",
	fish: "if true\n",
	powershell: "if ($true) {\n",
	zsh: "if true; then\n",
}

describe.skipIf(!GO)("dynamic completion (phase e)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	it("offers the commands, a group's commands with their summaries, a command's flags, and an enum's values", async () => {
		const [top, group, flags, values] = [
			await candidates(["it"]),
			await candidates(["items", ""]),
			await candidates(["items", "list", "--k"]),
			await candidates(["items", "list", "--kind", ""]),
		]
		expect({ flags, group, top, values }).toEqual({
			flags: ["--kind\t(one of cat, dog)"],
			group: ["create\tCreate an item", "delete", "get\tGet an item", "list\tList items", "search", "tags"],
			top: ["items"],
			values: ["cat", "dog"],
		})
	})
})

describe.skipIf(!GO || !TOOLS_PRESENT)("each shell's completion script (phase e)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	it.each(SHELLS)("writes a %s script its shell parses, the shell rejecting a broken one", async (shell) => {
		const dir = mkdtempSync(join(goCacheDir("tmp"), `completion-${shell}-`))
		const ran = await built().cli(["completion", shell], {})
		writeFileSync(join(dir, "shop"), ran.stdout)
		writeFileSync(join(dir, "broken"), BROKEN[shell])
		const [script, broken] = [syntaxCheck(shell, join(dir, "shop")), syntaxCheck(shell, join(dir, "broken"))]
		expect([ran.status, ran.stdout.length > 0, script, broken.status !== 0]).toEqual([
			0,
			true,
			{ errors: "", status: 0 },
			true,
		])
	})
})

describe("the pinned tools in CI (phase e)", () => {
	it("installs them in the test job by the command the fixture names, verbatim", () => {
		const workflow = readFileSync(resolve(import.meta.dirname, "../../../../../.github/workflows/ci.yml"), "utf8")
		const test = workflow.slice(workflow.indexOf("\n  test:\n"), workflow.indexOf("\n  gen-rust:\n"))
		expect(test.split("\n").some((line) => line.trim() === `run: ${toolsInstall()}`)).toBe(true)
	})
})
