/**
 * The bench finds bombardier, or says so (bit 22): `run.sh` takes `$BOMBARDIER` when it is set, else whatever is on
 * PATH, and there is no fallback path — the old default under `/tmp` died on every reboot, and the next person
 * rediscovered it. A binary that cannot run is no binary either: a mise shim with no version set is executable and
 * still fails, so the check runs `--version` rather than stat the file.
 *
 * Each leg runs the real script with bash, as release.yml's steps are run: a refusal is proven on the fail path, not
 * read off the source.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/* every spawning leg declares its own bound (00-rules): a bash run of one script, so a minute is already generous */
const SPAWN_TIMEOUT = 60_000

const RUN_SH = resolve(import.meta.dirname, "run.sh")
const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

/** A directory of its own, so a fake bombardier is only on the PATH the leg hands the script. */
function scratch(): string {
	const made = mkdtempSync(join(tmpdir(), "honey-bomb-"))
	dirs.push(made)
	return made
}

/**
 * `run.sh` run with a PATH of its own: `extra` goes in front of the system directories, which stay, because bash
 * itself lives there — a PATH that replaces them cannot start the script at all, which looks like a refusal and is
 * not one (it cost one red while this leg was written).
 */
function run({ extra = "", ...env }: { extra?: string; BOMBARDIER?: string }) {
	const ran = spawnSync("bash", [RUN_SH, "bun", "naked", "json"], {
		encoding: "utf8",
		env: { HOME: process.env.HOME ?? "", PATH: [extra, "/usr/bin:/bin"].filter(Boolean).join(":"), ...env },
		timeout: SPAWN_TIMEOUT,
	})
	return { out: `${ran.stdout}${ran.stderr}`, status: ran.status }
}

/** A fake bombardier in its own directory: `ok` answers --version, a broken one fails it as a stale shim does. */
function fake(ok: boolean): string {
	const where = scratch()
	const path = join(where, "bombardier")
	writeFileSync(
		path,
		ok ? "#!/bin/sh\necho 'bombardier version 1.2.6'\n" : "#!/bin/sh\necho 'no version set' >&2\nexit 1\n",
	)
	chmodSync(path, 0o755)
	return where
}

describe("run.sh finds bombardier or refuses (bit 22)", () => {
	it("refuses with nothing set and none on PATH, naming both ways to give it one", { timeout: SPAWN_TIMEOUT }, () => {
		const refused = run({ extra: scratch() })
		expect(refused.status).toBe(1)
		expect(refused.out).toContain("bombardier does not run: set BOMBARDIER to its path, or put one on PATH")
		expect(refused.out).toContain('(tried "none")')
	})

	it("refuses a path that is set but does not run, naming it", { timeout: SPAWN_TIMEOUT }, () => {
		const broken = join(fake(false), "bombardier")
		const refused = run({ BOMBARDIER: broken, extra: scratch() })
		expect(refused.status).toBe(1)
		expect(refused.out).toContain(`(tried "${broken}")`)
	})

	it(
		"refuses a broken one found on PATH, so a stale shim is not taken for a binary",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const refused = run({ extra: fake(false) })
			expect(refused.status).toBe(1)
			expect(refused.out).toContain("bombardier does not run")
		},
	)

	/*
	 * Past the check the script needs the built matrix, which this leg does not build, so it fails later and
	 * differently. What is proven here is only that the bombardier check let it through.
	 */
	it("gets past the check with a working one on PATH alone", { timeout: SPAWN_TIMEOUT }, () => {
		const went = run({ extra: fake(true) })
		expect(went.out).not.toContain("bombardier does not run")
	})
})
