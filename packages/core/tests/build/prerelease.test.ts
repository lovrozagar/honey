/**
 * A prerelease never takes npm's `latest` (bit 22, the 1.0.0-rc.1 release): release.yml's publish steps compute the
 * dist-tag from the tag's own version — `next` when it carries a prerelease, `latest` otherwise — and the GitHub
 * release is marked a prerelease to match. So while a candidate is out, `npm install @lovrozagar/honey` keeps giving
 * the last final release, and the releases page agrees with the registry.
 *
 * Each leg runs the step's real bash with `npm` and `gh` replaced by recorders on PATH, so what is proven is the
 * command the step would run, not a reading of the YAML.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { ROOT, type Step, stepsRunning, workflow } from "./fixture/workflows.ts"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const release = workflow("release.yml")
const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

/** A directory on PATH holding `name` as a recorder: it appends its arguments to `calls` and exits 0. */
function recorder(names: readonly string[]): { calls: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "honey-pre-"))
	dirs.push(dir)
	const calls = join(dir, "calls")
	for (const name of names) {
		const path = join(dir, name)
		/*
		 * Both lookups must fail, or the step takes its already-done branch and never runs the command under test:
		 * `npm view <pkg>@<v>` would read the version as published, and `gh release view <tag>` as released.
		 */
		const view = name === "npm" ? 'if [ "$1" = view ]; then exit 1; fi\n' : 'if [ "$2" = view ]; then exit 1; fi\n'
		writeFileSync(path, `#!/bin/sh\n${view}echo "${name} $*" >> ${calls}\nexit 0\n`)
		chmodSync(path, 0o755)
	}
	return { calls, dir }
}

/** `step`'s script run with `version` as the tag, every outward command recorded. */
function ran(step: Step | undefined, version: string) {
	const { calls, dir } = recorder(["npm", "gh"])
	const env = {
		GH_TOKEN: "x",
		GITHUB_REF_NAME: `v${version}`,
		GITHUB_REPOSITORY: "lovrozagar/honey",
		GITHUB_REF_TYPE: "tag",
		HOME: process.env.HOME ?? "",
		PATH: `${dir}:/usr/bin:/bin`,
		RUNNER_TEMP: dir,
		...step?.env,
	}
	const out = spawnSync("bash", ["-e", "-c", step?.run ?? "exit 99"], { encoding: "utf8", env, timeout: SPAWN_TIMEOUT })
	let recorded = ""
	try {
		recorded = readFileSync(calls, "utf8")
	} catch {
		/* a step that ran no outward command records nothing */
	}
	return { out: `${out.stdout}${out.stderr}`, recorded, status: out.status }
}

const publishes = stepsRunning(release, "npm publish")
const releasing = stepsRunning(release, "gh release create")

describe("release.yml publishes a candidate under next, a release under latest", () => {
	it("has a publish step per shipped package, and one GitHub release step", () => {
		expect(publishes).toHaveLength(2)
		expect(releasing).toHaveLength(1)
	})

	for (const step of publishes) {
		const pkg = step.env?.PACKAGE ?? "?"

		it(`${pkg}: a prerelease tag publishes --tag next`, { timeout: SPAWN_TIMEOUT }, () => {
			const result = ran(step, "1.0.0-rc.1")
			expect(result.status).toBe(0)
			expect(result.recorded).toContain("--tag next")
			expect(result.recorded).not.toContain("--tag latest")
			/* and still with provenance, as every publish here does */
			expect(result.recorded).toContain("--provenance")
		})

		it(`${pkg}: a final tag publishes --tag latest`, { timeout: SPAWN_TIMEOUT }, () => {
			const result = ran(step, "1.0.0")
			expect(result.status).toBe(0)
			expect(result.recorded).toContain("--tag latest")
			expect(result.recorded).not.toContain("--tag next")
		})
	}

	it("marks a prerelease on GitHub, and does not mark a release", { timeout: SPAWN_TIMEOUT }, () => {
		const candidate = ran(releasing[0], "1.0.0-rc.1")
		expect(candidate.status).toBe(0)
		expect(candidate.recorded).toContain("--prerelease")
		const final = ran(releasing[0], "1.0.0")
		expect(final.status).toBe(0)
		expect(final.recorded).not.toContain("--prerelease")
		/* both create the release for the tag they were given */
		expect(final.recorded).toContain("release create v1.0.0")
	})
})

/** A package's manifest, for the version and peer legs. */
const manifestOf = (dir: string) =>
	JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as {
		peerDependencies?: Record<string, string>
		version: string
	}

describe("the versions this repository ships", () => {
	it("are one version in both packages, and the peer range accepts a candidate", () => {
		const core = manifestOf("packages/core")
		const gen = manifestOf("packages/gen")
		expect(core.version).toBe(gen.version)
		/*
		 * `>=1.0.0` would exclude `1.0.0-rc.1`: under semver a prerelease satisfies a range only when the range
		 * itself carries a prerelease at the same version. `>=1.0.0-0` accepts every 1.0.0 candidate and everything
		 * after, so it needs no edit when rc.2 is cut (checked against the semver package before it was written).
		 */
		expect(core.peerDependencies?.["@lovrozagar/honey-clients"]).toBe(">=1.0.0-0")
	})
})
