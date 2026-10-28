/**
 * The release's provenance (bit 19 i, R7, Q13), read from .github/workflows/release.yml: the workflow reads by default,
 * the npm publish job alone mints an OIDC token, the GitHub release job alone writes; exactly the two packages that
 * ship are published, each with `--provenance` after its tag check; nothing goes to GitHub Packages; publishing waits
 * on ci.yml green on the tagged commit; every action is pinned by commit and no checkout keeps credentials.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { caller, jobsRunning, ROOT, type Step, stepsRunning, upstream, workflow } from "./fixture/workflows.ts"
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

	it("pins every action by commit in each workflow it calls (ci.yml runs inside the release)", () => {
		const called = Object.values(release.jobs).flatMap((job) =>
			job.uses?.startsWith("./.github/workflows/") ? [job.uses.slice("./.github/workflows/".length)] : [],
		)
		expect(called).toEqual(["ci.yml"])
		for (const name of called) {
			const uses = Object.values(workflow(name).jobs).flatMap(({ steps = [] }) =>
				steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
			)
			expect(uses.length, name).toBeGreaterThan(0)
			expect(
				uses.filter((ref) => !COMMIT.test(ref)),
				name,
			).toEqual([])
		}
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

/**
 * Whether a job `if` runs under `github`: ci.yml's forms only (`==`, `&&`, `||`, parentheses, startsWith over
 * github.event_name and github.ref, quoted strings); anything else throws, so a new form is never judged unread.
 */
function runsUnder(condition: string | undefined, github: { event_name: string; ref: string }): boolean {
	if (condition === undefined) return true
	const js = condition
		.replace(/github\.(event_name|ref)\b/g, (_, key: "event_name" | "ref") => JSON.stringify(github[key]))
		.replace(/startsWith\(/g, "starts(")
		.replace(/'([^']*)'/g, (_, text: string) => JSON.stringify(text))
		.replace(/==/g, "===")
	if (!/^(?:\s|"[^"]*"|===|&&|\|\||[(),]|starts)*$/.test(js)) throw new Error(`unread job condition: ${condition}`)
	return new Function("starts", `return ${js}`)((text: string, prefix: string) => text.startsWith(prefix)) as boolean
}

describe("release.yml: publishing waits on ci.yml green on the tagged commit", () => {
	const ci = caller(release, "./.github/workflows/ci.yml")

	it("calls ci.yml, which accepts the call, upstream of every publish and of the GitHub release", () => {
		expect(ci).toBeDefined()
		expect(Object.keys(workflow("ci.yml").on)).toContain("workflow_call")
		for (const id of [...jobsRunning(release, "npm publish"), ...jobsRunning(release, "gh release create")])
			expect([...upstream(release, id)], id).toContain(ci)
	})

	it("runs no job past a skipped or failed one, and tests the commit it publishes", () => {
		/* a job-level `if` (always(), !cancelled(), failure()) is how a job runs past a red need */
		expect(Object.entries(release.jobs).filter(([, job]) => job.if !== undefined || job["continue-on-error"])).toEqual(
			[],
		)
		/* a dispatch input naming another tag would test this ref and publish that one */
		expect(release.on.workflow_dispatch ?? null).toBeNull()
		expect(Object.keys(release.on).sort()).toEqual(["push", "workflow_dispatch"])
		expect(release.on.push).toEqual({ tags: ["v*"] })
		/* ci.yml runs on the caller's commit with the caller's read-only token: no inputs, no secrets */
		expect(Object.keys(release.jobs[ci as string] ?? {}).filter((key) => key === "with" || key === "secrets")).toEqual(
			[],
		)
	})

	it("runs no ci.yml job that reads a secret on a tag's call: a release never waits on one", () => {
		/* a called workflow sees its caller's context: release.yml's tag push */
		const tag = { event_name: "push", ref: "refs/tags/v1.0.0" }
		const running = Object.entries(workflow("ci.yml").jobs).filter(([, job]) => runsUnder(job.if, tag))
		expect(running.filter(([, job]) => JSON.stringify(job).includes("secrets.")).map(([id]) => id)).toEqual([])
		/* the evaluator itself: main's push and a pull request each answered */
		expect([
			runsUnder("github.event_name == 'push' && github.ref == 'refs/heads/main'", {
				event_name: "push",
				ref: "refs/heads/main",
			}),
			runsUnder("github.event_name == 'pull_request'", tag),
		]).toEqual([true, false])
	})
})
