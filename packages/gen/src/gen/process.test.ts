/**
 * The generate CLI's child process (bit 17 phase h): cliInvocation starts the package's own bin on this runtime, and
 * runCli resolves when that child exits 0 and rejects naming how it ended otherwise, no child left once it has.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { shop } from "../emit/cli/__fixtures__/shop.ts"
import { MARK_KEY, markOf, marked, reap } from "./__fixtures__/survivors.ts"
import { cliInvocation, endOf, runCli } from "./process.ts"

const MARK = markOf()

describe("the generate CLI's child (phase h)", () => {
	it("starts the package's own bin on this runtime", () => {
		const [command, bin] = cliInvocation()
		expect([command, bin.endsWith("/packages/gen/bin/honey-clients.js"), existsSync(bin)]).toEqual([
			process.execPath,
			true,
			true,
		])
	})

	it("names how a child ended: its signal, else its exit code", () => {
		expect([endOf(null, "SIGTERM"), endOf(2, null)]).toEqual(["SIGTERM", "exit 2"])
	})

	it("marks its child a generation child, over any env, so the child refuses --watch", async () => {
		/* a spec it would generate from: its only way to exit 1 is the refusal */
		const dir = mkdtempSync(join(tmpdir(), "codegen-child-"))
		writeFileSync(join(dir, "spec.json"), JSON.stringify(shop()))
		const argv = ["generate", "--spec", "spec.json", "--target", "ts", "--out", "out", "--watch"]
		await expect(runCli(argv, { cwd: dir, env: { [MARK_KEY]: MARK, HONEY_CODEGEN_CHILD: "0" } })).rejects.toThrow(
			"honey-clients generate failed (exit 1)",
		)
		expect([marked(MARK), existsSync(join(dir, "out"))]).toEqual([[], false])
	}, 30_000)

	it("resolves on exit 0 and rejects with the exit code otherwise", async () => {
		const env = { [MARK_KEY]: MARK }
		await expect(runCli(["--help"], { cwd: tmpdir(), env: { NO_COLOR: "1", ...env } })).resolves.toBeUndefined()
		await expect(runCli(["generate", "--nope"], { cwd: tmpdir(), env })).rejects.toThrow(
			"honey-clients generate failed (exit 1)",
		)
		await expect(runCli([], { cwd: tmpdir(), env })).rejects.toThrow("honey-clients  failed (exit 1)")
		expect(marked(MARK)).toEqual([])
	}, 60_000)
})

describe("no process left behind (phase h)", () => {
	it("leaves no child of this file running: any that outlived its leg is killed and named", () => {
		expect(reap(MARK)).toEqual([])
	})
})
