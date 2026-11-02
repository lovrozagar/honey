/**
 * The release's provenance (bit 19 i, R7, Q13), read from .github/workflows/release.yml: the workflow reads by default,
 * the npm publish job alone mints an OIDC token, the GitHub release job alone writes; exactly the two packages that
 * ship are published, each with `--provenance` after its tag check; nothing goes to GitHub Packages; publishing waits
 * on main's ci.yml push run green on the tagged commit; every action is pinned by commit and no checkout keeps
 * credentials.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { jobsRunning, ROOT, type Step, stepsRunning, upstream, workflow } from "./fixture/workflows.ts"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const release = workflow("release.yml")
const RELEASE_TEXT = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")

/** the two packages that ship (bits/19:7), by the directory each is packed from */
const SHIPPED = Object.fromEntries(
	["packages/core", "packages/gen"].map((dir) => {
		const { name } = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { name: string }
		return [name, dir]
	}),
)
const COMMIT = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/
/** any registry publish command, whatever the client */
const PUBLISH = /\b(?:npm|bun|pnpm|yarn(?: npm)?) publish\b/

const permissions = (id: string) => release.jobs[id]?.permissions ?? {}
const jobsGranting = (scope: string, level: string) =>
	Object.keys(release.jobs).filter((id) => permissions(id)[scope] === level)
const allSteps = (): readonly (Step & { readonly job: string })[] =>
	Object.entries(release.jobs).flatMap(([job, { steps = [] }]) => steps.map((step) => ({ ...step, job })))

describe("release.yml: privilege", () => {
	it("grants the workflow contents: read alone", () => {
		expect(release.permissions).toEqual({ contents: "read" })
	})

	it("mints an OIDC token on the npm publish job alone", () => {
		const publishing = jobsRunning(release, "npm publish")
		expect(publishing).toHaveLength(1)
		expect(Object.keys(release.jobs).filter((id) => "id-token" in permissions(id))).toEqual(publishing)
		expect(permissions(publishing[0] as string)).toEqual({ "id-token": "write" })
	})

	it("writes contents on the GitHub release job alone", () => {
		const releasing = jobsRunning(release, "gh release create")
		expect(releasing).toHaveLength(1)
		expect(jobsGranting("contents", "write")).toEqual(releasing)
		expect(permissions(releasing[0] as string)).toEqual({ contents: "write" })
	})

	it("pins every action by commit and keeps no credentials on a checkout", () => {
		const uses = allSteps().flatMap((step) => (step.uses === undefined ? [] : [step.uses]))
		expect(uses.length).toBeGreaterThan(0)
		expect(uses.filter((ref) => !COMMIT.test(ref))).toEqual([])
		/* a job-level `uses` is a reusable workflow: this repo's own, at the same commit */
		const reusable = Object.values(release.jobs).flatMap((job) => (job.uses === undefined ? [] : [job.uses]))
		expect(reusable.filter((ref) => !ref.startsWith("./.github/workflows/") && !COMMIT.test(ref))).toEqual([])
		const checkouts = allSteps().filter((step) => step.uses?.startsWith("actions/checkout@"))
		expect(checkouts.map((step) => step.with?.["persist-credentials"])).toEqual(checkouts.map(() => false))
	})

	it("calls no reusable workflow: ci.yml runs once per commit, on main's push", () => {
		expect(Object.entries(release.jobs).filter(([, job]) => job.uses !== undefined)).toEqual([])
	})
})

describe("release.yml: what is published", () => {
	const publishes = allSteps().filter((step) => PUBLISH.test(step.run ?? ""))

	it("publishes exactly the two packages that ship, each to npm with --provenance", () => {
		expect(publishes.map((step) => step.env?.PACKAGE).sort()).toEqual(Object.keys(SHIPPED).sort())
		for (const step of publishes) {
			expect(step.run, step.name).toMatch(/\bnpm publish "\$RUNNER_TEMP\/tarballs\/\$TARBALL-\$v\.tgz" /)
			expect(step.run, step.name).toMatch(/ --provenance\b/)
			expect(step.run, step.name).toMatch(/ --access public\b/)
			/* the tarball npm pack names for the package: `@scope/name` → `scope-name-<version>.tgz` */
			expect(step.env?.TARBALL, step.name).toBe(step.env?.PACKAGE?.replace(/^@/, "").replace("/", "-"))
		}
	})

	it("publishes nothing to GitHub Packages", () => {
		expect(jobsGranting("packages", "write")).toEqual([])
		expect(Object.keys(release.jobs).filter((id) => "packages" in permissions(id))).toEqual([])
		expect(RELEASE_TEXT).not.toContain("npm.pkg.github.com")
		const registries = allSteps().flatMap((step) => {
			const url = step.with?.["registry-url"]
			return url === undefined ? [] : [url]
		})
		expect(registries.filter((url) => url !== "https://registry.npmjs.org")).toEqual([])
	})

	it("packs each package from its directory after checking it against the tag", { timeout: SPAWN_TIMEOUT }, () => {
		const packs = stepsRunning(release, "scripts/pack.ts")
		for (const [name, dir] of Object.entries(SHIPPED)) {
			const steps = allSteps()
			const check = steps.findIndex((step) => step.env?.PACKAGE === name && step["working-directory"] === dir)
			const pack = steps.findIndex((step) => step.run?.includes("scripts/pack.ts") && step["working-directory"] === dir)
			expect(check, `${name}'s tag check`).toBeGreaterThanOrEqual(0)
			expect(pack, `${name}'s pack`).toBeGreaterThan(check)
			expect(steps[check]?.job, `${name}'s check and pack share a job`).toBe(steps[pack]?.job)
		}
		expect(packs).toHaveLength(Object.keys(SHIPPED).length)
	})
})

describe("release.yml: each package's tag check, run", () => {
	const dirs: string[] = []
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
	})

	/** The check step for `name` run by bash in a directory holding `manifest`, on ref `refName` of type `refType`. */
	function check(name: string, manifest: object, refType: string, refName: string) {
		const step = allSteps().find((s) => s.env?.PACKAGE === name && s["working-directory"] === SHIPPED[name])
		const dir = mkdtempSync(join(tmpdir(), "honey-release-check-"))
		dirs.push(dir)
		writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
		const env = { ...process.env, ...step?.env, GITHUB_REF_NAME: refName, GITHUB_REF_TYPE: refType }
		const ran = spawnSync("bash", ["-e", "-c", step?.run ?? "exit 99"], { cwd: dir, encoding: "utf8", env })
		return { out: `${ran.stdout}${ran.stderr}`, status: ran.status }
	}

	for (const name of Object.keys(SHIPPED)) {
		it(
			`${name}: passes at the tag's version, refuses another version, another name or a branch`,
			{ timeout: SPAWN_TIMEOUT },
			() => {
				expect(check(name, { name, version: "1.2.3" }, "tag", "v1.2.3")).toEqual({ out: "", status: 0 })
				const older = check(name, { name, version: "1.2.2" }, "tag", "v1.2.3")
				expect(older.status).toBe(1)
				expect(older.out).toContain(`${name}@1.2.2`)
				expect(check(name, { name: `${name}-other`, version: "1.2.3" }, "tag", "v1.2.3").status).toBe(1)
				expect(check(name, { name, version: "1.2.3" }, "branch", "main").status).toBe(1)
			},
		)
	}
})

const WAIT = "--workflow ci.yml"
/** the job that waits on main's ci.yml run, and its one step */
const waiter = jobsRunning(release, WAIT)[0] as string
const waitStep = stepsRunning(release, WAIT)[0]

/** a ci.yml run as `gh run list --json status,conclusion,url` lists it */
const run = (status: string, conclusion: string, id: number) => ({
	conclusion,
	status,
	url: `https://github.com/owner/repo/actions/runs/${id}`,
})

describe("release.yml: publishing waits on main's ci.yml run green on the tagged commit", () => {
	const dirs: string[] = []
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
	})

	/** The wait step run by bash with a `gh` that answers `runs` and records its arguments. */
	function wait(runs: readonly object[], grace = "600") {
		const dir = mkdtempSync(join(tmpdir(), "honey-release-wait-"))
		dirs.push(dir)
		mkdirSync(join(dir, "bin"))
		writeFileSync(join(dir, "runs.json"), JSON.stringify(runs))
		const gh = join(dir, "bin", "gh")
		writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${dir}/runs.json"\n`)
		chmodSync(gh, 0o755)
		const env = {
			...process.env,
			...waitStep?.env,
			GITHUB_REF_NAME: "v1.2.3",
			GITHUB_REPOSITORY: "owner/repo",
			GITHUB_SHA: "abc123",
			GRACE_SECONDS: grace,
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
		}
		const ran = spawnSync("bash", ["-e", "-c", waitStep?.run ?? "exit 99"], { cwd: dir, encoding: "utf8", env })
		const args = readFileSync(join(dir, "args"), "utf8").trim().split("\n")
		return { args, out: `${ran.stdout}${ran.stderr}`, status: ran.status }
	}

	it("waits in one read-only job upstream of every publish and of the GitHub release", () => {
		expect(jobsRunning(release, WAIT)).toHaveLength(1)
		expect(permissions(waiter)).toEqual({ actions: "read" })
		for (const id of [...jobsRunning(release, "npm publish"), ...jobsRunning(release, "gh release create")])
			expect([...upstream(release, id)], id).toContain(waiter)
		expect(workflow("ci.yml").on.push).toEqual({ branches: ["main"] })
	})

	it(
		"passes on main's green push run for the tagged commit, asking for no other run",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const { args, out, status } = wait([run("completed", "failure", 1), run("completed", "success", 2)])
			expect({ out: out.trim(), status }).toEqual({
				out: "ci.yml passed on main at abc123: https://github.com/owner/repo/actions/runs/2",
				status: 0,
			})
			const flag = (name: string) => args[args.indexOf(name) + 1]
			expect(["--repo", "--workflow", "--branch", "--event", "--commit"].map(flag)).toEqual([
				"owner/repo",
				"ci.yml",
				"main",
				"push",
				"abc123",
			])
		},
	)

	it("fails on a red or cancelled run, naming it and the release's re-run", { timeout: SPAWN_TIMEOUT }, () => {
		const { out, status } = wait([run("completed", "cancelled", 3)])
		expect(status).toBe(1)
		expect(out).toContain("https://github.com/owner/repo/actions/runs/3")
		expect(out).toContain("gh workflow run release.yml --ref v1.2.3")
	})

	it("fails a commit main never ran once the grace is up", { timeout: SPAWN_TIMEOUT }, () => {
		const { out, status } = wait([], "0")
		expect(status).toBe(1)
		expect(out).toContain("push the commit to main before its tag")
	})

	it("runs no job past a skipped or failed one, and waits on the commit it publishes", () => {
		/* a job-level `if` (always(), !cancelled(), failure()) is how a job runs past a red need */
		expect(Object.entries(release.jobs).filter(([, job]) => job.if !== undefined || job["continue-on-error"])).toEqual(
			[],
		)
		/* a dispatch input naming another tag would wait on this ref's run and publish that one */
		expect(release.on.workflow_dispatch ?? null).toBeNull()
		expect(Object.keys(release.on).sort()).toEqual(["push", "workflow_dispatch"])
		expect(release.on.push).toEqual({ tags: ["v*"] })
	})
})
